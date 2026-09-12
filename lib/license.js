import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";
import { getFirebaseServerFirestore } from "./auth.js";

export const ADMIN_EMAIL = "awoyinfasolomon1@gmail.com";

// Local persistent file fallback (ensures durability on disk if Firestore REST is unreachable)
const LICENSES_FILE = path.join(DATA_DIR, "data", "solvatech-licenses.json");
const USER_LICENSES_FILE = path.join(DATA_DIR, "data", "solvatech-user-licenses.json");

// In-memory cache & write locks to prevent race conditions during redemptions
let inMemoryLicenses = null;
let inMemoryUserLicenses = null;
let licenseOperationQueue = Promise.resolve();

/**
 * Generates an unguessable, cryptographically random license code.
 * Format: SOLVA-XXXX-XXXX-XXXX (Base32 alphabet excluding easily confusable chars)
 */
export function generateCryptographicCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segment = (len) => {
    const bytes = crypto.randomBytes(len);
    let str = "";
    for (let i = 0; i < len; i++) {
      str += alphabet[bytes[i] % alphabet.length];
    }
    return str;
  };
  return `SOLVA-${segment(4)}-${segment(4)}-${segment(4)}`;
}

/**
 * Synchronizes queue execution to guarantee atomic operations
 */
function withAtomicLock(fn) {
  const next = licenseOperationQueue.then(() => fn()).catch((err) => {
    logger.error("License atomic operation error", err.stack || err.message);
    throw err;
  });
  licenseOperationQueue = next.then(() => {}).catch(() => {});
  return next;
}

/**
 * Reads data from local JSON fallback
 */
async function loadLocalStore() {
  if (!inMemoryLicenses) {
    try {
      if (fsSync.existsSync(LICENSES_FILE)) {
        const raw = await fs.readFile(LICENSES_FILE, "utf8");
        inMemoryLicenses = JSON.parse(raw);
      } else {
        inMemoryLicenses = {};
      }
    } catch {
      inMemoryLicenses = {};
    }
  }

  if (!inMemoryUserLicenses) {
    try {
      if (fsSync.existsSync(USER_LICENSES_FILE)) {
        const raw = await fs.readFile(USER_LICENSES_FILE, "utf8");
        inMemoryUserLicenses = JSON.parse(raw);
      } else {
        inMemoryUserLicenses = {};
      }
    } catch {
      inMemoryUserLicenses = {};
    }
  }
}

/**
 * Persists local cache to disk
 */
async function persistLocalStore() {
  try {
    await fs.mkdir(path.dirname(LICENSES_FILE), { recursive: true });
    await fs.writeFile(LICENSES_FILE, JSON.stringify(inMemoryLicenses || {}, null, 2));
    await fs.writeFile(USER_LICENSES_FILE, JSON.stringify(inMemoryUserLicenses || {}, null, 2));
  } catch (err) {
    logger.error("Failed to persist local license store", err.message);
  }
}

/**
 * Formats a duration in milliseconds into a readable human string
 * e.g., "3 Days 6 Hours 20 Minutes left"
 */
export function formatRemainingTime(ms) {
  if (ms <= 0) return "Expired";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days} Day${days === 1 ? "" : "s"}`);
  if (hours > 0 || days > 0) parts.push(`${hours} Hour${hours === 1 ? "" : "s"}`);
  parts.push(`${minutes} Minute${minutes === 1 ? "" : "s"} left`);

  return parts.join(" ");
}

/**
 * Admin: Generates a new license record
 */
export async function createLicenseRecord(durationDays, createdByEmail) {
  const days = parseInt(durationDays, 10);
  if (isNaN(days) || days <= 0 || days > 365) {
    throw new Error("Invalid duration. Duration must be between 1 and 365 days.");
  }

  return withAtomicLock(async () => {
    await loadLocalStore();

    const code = generateCryptographicCode();
    const nowIso = new Date().toISOString();

    const licenseData = {
      code,
      durationDays: days,
      createdAt: nowIso,
      createdBy: createdByEmail || ADMIN_EMAIL,
      status: "unused", // 'unused' | 'used'
      redeemedByUid: null,
      redeemedByEmail: null,
      redeemedAt: null,
      expiresAt: null,
    };

    // Try storing in Firestore first if initialized
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "licenses", code), licenseData);
      } catch (err) {
        logger.warn("Could not save license to Firestore, stored in local database", err.message);
      }
    }

    inMemoryLicenses[code] = licenseData;
    await persistLocalStore();

    return licenseData;
  });
}

/**
 * Admin: Lists all licenses (newest first)
 */
export async function listAllLicenses() {
  await loadLocalStore();
  
  // Two-way sync with Firestore
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { collection, getDocs, doc, setDoc } = await import("firebase/firestore");
      const snap = await getDocs(collection(db, "licenses"));
      const firestoreCodes = new Set();
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (data && data.code) {
          firestoreCodes.add(data.code);
          inMemoryLicenses[data.code] = { 
            ...(inMemoryLicenses[data.code] || {}), 
            ...data 
          };
        }
      });

      // Self-healing: push any local-only licenses up to Firestore
      for (const [code, licenseData] of Object.entries(inMemoryLicenses || {})) {
        if (!firestoreCodes.has(code)) {
          try {
            await setDoc(doc(db, "licenses", code), licenseData);
          } catch (syncErr) {
            logger.debug("Could not push local license to Firestore during sync", syncErr.message);
          }
        }
      }

      await persistLocalStore();
    } catch (err) {
      logger.warn("Firestore licenses read/sync notice", err.message);
    }
  }

  return Object.values(inMemoryLicenses || {}).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

/**
 * Atomically redeems a license code for a verified Firebase user.
 * 
 * Guarantees:
 * - Reject invalid codes
 * - Reject already-used codes
 * - Atomic execution: exactly ONE concurrent request succeeds
 * - Never allows used code to become unused
 * - Calculates expiry server-side
 * - Extends existing active license duration if user already has one, or starts from now
 */
export async function redeemLicenseCode(rawCode, verifiedUser) {
  if (!rawCode || typeof rawCode !== "string") {
    throw new Error("License code is required.");
  }
  if (!verifiedUser || !verifiedUser.uid) {
    throw new Error("Valid authenticated user required.");
  }

  const cleanCode = rawCode.trim().toUpperCase();
  const uid = verifiedUser.uid;
  const email = verifiedUser.email || "";

  return withAtomicLock(async () => {
    await loadLocalStore();

    let license = inMemoryLicenses[cleanCode];

    // Check Firestore for authoritative record if not found locally or to sync
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const docSnap = await getDoc(doc(db, "licenses", cleanCode));
        if (docSnap.exists()) {
          license = docSnap.data();
          inMemoryLicenses[cleanCode] = license;
        }
      } catch (err) {
        logger.debug("Firestore getDoc error", err.message);
      }
    }

    if (!license) {
      const err = new Error("Invalid license code. Please check the characters and try again.");
      err.code = "LICENSE_NOT_FOUND";
      throw err;
    }

    if (license.status === "used" || license.redeemedByUid) {
      const err = new Error("This license code has already been redeemed and cannot be used again.");
      err.code = "LICENSE_ALREADY_USED";
      throw err;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const durationDays = Number(license.durationDays) || 1;
    const durationMs = durationDays * 24 * 60 * 60 * 1000;

    // Check user's current license to handle extensions cleanly
    let existingUserLicense = inMemoryUserLicenses[uid];
    if (db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const uSnap = await getDoc(doc(db, "user_licenses", uid));
        if (uSnap.exists()) {
          existingUserLicense = uSnap.data();
          inMemoryUserLicenses[uid] = existingUserLicense;
        }
      } catch (err) {
        logger.debug("Firestore user license check notice", err.message);
      }
    }

    let startTimestamp = now.getTime();
    if (existingUserLicense && existingUserLicense.expiresAt) {
      const currentExpiry = new Date(existingUserLicense.expiresAt).getTime();
      if (currentExpiry > startTimestamp) {
        // Extend existing valid license
        startTimestamp = currentExpiry;
      }
    }

    const expiryDate = new Date(startTimestamp + durationMs);
    const expiryIso = expiryDate.toISOString();

    // Update license record permanently
    license.status = "used";
    license.redeemedByUid = uid;
    license.redeemedByEmail = email;
    license.redeemedAt = nowIso;
    license.expiresAt = expiryIso;

    // Update user active license record
    const userLicenseRecord = {
      uid,
      email,
      lastLicenseCode: cleanCode,
      durationDays,
      redeemedAt: nowIso,
      expiresAt: expiryIso,
      status: "active",
    };

    inMemoryLicenses[cleanCode] = license;
    inMemoryUserLicenses[uid] = userLicenseRecord;

    // Sync to Firestore atomically if available
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await Promise.all([
          setDoc(doc(db, "licenses", cleanCode), license),
          setDoc(doc(db, "user_licenses", uid), userLicenseRecord),
          setDoc(doc(db, "users", uid), { activeLicense: userLicenseRecord }, { merge: true }),
        ]);
      } catch (err) {
        logger.warn("Could not sync redemption to Firestore, persisted locally", err.message);
      }
    }

    await persistLocalStore();

    const remainingMs = Math.max(0, expiryDate.getTime() - Date.now());

    return {
      success: true,
      message: `License successfully redeemed! Added ${durationDays} day(s).`,
      license: {
        code: cleanCode,
        durationDays,
        redeemedAt: nowIso,
        expiresAt: expiryIso,
        remainingMs,
        remainingFormatted: formatRemainingTime(remainingMs),
      },
    };
  });
}

/**
 * Gets a user's current license status derived server-side.
 * Admin account (awoyinfasolomon1@gmail.com) has automatic unlimited access.
 */
export async function getUserLicenseStatus(uid, email = "") {
  if (email && email.trim().toLowerCase() === ADMIN_EMAIL.trim().toLowerCase()) {
    return {
      hasActiveLicense: true,
      status: "active",
      isAdmin: true,
      code: "ADMIN-UNLIMITED",
      durationDays: "Unlimited",
      redeemedAt: new Date().toISOString(),
      expiresAt: null,
      remainingMs: 3153600000000,
      remainingFormatted: "Unlimited (Admin Access)",
      serverTime: new Date().toISOString(),
    };
  }

  if (!uid) return { hasActiveLicense: false, status: "none", isAdmin: false };

  await loadLocalStore();

  let userLicense = inMemoryUserLicenses[uid];

  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, getDoc } = await import("firebase/firestore");
      const uSnap = await getDoc(doc(db, "user_licenses", uid));
      if (uSnap.exists()) {
        userLicense = uSnap.data();
        inMemoryUserLicenses[uid] = userLicense;
      }
    } catch (err) {
      logger.debug("Firestore getUserLicenseStatus notice", err.message);
    }
  }

  if (!userLicense || !userLicense.expiresAt) {
    return {
      hasActiveLicense: false,
      status: "no_license",
      isAdmin: false,
      message: "No active license",
      remainingMs: 0,
      remainingFormatted: null,
      expiresAt: null,
      serverTime: new Date().toISOString(),
    };
  }

  const nowMs = Date.now();
  const expiryMs = new Date(userLicense.expiresAt).getTime();
  const remainingMs = Math.max(0, expiryMs - nowMs);
  const isActive = remainingMs > 0;

  return {
    hasActiveLicense: isActive,
    status: isActive ? "active" : "expired",
    isAdmin: false,
    code: userLicense.lastLicenseCode || null,
    durationDays: userLicense.durationDays || null,
    redeemedAt: userLicense.redeemedAt || null,
    expiresAt: userLicense.expiresAt,
    remainingMs,
    remainingFormatted: isActive ? formatRemainingTime(remainingMs) : "Expired",
    serverTime: new Date().toISOString(),
  };
}

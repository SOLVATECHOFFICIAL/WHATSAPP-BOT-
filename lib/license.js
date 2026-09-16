import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";
import {
  getFirebaseServerFirestore,
  writeFirestoreDocumentRest,
  readFirestoreCollectionRest,
  readFirestoreDocumentRest,
} from "./auth.js";

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
 * Authoritatively syncs ALL existing licenses and user license records directly from Firebase Firestore.
 * Ensures data is 100% persistent across GitHub deploys, server restarts, and container migrations.
 */
export async function syncAllFromFirestore() {
  await loadLocalStore();
  let synced = false;

  // 1. Fetch via Firebase Client SDK
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { collection, getDocs } = await import("firebase/firestore");
      const [licensesSnap, userLicensesSnap] = await Promise.all([
        getDocs(collection(db, "licenses")).catch(() => null),
        getDocs(collection(db, "user_licenses")).catch(() => null),
      ]);

      if (licensesSnap) {
        licensesSnap.forEach((d) => {
          const data = d.data();
          if (data && (data.code || d.id)) {
            const code = data.code || d.id;
            inMemoryLicenses[code] = { ...(inMemoryLicenses[code] || {}), ...data, code };
          }
        });
        synced = true;
      }

      if (userLicensesSnap) {
        userLicensesSnap.forEach((d) => {
          const data = d.data();
          if (data && (data.uid || data.email || d.id)) {
            const key = d.id || data.uid || data.email;
            inMemoryUserLicenses[key] = { ...(inMemoryUserLicenses[key] || {}), ...data };
            if (data.uid && data.uid !== key) {
              inMemoryUserLicenses[data.uid] = { ...(inMemoryUserLicenses[data.uid] || {}), ...data };
            }
          }
        });
        synced = true;
      }
    } catch (err) {
      logger.debug("Firebase SDK syncAll notice", err.message);
    }
  }

  // 2. Ultra-reliable REST API fallback
  try {
    const [restLicenses, restUserLicenses] = await Promise.all([
      readFirestoreCollectionRest("licenses"),
      readFirestoreCollectionRest("user_licenses"),
    ]);

    if (Array.isArray(restLicenses) && restLicenses.length > 0) {
      for (const lic of restLicenses) {
        if (lic && (lic.code || lic.id)) {
          const code = lic.code || lic.id;
          inMemoryLicenses[code] = { ...(inMemoryLicenses[code] || {}), ...lic, code };
        }
      }
      synced = true;
    }

    if (Array.isArray(restUserLicenses) && restUserLicenses.length > 0) {
      for (const uLic of restUserLicenses) {
        if (uLic && (uLic.uid || uLic.email || uLic.id)) {
          const key = uLic.id || uLic.uid || uLic.email;
          inMemoryUserLicenses[key] = { ...(inMemoryUserLicenses[key] || {}), ...uLic };
          if (uLic.uid && uLic.uid !== key) {
            inMemoryUserLicenses[uLic.uid] = { ...(inMemoryUserLicenses[uLic.uid] || {}), ...uLic };
          }
        }
      }
      synced = true;
    }
  } catch (err) {
    logger.debug("REST syncAll notice", err.message);
  }

  // 3. Self-healing & continuity: Ensure every used license with an unexpired/active expiresAt
  // is seamlessly mapped to the user's active license record so their time continues without loss
  try {
    for (const lic of Object.values(inMemoryLicenses || {})) {
      if (lic && (lic.status === "used" || lic.redeemedByUid || lic.redeemedByEmail) && lic.expiresAt) {
        const uid = lic.redeemedByUid;
        const email = lic.redeemedByEmail ? lic.redeemedByEmail.toLowerCase() : "";
        const phone = lic.phoneNumber ? lic.phoneNumber.replace(/\D/g, "") : "";

        const candidateExpiryMs = new Date(lic.expiresAt).getTime();
        const userRec = {
          uid: uid || (email ? `user_${email}` : null),
          email: email || null,
          phoneNumber: phone || null,
          lastLicenseCode: lic.code,
          durationDays: lic.durationDays,
          redeemedAt: lic.redeemedAt,
          expiresAt: lic.expiresAt,
          status: candidateExpiryMs > Date.now() ? "active" : "expired",
        };

        if (uid) {
          const existing = inMemoryUserLicenses[uid];
          const existingExpMs = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
          if (!existing || candidateExpiryMs > existingExpMs) {
            inMemoryUserLicenses[uid] = { ...(existing || {}), ...userRec };
          }
        }
        if (email) {
          const existing = inMemoryUserLicenses[email];
          const existingExpMs = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
          if (!existing || candidateExpiryMs > existingExpMs) {
            inMemoryUserLicenses[email] = { ...(existing || {}), ...userRec };
          }
        }
        if (phone) {
          const existing = inMemoryUserLicenses[phone];
          const existingExpMs = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
          if (!existing || candidateExpiryMs > existingExpMs) {
            inMemoryUserLicenses[phone] = { ...(existing || {}), ...userRec };
          }
        }
      }
    }
  } catch (healErr) {
    logger.debug("License continuity reconstruction note", healErr.message);
  }

  if (synced) {
    await persistLocalStore();
  }

  return {
    licensesCount: Object.keys(inMemoryLicenses || {}).length,
    userLicensesCount: Object.keys(inMemoryUserLicenses || {}).length,
  };
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
export async function createLicenseRecord(durationDays, createdByEmail, authToken = null) {
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

    // Store in Firestore REST API directly with caller's ID token or API key
    await writeFirestoreDocumentRest("licenses", code, licenseData, authToken);

    // Also attempt Client SDK write
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "licenses", code), licenseData);
      } catch (err) {
        logger.debug("Firestore client SDK write notice", err.message);
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
export async function redeemLicenseCode(rawCode, verifiedUser, authToken = null) {
  if (!rawCode || typeof rawCode !== "string") {
    throw new Error("License code is required.");
  }
  if (!verifiedUser || !verifiedUser.uid) {
    throw new Error("Valid authenticated user required.");
  }

  const rawClean = rawCode.trim().toUpperCase();
  const strippedCode = rawClean.replace(/[^A-Z0-9]/g, "");
  const uid = verifiedUser.uid;
  const email = verifiedUser.email || "";

  return withAtomicLock(async () => {
    await loadLocalStore();

    let cleanCode = rawClean;
    let license = inMemoryLicenses[cleanCode];

    // Flexible fallback: match code by stripping dashes/spaces
    if (!license) {
      for (const [codeKey, record] of Object.entries(inMemoryLicenses)) {
        const keyStripped = codeKey.replace(/[^A-Z0-9]/g, "");
        if (keyStripped === strippedCode || keyStripped.replace(/^SOLVA/, "") === strippedCode.replace(/^SOLVA/, "")) {
          cleanCode = codeKey;
          license = record;
          break;
        }
      }
    }

    // Check Firestore for authoritative record if not found locally or to sync
    const db = getFirebaseServerFirestore();
    if (db && !license) {
      try {
        const { doc, getDoc, collection, getDocs } = await import("firebase/firestore");
        const docSnap = await getDoc(doc(db, "licenses", cleanCode));
        if (docSnap.exists()) {
          license = docSnap.data();
          cleanCode = docSnap.id;
          inMemoryLicenses[cleanCode] = license;
        } else {
          // Query licenses collection in case formatting differs in document ID
          const snap = await getDocs(collection(db, "licenses"));
          snap.forEach((d) => {
            const dKeyStripped = d.id.replace(/[^A-Z0-9]/g, "");
            if (dKeyStripped === strippedCode || dKeyStripped.replace(/^SOLVA/, "") === strippedCode.replace(/^SOLVA/, "")) {
              cleanCode = d.id;
              license = d.data();
              inMemoryLicenses[cleanCode] = license;
            }
          });
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

    // Sync to Firestore REST API atomically with caller's ID token
    await Promise.all([
      writeFirestoreDocumentRest("licenses", cleanCode, license, authToken),
      writeFirestoreDocumentRest("user_licenses", uid, userLicenseRecord, authToken),
      writeFirestoreDocumentRest("users", uid, { activeLicense: userLicenseRecord }, authToken),
    ]);

    // Also attempt Client SDK write
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await Promise.all([
          setDoc(doc(db, "licenses", cleanCode), license),
          setDoc(doc(db, "user_licenses", uid), userLicenseRecord),
          setDoc(doc(db, "users", uid), { activeLicense: userLicenseRecord }, { merge: true }),
        ]);
      } catch (err) {
        logger.debug("Could not sync redemption via Firestore SDK", err.message);
      }
    }

    await persistLocalStore();

    // Record purchase for referral attribution (official qualifying amount derived from duration)
    try {
      const { recordPurchaseForReferral } = await import("./referral.js");
      await recordPurchaseForReferral(
        uid,
        durationDays,
        cleanCode,
        Boolean(license.isReward || license.isFree),
        email,
        authToken
      );
    } catch (refErr) {
      logger.warn("Referral purchase attribution notice", refErr.message);
    }

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
 * Resolves by Firebase UID, Google email, or linked WhatsApp phone number.
 * Admin account (awoyinfasolomon1@gmail.com) has automatic unlimited access.
 */
export async function getUserLicenseStatus(uid = "", email = "", phone = "") {
  let cleanUid = typeof uid === "string" ? uid.trim() : "";
  let cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  let rawPhone = typeof phone === "string" ? phone.trim() : "";

  // If uid contains a phone number pattern, extract it
  if (!rawPhone && cleanUid && (/^\+?\d{7,16}$/.test(cleanUid) || cleanUid.includes("@s.whatsapp.net"))) {
    rawPhone = cleanUid.split("@")[0].replace(/\D/g, "");
  }

  const cleanPhoneNumber = rawPhone.replace(/\D/g, "");

  const isAdmin =
    (cleanEmail && cleanEmail === ADMIN_EMAIL.trim().toLowerCase()) ||
    (cleanUid && cleanUid.toLowerCase() === ADMIN_EMAIL.trim().toLowerCase());

  if (isAdmin) {
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

  await loadLocalStore();

  // 1. If phone number is available, attempt to resolve linked UID & email from number_locks
  if (cleanPhoneNumber) {
    try {
      const { checkNumberLock } = await import("./number-lock.js");
      const lock = await checkNumberLock(cleanPhoneNumber, cleanUid || null);
      if (lock?.lockedUid && (!cleanUid || cleanUid === "default")) {
        cleanUid = lock.lockedUid;
      }
    } catch {}
  }

  // 2. Try direct lookup in inMemoryUserLicenses
  let userLicense = (cleanUid && cleanUid !== "default" ? inMemoryUserLicenses[cleanUid] : null) ||
                    (cleanEmail ? inMemoryUserLicenses[cleanEmail] : null);

  // 3. Search inMemoryUserLicenses by email, uid, or phone match
  if (!userLicense) {
    for (const [key, u] of Object.entries(inMemoryUserLicenses || {})) {
      if (!u) continue;
      if (cleanEmail && u.email && u.email.trim().toLowerCase() === cleanEmail) {
        userLicense = u;
        break;
      }
      if (cleanUid && cleanUid !== "default" && (key === cleanUid || u.uid === cleanUid)) {
        userLicense = u;
        break;
      }
      if (cleanPhoneNumber) {
        const uPhone = (u.phoneNumber || u.phone || "").replace(/\D/g, "");
        if (uPhone && uPhone === cleanPhoneNumber) {
          userLicense = u;
          break;
        }
      }
    }
  }

  // 4. Query Firestore if available
  const db = getFirebaseServerFirestore();
  if (db && !userLicense) {
    try {
      const { doc, getDoc, collection, query, where, getDocs } = await import("firebase/firestore");
      if (cleanUid && cleanUid !== "default") {
        const uSnap = await getDoc(doc(db, "user_licenses", cleanUid));
        if (uSnap.exists()) {
          userLicense = uSnap.data();
          inMemoryUserLicenses[cleanUid] = userLicense;
        } else {
          // Check users collection as well
          const userDocSnap = await getDoc(doc(db, "users", cleanUid));
          if (userDocSnap.exists() && userDocSnap.data()?.activeLicense) {
            userLicense = userDocSnap.data().activeLicense;
            inMemoryUserLicenses[cleanUid] = userLicense;
          }
        }
      }
      if (!userLicense && cleanEmail) {
        const q = query(collection(db, "user_licenses"), where("email", "==", cleanEmail));
        const snap = await getDocs(q);
        if (!snap.empty) {
          userLicense = snap.docs[0].data();
          inMemoryUserLicenses[cleanUid || cleanEmail] = userLicense;
        }
      }
      if (!userLicense && cleanPhoneNumber) {
        const snap = await getDocs(collection(db, "user_licenses"));
        snap.forEach((d) => {
          const data = d.data();
          if (data) {
            const dp = (data.phoneNumber || data.phone || "").replace(/\D/g, "");
            if (dp && dp === cleanPhoneNumber) {
              userLicense = data;
              inMemoryUserLicenses[d.id] = data;
            }
          }
        });
      }
    } catch (err) {
      logger.debug("Firestore getUserLicenseStatus notice", err.message);
    }
  }

  // 5. If still no userLicense found, check redeemed licenses
  if (!userLicense) {
    let latestLicense = null;
    let latestExpiryMs = 0;

    const allLicenses = Object.values(inMemoryLicenses || {});
    for (const lic of allLicenses) {
      if (lic && lic.status === "used" && lic.expiresAt) {
        const matchesUid = cleanUid && cleanUid !== "default" && lic.redeemedByUid === cleanUid;
        const matchesEmail = cleanEmail && lic.redeemedByEmail && lic.redeemedByEmail.toLowerCase() === cleanEmail;
        const matchesPhone = cleanPhoneNumber && (lic.phoneNumber || "").replace(/\D/g, "") === cleanPhoneNumber;

        if (matchesUid || matchesEmail || matchesPhone) {
          const expMs = new Date(lic.expiresAt).getTime();
          if (expMs > latestExpiryMs) {
            latestExpiryMs = expMs;
            latestLicense = lic;
          }
        }
      }
    }

    if (latestLicense) {
      userLicense = {
        uid: latestLicense.redeemedByUid || cleanUid,
        email: latestLicense.redeemedByEmail || cleanEmail,
        lastLicenseCode: latestLicense.code,
        durationDays: latestLicense.durationDays,
        redeemedAt: latestLicense.redeemedAt,
        expiresAt: latestLicense.expiresAt,
        status: new Date(latestLicense.expiresAt).getTime() > Date.now() ? "active" : "expired",
      };
    }
  }

  // 6. Single-user standalone fallback: if cleanUid === "default" and exactly one user license exists
  if (!userLicense && (!cleanUid || cleanUid === "default") && !cleanEmail && !cleanPhoneNumber) {
    const keys = Object.keys(inMemoryUserLicenses || {});
    if (keys.length === 1) {
      userLicense = inMemoryUserLicenses[keys[0]];
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

  // Handle administratively stopped licenses
  if (userLicense.adminStopped || userLicense.status === "stopped") {
    return {
      hasActiveLicense: false,
      status: "stopped",
      isAdmin: false,
      adminStopped: true,
      stoppedAt: userLicense.stoppedAt || null,
      stoppedReason: userLicense.stoppedReason || "License stopped by administrator",
      message: "License has been administratively stopped.",
      code: userLicense.lastLicenseCode || null,
      durationDays: userLicense.durationDays || null,
      redeemedAt: userLicense.redeemedAt || null,
      expiresAt: userLicense.expiresAt || null,
      remainingMs: 0,
      remainingFormatted: "Admin Stopped",
      serverTime: new Date().toISOString(),
      userEmail: userLicense.email || cleanEmail || null,
      uid: userLicense.uid || cleanUid || null,
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
    userEmail: userLicense.email || cleanEmail || null,
    uid: userLicense.uid || cleanUid || null,
  };
}

/**
 * Extends a user's license by a specific number of free reward days.
 * Does NOT generate referral credit (₦0 sales, no recursion).
 */
export async function applyRewardLicenseExtension(uid, daysAwarded, claimId, userEmail = "", authToken = null) {
  const days = Number(daysAwarded) || 3;
  const durationMs = days * 24 * 60 * 60 * 1000;

  return withAtomicLock(async () => {
    await loadLocalStore();

    let existing = inMemoryUserLicenses[uid];
    const db = getFirebaseServerFirestore();
    if (db && !existing) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const uSnap = await getDoc(doc(db, "user_licenses", uid));
        if (uSnap.exists()) {
          existing = uSnap.data();
          inMemoryUserLicenses[uid] = existing;
        }
      } catch (err) {
        logger.debug("Firestore user license lookup notice", err.message);
      }
    }

    const now = Date.now();
    let startTimestamp = now;
    if (existing && existing.expiresAt) {
      const currentExpiry = new Date(existing.expiresAt).getTime();
      if (currentExpiry > startTimestamp) {
        // Extend existing active license
        startTimestamp = currentExpiry;
      }
    }

    const newExpiryDate = new Date(startTimestamp + durationMs);
    const newExpiryIso = newExpiryDate.toISOString();

    const updatedLicense = {
      uid,
      email: userEmail || existing?.email || "",
      lastLicenseCode: `REWARD-${claimId || "CLAIM"}`,
      durationDays: (existing?.durationDays ? Number(existing.durationDays) : 0) + days,
      redeemedAt: existing?.redeemedAt || new Date().toISOString(),
      expiresAt: newExpiryIso,
      status: "active",
      lastRewardClaimId: claimId,
      isReward: true,
      updatedAt: new Date().toISOString(),
    };

    inMemoryUserLicenses[uid] = updatedLicense;

    // Sync to Firestore REST API atomically
    await Promise.all([
      writeFirestoreDocumentRest("user_licenses", uid, updatedLicense, authToken),
      writeFirestoreDocumentRest("users", uid, { activeLicense: updatedLicense }, authToken),
    ]);

    // Also attempt Client SDK write
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await Promise.all([
          setDoc(doc(db, "user_licenses", uid), updatedLicense, { merge: true }),
          setDoc(doc(db, "users", uid), { activeLicense: updatedLicense }, { merge: true }),
        ]);
      } catch (err) {
        logger.debug("Firestore SDK sync notice for reward extension", err.message);
      }
    }

    await persistLocalStore();

    return {
      previousExpiresAt: existing?.expiresAt || null,
      newExpiresAt: newExpiryIso,
      updatedLicense,
    };
  });
}

/**
 * Super Admin Action: Administratively stops/revokes an active license.
 * Preserves historical records, referral attributions, and financial history.
 */
export async function stopActiveLicense(uid, licenseCode = "", adminEmail = ADMIN_EMAIL, reason = "Stopped by administrator", authToken = null) {
  if (!uid && !licenseCode) throw new Error("UID or License Code is required.");

  return withAtomicLock(async () => {
    await loadLocalStore();

    let userLicense = uid ? inMemoryUserLicenses[uid] : null;
    let targetCode = licenseCode || userLicense?.lastLicenseCode;

    if (!userLicense && targetCode) {
      for (const [key, u] of Object.entries(inMemoryUserLicenses)) {
        if (u && u.lastLicenseCode === targetCode) {
          userLicense = u;
          uid = key;
          break;
        }
      }
    }

    const nowIso = new Date().toISOString();

    if (targetCode && inMemoryLicenses[targetCode]) {
      inMemoryLicenses[targetCode] = {
        ...inMemoryLicenses[targetCode],
        status: "stopped",
        adminStopped: true,
        stoppedAt: nowIso,
        stoppedBy: adminEmail,
        stoppedReason: reason || "Stopped by administrator",
        updatedAt: nowIso,
      };
      await writeFirestoreDocumentRest("licenses", targetCode, inMemoryLicenses[targetCode], authToken).catch(() => {});
    }

    let updatedUserLicense = null;
    if (uid) {
      updatedUserLicense = {
        ...(userLicense || {}),
        uid,
        status: "stopped",
        adminStopped: true,
        stoppedAt: nowIso,
        stoppedBy: adminEmail,
        stoppedReason: reason || "Stopped by administrator",
        updatedAt: nowIso,
      };
      inMemoryUserLicenses[uid] = updatedUserLicense;
      if (userLicense?.email) {
        inMemoryUserLicenses[userLicense.email] = updatedUserLicense;
      }
      await Promise.all([
        writeFirestoreDocumentRest("user_licenses", uid, updatedUserLicense, authToken).catch(() => {}),
        writeFirestoreDocumentRest("users", uid, { activeLicense: updatedUserLicense }, authToken).catch(() => {}),
      ]);
    }

    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        const ops = [];
        if (targetCode) {
          ops.push(setDoc(doc(db, "licenses", targetCode), { status: "stopped", adminStopped: true, stoppedAt: nowIso, stoppedBy: adminEmail, stoppedReason: reason }, { merge: true }));
        }
        if (uid) {
          ops.push(setDoc(doc(db, "user_licenses", uid), { status: "stopped", adminStopped: true, stoppedAt: nowIso, stoppedBy: adminEmail, stoppedReason: reason }, { merge: true }));
          ops.push(setDoc(doc(db, "users", uid), { activeLicense: { status: "stopped", adminStopped: true, stoppedAt: nowIso, stoppedBy: adminEmail } }, { merge: true }));
        }
        await Promise.all(ops);
      } catch (err) {
        logger.debug("Firestore SDK stopActiveLicense notice", err.message);
      }
    }

    await persistLocalStore();
    logger.info(`Super Admin ${adminEmail} stopped license ${targetCode || "N/A"} for user ${uid || "N/A"}`);

    return {
      success: true,
      message: "License has been administratively stopped.",
      code: targetCode || null,
      uid: uid || null,
      stoppedAt: nowIso,
      status: "stopped",
    };
  });
}



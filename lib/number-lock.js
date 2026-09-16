import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";
import { getFirebaseServerFirestore } from "./auth.js";

const LOCKS_FILE = path.join(DATA_DIR, "data", "solvatech-number-locks.json");

// In-memory cache & queue
let inMemoryLocks = null;
let lockQueue = Promise.resolve();

function withAtomicLock(fn) {
  const next = lockQueue.then(() => fn()).catch((err) => {
    logger.error("Number lock operation error", err.stack || err.message);
    throw err;
  });
  lockQueue = next.then(() => {}).catch(() => {});
  return next;
}

export function cleanPhone(num) {
  if (!num) return "";
  return String(num).replace(/\D/g, "");
}

async function loadLocalStore() {
  if (!inMemoryLocks) {
    try {
      if (fsSync.existsSync(LOCKS_FILE)) {
        const raw = await fs.readFile(LOCKS_FILE, "utf8");
        inMemoryLocks = JSON.parse(raw);
      } else {
        inMemoryLocks = { locks: {}, userLocks: {}, history: [] };
      }
    } catch {
      inMemoryLocks = { locks: {}, userLocks: {}, history: [] };
    }
  }
  if (!inMemoryLocks.locks) inMemoryLocks.locks = {};
  if (!inMemoryLocks.userLocks) inMemoryLocks.userLocks = {};
  if (!Array.isArray(inMemoryLocks.history)) inMemoryLocks.history = [];
}

async function persistLocalStore() {
  try {
    await fs.mkdir(path.dirname(LOCKS_FILE), { recursive: true });
    await fs.writeFile(LOCKS_FILE, JSON.stringify(inMemoryLocks, null, 2));
  } catch (err) {
    logger.error("Failed to persist number locks store", err.message);
  }
}

const ADMIN_EMAILS = new Set([
  "awoyinfasolomon1@gmail.com",
  "awoyinfataiwo20@gmail.com",
]);

function isUserAdmin(uid = "", email = "") {
  if (uid === "admin_awoyinfasolomon1" || uid === "admin" || uid === "admin_root") return true;
  if (email && ADMIN_EMAILS.has(String(email).trim().toLowerCase())) return true;
  return false;
}

/**
 * Checks if a phone number can be paired by a given Firebase UID / User
 */
export async function checkNumberLock(rawPhone, uid, userEmail = "") {
  if (!uid) return { allowed: true };
  const phone = cleanPhone(rawPhone);

  return withAtomicLock(async () => {
    await loadLocalStore();

    // Sync Firestore if available
    const db = getFirebaseServerFirestore();
    if (db && phone) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const docSnap = await getDoc(doc(db, "number_locks", phone));
        if (docSnap.exists()) {
          const lockData = docSnap.data();
          inMemoryLocks.locks[phone] = lockData;
          if (lockData.uid) inMemoryLocks.userLocks[lockData.uid] = phone;
        }
      } catch (err) {
        logger.debug("Firestore checkNumberLock notice", err.message);
      }
    }

    const requesterIsAdmin = isUserAdmin(uid, userEmail);

    if (phone) {
      const existingLock = inMemoryLocks.locks[phone];
      if (existingLock) {
        const lockEmail = String(existingLock.userEmail || "").trim().toLowerCase();
        const currentEmail = String(userEmail || "").trim().toLowerCase();
        const lockBelongsToAdmin = isUserAdmin(existingLock.uid, lockEmail);

        // 1. Same exact UID
        if (existingLock.uid === uid) {
          return { allowed: true, alreadyLockedToUser: true, lockedNumber: phone };
        }

        // 2. Same verified user email (e.g. Google Sign-In UID vs Preview UID)
        if (currentEmail && lockEmail && currentEmail === lockEmail) {
          return { allowed: true, alreadyLockedToUser: true, lockedNumber: phone };
        }

        // 3. Admin / Owner accounts can manage and pair their WhatsApp number
        if (requesterIsAdmin || lockBelongsToAdmin) {
          return { allowed: true, alreadyLockedToUser: true, lockedNumber: phone };
        }

        return {
          allowed: false,
          reason: "NUMBER_LOCKED_TO_ANOTHER_ACCOUNT",
          message: `The WhatsApp number (+${phone}) is permanently locked to another SOLVATECH account.`,
          lockedUid: existingLock.uid,
        };
      }
    }

    // Check if user's UID is already locked to a DIFFERENT number
    let existingUserLock = inMemoryLocks.userLocks[uid];
    if (!existingUserLock && db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const uSnap = await getDoc(doc(db, "user_number_locks", uid));
        if (uSnap.exists()) {
          existingUserLock = uSnap.data()?.phoneNumber;
          if (existingUserLock) inMemoryLocks.userLocks[uid] = existingUserLock;
        }
      } catch (err) {
        logger.debug("Firestore user lock check notice", err.message);
      }
    }

    if (existingUserLock && phone && cleanPhone(existingUserLock) !== phone) {
      if (!requesterIsAdmin) {
        return {
          allowed: false,
          reason: "ACCOUNT_LOCKED_TO_DIFFERENT_NUMBER",
          message: `Your account is permanently locked to WhatsApp number (+${existingUserLock}). You cannot pair a different phone number.`,
          lockedNumber: existingUserLock,
        };
      }
    }

    return { allowed: true, alreadyLockedToUser: Boolean(existingUserLock), lockedNumber: existingUserLock || null };
  });
}

/**
 * Records a number history event in local store and Firestore
 */
export async function recordNumberHistory(entry, authToken = null) {
  if (!entry || !entry.phoneNumber) return null;
  await loadLocalStore();

  const record = {
    id: entry.id || `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    phoneNumber: cleanPhone(entry.phoneNumber),
    uid: entry.uid || "",
    userEmail: entry.userEmail || "",
    action: entry.action || "LINKED",
    status: entry.status || "Current",
    linkedAt: entry.linkedAt || new Date().toISOString(),
    unlinkedAt: entry.unlinkedAt || null,
    timestamp: entry.timestamp || new Date().toISOString(),
    adminEmail: entry.adminEmail || "",
    note: entry.note || "",
  };

  inMemoryLocks.history.unshift(record);

  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, setDoc } = await import("firebase/firestore");
      await setDoc(doc(db, "number_history", record.id), record);
    } catch (err) {
      logger.debug("Firestore recordNumberHistory notice", err.message);
    }
  }

  await persistLocalStore();
  return record;
}

/**
 * Permanently locks a WhatsApp phone number to a Firebase UID
 */
export async function lockNumberToUser(rawPhone, uid, userEmail = "") {
  if (!rawPhone || !uid) return null;
  const phone = cleanPhone(rawPhone);
  if (!phone) return null;

  return withAtomicLock(async () => {
    await loadLocalStore();

    const existingLock = inMemoryLocks.locks[phone];
    if (existingLock && existingLock.uid === uid) {
      return existingLock; // Already locked to this user
    }

    const lockData = {
      phoneNumber: phone,
      uid,
      userEmail,
      lockedAt: new Date().toISOString(),
    };

    inMemoryLocks.locks[phone] = lockData;
    inMemoryLocks.userLocks[uid] = phone;

    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await Promise.all([
          setDoc(doc(db, "number_locks", phone), lockData),
          setDoc(doc(db, "user_number_locks", uid), { phoneNumber: phone, uid, lockedAt: lockData.lockedAt }),
        ]);
      } catch (err) {
        logger.warn("Could not sync number lock to Firestore, stored in local database", err.message);
      }
    }

    // Record in history
    const historyId = `hist_${uid}_${phone}_${Date.now()}`;
    const histRecord = {
      id: historyId,
      phoneNumber: phone,
      uid,
      userEmail,
      action: "LINKED",
      status: "Current",
      linkedAt: lockData.lockedAt,
      unlinkedAt: null,
      timestamp: lockData.lockedAt,
    };
    inMemoryLocks.history.unshift(histRecord);
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "number_history", historyId), histRecord);
      } catch {}
    }

    await persistLocalStore();
    logger.info(`Permanently locked WhatsApp number +${phone} to user ${uid} (${userEmail})`);
    return lockData;
  });
}

/**
 * Gets locked number for a Firebase UID if any
 */
export async function getLockedNumberForUid(uid) {
  if (!uid) return null;
  await loadLocalStore();

  let phone = inMemoryLocks.userLocks[uid];
  if (!phone) {
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const uSnap = await getDoc(doc(db, "user_number_locks", uid));
        if (uSnap.exists()) {
          phone = uSnap.data()?.phoneNumber;
          if (phone) inMemoryLocks.userLocks[uid] = phone;
        }
      } catch (err) {
        logger.debug("Firestore getLockedNumberForUid notice", err.message);
      }
    }
  }
  return phone || null;
}

/**
 * Wipes current number lock from account.
 * Supports both user self-unlinking and Super Admin actions.
 * Preserves full historical audit record and cleanly releases the number lock.
 */
export async function wipeNumberFromAccount(uid, actorEmail = "", reason = "", isSelf = false) {
  if (!uid) throw new Error("Target UID is required.");

  return withAtomicLock(async () => {
    await loadLocalStore();

    let phone = inMemoryLocks.userLocks[uid];
    let userEmail = "";

    const db = getFirebaseServerFirestore();
    if (!phone && db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const uSnap = await getDoc(doc(db, "user_number_locks", uid));
        if (uSnap.exists()) {
          phone = uSnap.data()?.phoneNumber;
        }
      } catch (err) {
        logger.debug("Firestore lookup before wipe notice", err.message);
      }
    }

    if (phone && inMemoryLocks.locks[phone]) {
      userEmail = inMemoryLocks.locks[phone].userEmail || actorEmail || "";
    }

    const lockedAt = phone && inMemoryLocks.locks[phone]?.lockedAt ? inMemoryLocks.locks[phone].lockedAt : null;

    // Remove active locks from in-memory cache
    if (phone) {
      delete inMemoryLocks.locks[phone];
      const cleaned = cleanPhone(phone);
      if (cleaned && inMemoryLocks.locks[cleaned]) {
        delete inMemoryLocks.locks[cleaned];
      }
    }
    delete inMemoryLocks.userLocks[uid];

    // Remove from Firestore
    if (db) {
      try {
        const { doc, deleteDoc } = await import("firebase/firestore");
        const deletes = [deleteDoc(doc(db, "user_number_locks", uid))];
        if (phone) {
          deletes.push(deleteDoc(doc(db, "number_locks", phone)));
          const cleaned = cleanPhone(phone);
          if (cleaned && cleaned !== phone) {
            deletes.push(deleteDoc(doc(db, "number_locks", cleaned)));
          }
        }
        await Promise.all(deletes);
      } catch (err) {
        logger.warn("Could not delete number lock from Firestore", err.message);
      }
    }

    // Add historical record with proper status
    const nowIso = new Date().toISOString();
    const actionType = isSelf ? "USER_UNLINKED" : "REMOVED_BY_ADMIN";
    const statusLabel = isSelf ? "UNLINKED BY USER" : "REMOVED BY ADMIN";
    const defaultNote = isSelf ? "Number unlinked by user from dashboard" : "Wiped by Super Admin";

    const historyId = `hist_wiped_${uid}_${phone || "none"}_${Date.now()}`;
    const histRecord = {
      id: historyId,
      phoneNumber: phone || "NONE",
      uid,
      userEmail: userEmail || actorEmail || "",
      action: actionType,
      status: statusLabel,
      previousStatus: "Current",
      linkedAt,
      unlinkedAt: nowIso,
      timestamp: nowIso,
      adminEmail: isSelf ? "" : (actorEmail || "Super Admin"),
      actorEmail: actorEmail || "",
      note: reason || defaultNote,
    };

    inMemoryLocks.history.unshift(histRecord);

    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "number_history", historyId), histRecord);
      } catch {}
    }

    await persistLocalStore();
    logger.info(`${isSelf ? "User" : "Super Admin"} ${actorEmail || uid} wiped WhatsApp number ${phone || "N/A"} from user ${uid}`);

    return {
      success: true,
      uid,
      wipedNumber: phone || null,
      userEmail: userEmail || actorEmail,
      action: "NUMBER_WIPED",
      historyRecord: histRecord,
    };
  });
}

/**
 * Returns all number history records from memory & Firestore
 */
export async function getAllNumberHistory() {
  await loadLocalStore();
  const historyMap = new Map();

  // Load from in-memory
  for (const item of inMemoryLocks.history || []) {
    if (item && item.id) {
      historyMap.set(item.id, item);
    }
  }

  // Load from Firestore
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { collection, getDocs } = await import("firebase/firestore");
      const snap = await getDocs(collection(db, "number_history"));
      snap.forEach((d) => {
        const data = d.data();
        if (data && (data.id || d.id)) {
          historyMap.set(data.id || d.id, { ...(historyMap.get(data.id || d.id) || {}), ...data, id: data.id || d.id });
        }
      });
    } catch (err) {
      logger.debug("Firestore getAllNumberHistory notice", err.message);
    }
  }

  const allList = Array.from(historyMap.values()).sort(
    (a, b) => new Date(b.timestamp || b.linkedAt || 0).getTime() - new Date(a.timestamp || a.linkedAt || 0).getTime()
  );

  return allList;
}

/**
 * Read-only helper: Returns all number locks for admin visibility
 */
export async function getAllNumberLocks() {
  await loadLocalStore();
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { collection, getDocs } = await import("firebase/firestore");
      const snap = await getDocs(collection(db, "number_locks"));
      snap.forEach((d) => {
        const data = d.data();
        if (data && data.phoneNumber) {
          inMemoryLocks.locks[data.phoneNumber] = data;
          if (data.uid) inMemoryLocks.userLocks[data.uid] = data.phoneNumber;
        }
      });
    } catch (err) {
      logger.debug("Firestore getAllNumberLocks notice", err.message);
    }
  }
  return inMemoryLocks.locks || {};
}


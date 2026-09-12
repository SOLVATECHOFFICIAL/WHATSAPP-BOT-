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
        inMemoryLocks = { locks: {}, userLocks: {} };
      }
    } catch {
      inMemoryLocks = { locks: {}, userLocks: {} };
    }
  }
  if (!inMemoryLocks.locks) inMemoryLocks.locks = {};
  if (!inMemoryLocks.userLocks) inMemoryLocks.userLocks = {};
}

async function persistLocalStore() {
  try {
    await fs.mkdir(path.dirname(LOCKS_FILE), { recursive: true });
    await fs.writeFile(LOCKS_FILE, JSON.stringify(inMemoryLocks, null, 2));
  } catch (err) {
    logger.error("Failed to persist number locks store", err.message);
  }
}

/**
 * Checks if a phone number can be paired by a given Firebase UID
 */
export async function checkNumberLock(rawPhone, uid) {
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

    if (phone) {
      const existingLock = inMemoryLocks.locks[phone];
      if (existingLock) {
        if (existingLock.uid === uid) {
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
      return {
        allowed: false,
        reason: "ACCOUNT_LOCKED_TO_DIFFERENT_NUMBER",
        message: `Your account is permanently locked to WhatsApp number (+${existingUserLock}). You cannot pair a different phone number.`,
        lockedNumber: existingUserLock,
      };
    }

    return { allowed: true, alreadyLockedToUser: Boolean(existingUserLock), lockedNumber: existingUserLock || null };
  });
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

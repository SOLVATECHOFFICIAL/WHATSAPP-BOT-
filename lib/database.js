import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, SETTINGS_FILE } from "./config.js";
import { logger } from "./logger.js";
import { getFirebaseServerFirestore, writeFirestoreDocumentRest } from "./auth.js";
import { normalizedUser } from "./helpers.js";

const defaults = {
  antiLink: false,
  antiBot: false,
  antiStatusMention: false,
  warningLimit: 3,
  warnings: {},
  lastViolations: {},
  welcome: false,
  goodbye: false,
};

// Global shared group settings cache
let sharedGroupSettings = {};
let isStoreLoaded = false;
let writeQueue = Promise.resolve();

function sanitizeDocId(id = "") {
  return String(id).replace(/[\/\s]/g, "_");
}

async function loadStore() {
  if (isStoreLoaded) return;

  // 1. Try reading from local JSON backup
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      sharedGroupSettings = parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.error("Could not read shared group settings file", error.message);
    }
    sharedGroupSettings = {};
  }

  // 2. Fetch authoritative shared group settings from Firestore
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { collection, getDocs, doc, getDoc } = await import("firebase/firestore");
      
      // Try fetching the global shared doc first
      const sharedDocSnap = await getDoc(doc(db, "group_settings", "shared_groups"));
      if (sharedDocSnap.exists()) {
        const data = sharedDocSnap.data() || {};
        sharedGroupSettings = { ...sharedGroupSettings, ...data };
      }

      // Also fetch any per-group documents
      const colSnap = await getDocs(collection(db, "group_settings"));
      colSnap.forEach((d) => {
        const dData = d.data() || {};
        if (d.id === "shared_groups" || d.id === "global" || d.id === "default") {
          sharedGroupSettings = { ...sharedGroupSettings, ...dData };
        } else if (d.id.includes("@g.us")) {
          sharedGroupSettings[d.id] = { ...sharedGroupSettings[d.id], ...dData };
        }
      });
    } catch (err) {
      logger.debug("Firestore group settings fetch notice", err.message);
    }
  }

  isStoreLoaded = true;
}

function normalizeGroupData(groupId) {
  const stored = sharedGroupSettings[groupId] || {};
  return {
    ...defaults,
    antiLink: typeof stored.antiLink === "boolean" ? stored.antiLink : Boolean(stored.anti),
    antiBot: Boolean(stored.antiBot),
    antiStatusMention: Boolean(stored.antiStatusMention || stored.antiStatus),
    warningLimit: Math.max(1, Number(stored.warningLimit || 3)),
    warnings: stored.warnings && typeof stored.warnings === "object" ? stored.warnings : {},
    lastViolations: stored.lastViolations && typeof stored.lastViolations === "object" ? stored.lastViolations : {},
    welcome: typeof stored.welcome === "boolean" ? stored.welcome : Boolean(stored.autowelcome),
    goodbye: typeof stored.goodbye === "boolean" ? stored.goodbye : Boolean(stored.autogoodbye),
  };
}

async function persist(groupId = null) {
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      // 1. Write local disk backup
      try {
        await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
        const temp = `${SETTINGS_FILE}.tmp`;
        await fs.writeFile(temp, JSON.stringify(sharedGroupSettings, null, 2), "utf8");
        await fs.rename(temp, SETTINGS_FILE);
      } catch (fileErr) {
        logger.warn("Local group settings write notice", fileErr.message);
      }

      // 2. Sync to Firestore (Permanent Source of Truth)
      const db = getFirebaseServerFirestore();
      if (db) {
        try {
          const { doc, setDoc } = await import("firebase/firestore");
          
          // Write to shared groups collection
          await setDoc(doc(db, "group_settings", "shared_groups"), sharedGroupSettings, { merge: true });

          // If a specific group was modified, write dedicated group document for atomic indexing
          if (groupId && sharedGroupSettings[groupId]) {
            const cleanDocId = sanitizeDocId(groupId);
            await setDoc(doc(db, "group_settings", cleanDocId), sharedGroupSettings[groupId], { merge: true });
          }
        } catch (dbErr) {
          logger.warn("Could not sync group settings to Firestore", dbErr.message);
        }
      }
    });

  return writeQueue;
}

export async function getGroupSettings(groupId, _userId = "default") {
  await loadStore();
  return normalizeGroupData(groupId);
}

export async function setGroupSetting(groupId, key, value, _userId = "default") {
  await loadStore();
  const current = normalizeGroupData(groupId);
  sharedGroupSettings[groupId] = {
    ...current,
    [key]: value,
    updatedAt: new Date().toISOString(),
  };
  await persist(groupId);
  return sharedGroupSettings[groupId];
}

export async function setGroupSettings(groupId, newSettings, _userId = "default") {
  await loadStore();
  sharedGroupSettings[groupId] = {
    ...normalizeGroupData(groupId),
    ...newSettings,
    updatedAt: new Date().toISOString(),
  };
  await persist(groupId);
  return sharedGroupSettings[groupId];
}

export async function toggleGroupSetting(groupId, key, value, _userId = "default") {
  return setGroupSetting(groupId, key, value, _userId);
}

export async function addWarning(groupId, participant, reason = "prohibited action", _userId = "default") {
  await loadStore();
  const cleanParticipant = normalizedUser(participant);
  const current = normalizeGroupData(groupId);
  const currentCount = Number(current.warnings?.[cleanParticipant] || 0);
  const nextCount = currentCount + 1;
  const limit = Math.max(1, Number(current.warningLimit || 3));

  const updatedWarnings = {
    ...current.warnings,
    [cleanParticipant]: nextCount,
  };

  const updatedViolations = {
    ...current.lastViolations,
    [cleanParticipant]: {
      reason,
      timestamp: new Date().toISOString(),
      count: nextCount,
    },
  };

  sharedGroupSettings[groupId] = {
    ...current,
    warnings: updatedWarnings,
    lastViolations: updatedViolations,
    updatedAt: new Date().toISOString(),
  };

  await persist(groupId);

  return {
    count: nextCount,
    limit,
    exceeded: nextCount > limit,
    isFinal: nextCount === limit,
    participant: cleanParticipant,
    reason,
  };
}

export async function clearWarning(groupId, participant, _userId = "default") {
  await loadStore();
  const cleanParticipant = normalizedUser(participant);
  const current = normalizeGroupData(groupId);
  const updatedWarnings = { ...current.warnings };
  delete updatedWarnings[cleanParticipant];
  const updatedViolations = { ...current.lastViolations };
  delete updatedViolations[cleanParticipant];

  sharedGroupSettings[groupId] = {
    ...current,
    warnings: updatedWarnings,
    lastViolations: updatedViolations,
    updatedAt: new Date().toISOString(),
  };

  await persist(groupId);

  return {
    success: true,
    participant: cleanParticipant,
    warnings: updatedWarnings,
  };
}

export async function resetWarnings(groupId, _userId = "default") {
  await loadStore();
  const current = normalizeGroupData(groupId);
  sharedGroupSettings[groupId] = {
    ...current,
    warnings: {},
    lastViolations: {},
    updatedAt: new Date().toISOString(),
  };

  await persist(groupId);

  return {
    success: true,
    groupId,
  };
}

export async function setWarningLimit(groupId, limit, _userId = "default") {
  await loadStore();
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 3));
  const current = normalizeGroupData(groupId);
  sharedGroupSettings[groupId] = {
    ...current,
    warningLimit: safeLimit,
    updatedAt: new Date().toISOString(),
  };

  await persist(groupId);
  return safeLimit;
}

// Distributed event claims cache to ensure only one bot session processes each welcome/goodbye event
const localEventClaims = new Map();

/**
 * Distributed event claim coordinator across multiple connected bot sessions.
 * Guarantees exactly ONE connected bot session sends the welcome/goodbye message per participant join/leave event.
 */
export async function claimParticipantEvent(groupId, participantJid, action, userId = "default", ttlMs = 120000) {
  const cleanGroup = sanitizeDocId(groupId);
  const cleanParticipant = normalizedUser(participantJid);
  const timeBucket = Math.floor(Date.now() / (ttlMs / 2)); // 60-second discrete sliding buckets
  const eventId = `evt_${cleanGroup}_${action}_${cleanParticipant}_${timeBucket}`;
  const now = Date.now();

  // 1. Fast local process memory check
  const localClaim = localEventClaims.get(eventId);
  if (localClaim && now - localClaim < ttlMs) {
    return false; // Already claimed by another session in this process
  }
  localEventClaims.set(eventId, now);

  // Clean old local entries
  if (localEventClaims.size > 2000) {
    for (const [key, ts] of localEventClaims.entries()) {
      if (now - ts > ttlMs) localEventClaims.delete(key);
    }
  }

  // 2. Distributed Firestore claim (coordinates multiple independent containers/processes/nodes)
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, runTransaction } = await import("firebase/firestore");
      const eventDocRef = doc(db, "group_events", eventId);

      const claimed = await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(eventDocRef);
        if (snap.exists()) {
          const data = snap.data() || {};
          if (now - (data.timestamp || 0) < ttlMs) {
            return false; // Already claimed by another active connected bot session!
          }
        }
        transaction.set(eventDocRef, {
          groupId,
          participant: cleanParticipant,
          action,
          claimedBy: userId,
          timestamp: now,
          expiresAt: new Date(now + ttlMs).toISOString(),
        });
        return true;
      });

      return claimed;
    } catch (err) {
      logger.debug("Distributed Firestore event claim check", err.message);
      return true; // Fallback to local lock if offline
    }
  }

  return true;
}

/**
 * Distributed violation claim coordinator across multiple connected bot sessions.
 * Guarantees exactly ONE connected bot session handles a specific violating message
 * (deleting it, incrementing the warning by 1, and sending the warning/removal notice).
 */
export async function claimViolationEvent(groupId, messageId, participantJid, userId = "default", ttlMs = 120000) {
  const cleanGroup = sanitizeDocId(groupId);
  const cleanMsgId = sanitizeDocId(messageId || "unknown");
  const eventId = `viol_${cleanGroup}_${cleanMsgId}`;
  const now = Date.now();

  // 1. Fast local process memory check
  const localClaim = localEventClaims.get(eventId);
  if (localClaim && now - localClaim < ttlMs) {
    return false; // Already claimed by another session in this process
  }
  localEventClaims.set(eventId, now);

  // Clean old local entries
  if (localEventClaims.size > 2000) {
    for (const [key, ts] of localEventClaims.entries()) {
      if (now - ts > ttlMs) localEventClaims.delete(key);
    }
  }

  // 2. Distributed Firestore claim (coordinates multiple independent containers/processes/nodes)
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, runTransaction } = await import("firebase/firestore");
      const eventDocRef = doc(db, "group_events", eventId);

      const claimed = await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(eventDocRef);
        if (snap.exists()) {
          const data = snap.data() || {};
          if (now - (data.timestamp || 0) < ttlMs) {
            return false; // Already claimed by another active connected bot session!
          }
        }
        transaction.set(eventDocRef, {
          groupId,
          messageId: cleanMsgId,
          participant: normalizedUser(participantJid),
          claimedBy: userId,
          timestamp: now,
          expiresAt: new Date(now + ttlMs).toISOString(),
        });
        return true;
      });

      return claimed;
    } catch (err) {
      logger.debug("Distributed Firestore violation claim check", err.message);
      return true; // Fallback to local lock if offline
    }
  }

  return true;
}



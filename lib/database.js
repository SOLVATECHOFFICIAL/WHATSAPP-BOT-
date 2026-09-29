import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, SETTINGS_FILE } from "./config.js";
import { logger } from "./logger.js";
import {
  getFirebaseServerFirestore,
  readFirestoreDocumentRest,
  writeFirestoreDocumentRest,
} from "./auth.js";
import { extractParticipantNumber, jidAliases, normalizedUser } from "./helpers.js";

const USER_PREFERENCES_FILE = path.join(DATA_DIR, "user-preferences.json");

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

const userPreferenceDefaults = {
  deletedMessageRecovery: false,
  viewOnceRecovery: true,
};

// Global shared group settings cache
let sharedGroupSettings = {};
let isStoreLoaded = false;
let writeQueue = Promise.resolve();

// Per-user preferences cache
let userPreferencesStore = {};
let isUserPrefsLoaded = false;
let userPrefsWriteQueue = Promise.resolve();

function sanitizeDocId(id = "") {
  return String(id).replace(/[\/\s]/g, "_");
}

function mergeGroupRecord(existing, incoming) {
  if (!incoming || typeof incoming !== "object") return existing || {};
  if (!existing || typeof existing !== "object") return { ...incoming };

  const existingTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
  const incomingTime = incoming.updatedAt ? new Date(incoming.updatedAt).getTime() : 0;

  if (incomingTime >= existingTime) {
    return { ...existing, ...incoming, warnings: incoming.warnings || {}, lastViolations: incoming.lastViolations || {} };
  }
  return existing;
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

  // 2. Fetch authoritative shared group settings from Firestore (SDK + REST fallback)
  const db = getFirebaseServerFirestore();
  let loadedFromSdk = false;
  if (db) {
    try {
      const { collection, getDocs, doc, getDoc } = await import("firebase/firestore");

      // Try fetching the global shared doc first
      const sharedDocSnap = await getDoc(doc(db, "group_settings", "shared_groups"));
      if (sharedDocSnap.exists()) {
        const data = sharedDocSnap.data() || {};
        for (const [gId, gVal] of Object.entries(data)) {
          if (gId.includes("@g.us") && gVal && typeof gVal === "object") {
            sharedGroupSettings[gId] = mergeGroupRecord(sharedGroupSettings[gId], gVal);
          }
        }
        loadedFromSdk = true;
      }

      // Also fetch any per-group documents
      const colSnap = await getDocs(collection(db, "group_settings"));
      colSnap.forEach((d) => {
        const dData = d.data() || {};
        if (d.id === "shared_groups" || d.id === "global" || d.id === "default") {
          for (const [gId, gVal] of Object.entries(dData)) {
            if (gId.includes("@g.us") && gVal && typeof gVal === "object") {
              sharedGroupSettings[gId] = mergeGroupRecord(sharedGroupSettings[gId], gVal);
            }
          }
        } else if (d.id.includes("@g.us")) {
          sharedGroupSettings[d.id] = mergeGroupRecord(sharedGroupSettings[d.id], dData);
        }
      });
      loadedFromSdk = true;
    } catch (err) {
      logger.debug("Firestore group settings fetch notice", err.message);
    }
  }

  if (!loadedFromSdk) {
    try {
      const restShared = await readFirestoreDocumentRest("group_settings", "shared_groups");
      if (restShared && typeof restShared === "object") {
        for (const [gId, gVal] of Object.entries(restShared)) {
          if (gId.includes("@g.us") && gVal && typeof gVal === "object") {
            sharedGroupSettings[gId] = mergeGroupRecord(sharedGroupSettings[gId], gVal);
          }
        }
      }
    } catch {}
  }

  isStoreLoaded = true;
}

export async function syncGroupSettingsFromFirestore(force = false) {
  if (force) {
    isStoreLoaded = false;
  }
  await loadStore();
  return sharedGroupSettings;
}

function normalizeGroupData(groupId) {
  const stored = sharedGroupSettings[groupId] || {};
  const rawWarnings = stored.warnings && typeof stored.warnings === "object" ? stored.warnings : {};
  const cleanWarnings = {};
  for (const [k, v] of Object.entries(rawWarnings)) {
    const count = Number(v);
    if (k && Number.isFinite(count) && count > 0) {
      cleanWarnings[k] = count;
    }
  }

  const rawViolations = stored.lastViolations && typeof stored.lastViolations === "object" ? stored.lastViolations : {};
  const cleanViolations = {};
  for (const [k, v] of Object.entries(rawViolations)) {
    if (k && cleanWarnings[k] && v && typeof v === "object") {
      cleanViolations[k] = v;
    }
  }

  return {
    ...defaults,
    antiLink: typeof stored.antiLink === "boolean" ? stored.antiLink : Boolean(stored.anti),
    antiBot: Boolean(stored.antiBot),
    antiStatusMention: Boolean(stored.antiStatusMention || stored.antiStatus),
    warningLimit: Math.max(1, Number(stored.warningLimit || 3)),
    warnings: cleanWarnings,
    lastViolations: cleanViolations,
    welcome: typeof stored.welcome === "boolean" ? stored.welcome : Boolean(stored.autowelcome),
    goodbye: typeof stored.goodbye === "boolean" ? stored.goodbye : Boolean(stored.autogoodbye),
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
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
      // IMPORTANT: Do NOT use { merge: true } here because Firestore deep-merges nested maps
      // (such as `warnings` and `lastViolations`), which would keep deleted keys after .clearwarns or .resetwarns!
      const db = getFirebaseServerFirestore();
      let sdkSynced = false;
      if (db) {
        try {
          const { doc, setDoc } = await import("firebase/firestore");

          if (groupId && sharedGroupSettings[groupId]) {
            const cleanDocId = sanitizeDocId(groupId);
            await setDoc(doc(db, "group_settings", cleanDocId), sharedGroupSettings[groupId]);
          }
          await setDoc(doc(db, "group_settings", "shared_groups"), sharedGroupSettings);
          sdkSynced = true;
        } catch (dbErr) {
          logger.debug("Firestore SDK group settings sync notice, using REST fallback", dbErr.message);
        }
      }

      // 3. Also sync via Firestore REST API to guarantee persistence even if SDK lacks auth context
      try {
        if (groupId && sharedGroupSettings[groupId]) {
          const cleanDocId = sanitizeDocId(groupId);
          await writeFirestoreDocumentRest("group_settings", cleanDocId, sharedGroupSettings[groupId]);
        }
        if (!sdkSynced) {
          await writeFirestoreDocumentRest("group_settings", "shared_groups", sharedGroupSettings);
        }
      } catch (restErr) {
        logger.debug("Firestore REST group settings sync notice", restErr.message);
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

function keyMatchesCandidateJids(recordKey, candidateJids = []) {
  if (!recordKey) return false;
  const candidates = (Array.isArray(candidateJids) ? candidateJids : [candidateJids]).filter(Boolean);
  if (candidates.length === 0) return false;

  const wantedAliases = new Set(candidates.flatMap(jidAliases));
  const wantedPhoneNumbers = new Set(
    candidates
      .filter((j) => typeof j === "string" && j.endsWith("@s.whatsapp.net"))
      .map((j) => extractParticipantNumber(j))
      .filter(Boolean)
  );

  if (wantedAliases.has(recordKey)) return true;
  const keyAliases = jidAliases(recordKey);
  if (keyAliases.some((a) => wantedAliases.has(a))) return true;

  if (wantedPhoneNumbers.size > 0 && String(recordKey).endsWith("@s.whatsapp.net")) {
    const keyPhone = extractParticipantNumber(recordKey);
    if (keyPhone && wantedPhoneNumbers.has(keyPhone)) return true;
  }

  return false;
}

export async function addWarning(groupId, participant, reason = "prohibited action", _userId = "default", aliasJids = []) {
  await loadStore();
  const cleanParticipant = normalizedUser(participant);
  const allCandidates = [cleanParticipant, participant, ...(Array.isArray(aliasJids) ? aliasJids : [])].filter(Boolean);
  const current = normalizeGroupData(groupId);

  const updatedWarnings = { ...current.warnings };
  const updatedViolations = { ...current.lastViolations };

  // Consolidate any existing count stored under any alias of this participant
  let currentCount = 0;
  for (const [existingKey, val] of Object.entries(updatedWarnings)) {
    if (keyMatchesCandidateJids(existingKey, allCandidates)) {
      currentCount = Math.max(currentCount, Number(val || 0));
      if (existingKey !== cleanParticipant) {
        delete updatedWarnings[existingKey];
        delete updatedViolations[existingKey];
      }
    }
  }

  const nextCount = currentCount + 1;
  const limit = Math.max(1, Number(current.warningLimit || 3));

  updatedWarnings[cleanParticipant] = nextCount;
  updatedViolations[cleanParticipant] = {
    reason,
    timestamp: new Date().toISOString(),
    count: nextCount,
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

export async function clearWarning(groupId, participantOrJids, _userId = "default") {
  await loadStore();
  const candidates = (Array.isArray(participantOrJids) ? participantOrJids : [participantOrJids])
    .filter(Boolean)
    .flatMap((j) => [j, normalizedUser(j), ...jidAliases(j)])
    .filter(Boolean);

  const primaryParticipant = normalizedUser(candidates.find((j) => j.endsWith("@s.whatsapp.net")) || candidates[0] || "");
  const current = normalizeGroupData(groupId);
  const updatedWarnings = { ...current.warnings };
  const updatedViolations = { ...current.lastViolations };

  for (const key of Object.keys(updatedWarnings)) {
    if (keyMatchesCandidateJids(key, candidates)) {
      delete updatedWarnings[key];
    }
  }

  for (const key of Object.keys(updatedViolations)) {
    if (keyMatchesCandidateJids(key, candidates)) {
      delete updatedViolations[key];
    }
  }

  sharedGroupSettings[groupId] = {
    ...current,
    warnings: updatedWarnings,
    lastViolations: updatedViolations,
    updatedAt: new Date().toISOString(),
  };

  await persist(groupId);

  return {
    success: true,
    participant: primaryParticipant,
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

// ============================================================================
// PER-USER PRIVACY & MESSAGE RECOVERY PREFERENCES (Dashboard OFF / ON)
// ============================================================================

export function normalizeUserPrefKeys(userIdOrUid = "default", secondKey = "") {
  const raw1 = String(userIdOrUid || "default").trim();
  const raw2 = String(secondKey || "").trim();
  const base = (raw2 && raw2 !== "default" ? raw2 : raw1) || "default";
  const uid = base.startsWith("user_") ? base.slice(5) : base;
  const safeUserId = base.startsWith("user_")
    ? base
    : `user_${base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96)}`;
  return { uid, safeUserId };
}

async function loadUserPreferencesStore() {
  if (isUserPrefsLoaded) return;
  try {
    const raw = await fs.readFile(USER_PREFERENCES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      userPreferencesStore = parsed;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      logger.debug("Could not read user preferences file", err.message);
    }
    userPreferencesStore = {};
  }
  isUserPrefsLoaded = true;
}

async function persistUserPreferencesLocal() {
  userPrefsWriteQueue = userPrefsWriteQueue
    .catch(() => {})
    .then(async () => {
      try {
        await fs.mkdir(path.dirname(USER_PREFERENCES_FILE), { recursive: true });
        const temp = `${USER_PREFERENCES_FILE}.tmp`;
        await fs.writeFile(temp, JSON.stringify(userPreferencesStore, null, 2), "utf8");
        await fs.rename(temp, USER_PREFERENCES_FILE);
      } catch (err) {
        logger.debug("Local user preferences write notice", err.message);
      }
    });
  return userPrefsWriteQueue;
}

function normalizeSingleUserPref(stored = {}) {
  return {
    deletedMessageRecovery:
      typeof stored?.deletedMessageRecovery === "boolean"
        ? stored.deletedMessageRecovery
        : userPreferenceDefaults.deletedMessageRecovery,
    viewOnceRecovery:
      typeof stored?.viewOnceRecovery === "boolean"
        ? stored.viewOnceRecovery
        : userPreferenceDefaults.viewOnceRecovery,
    updatedAt: stored?.updatedAt || null,
  };
}

const fetchedUserPrefsFromFirestore = new Set();

export async function getUserPreferences(userIdOrUid = "default", secondKey = "") {
  await loadUserPreferencesStore();
  const { uid, safeUserId } = normalizeUserPrefKeys(userIdOrUid, secondKey);

  // Check if we need an initial Firestore sync for this user
  if (!fetchedUserPrefsFromFirestore.has(uid) && uid !== "default") {
    fetchedUserPrefsFromFirestore.add(uid);
    const localExisting = userPreferencesStore[uid] || userPreferencesStore[safeUserId];
    let remoteData = null;

    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const [uSnap, sSnap] = await Promise.all([
          getDoc(doc(db, "users", uid)).catch(() => null),
          getDoc(doc(db, "user_settings", safeUserId)).catch(() => null),
        ]);
        if (sSnap?.exists?.()) {
          remoteData = { ...remoteData, ...sSnap.data() };
        }
        if (uSnap?.exists?.()) {
          const uData = uSnap.data() || {};
          if (typeof uData.deletedMessageRecovery === "boolean" || typeof uData.viewOnceRecovery === "boolean") {
            remoteData = { ...remoteData, ...uData };
          }
        }
      } catch {}
    }

    if (!remoteData) {
      try {
        const [restSettings, restUser] = await Promise.all([
          readFirestoreDocumentRest("user_settings", safeUserId).catch(() => null),
          readFirestoreDocumentRest("users", uid).catch(() => null),
        ]);
        if (restSettings) remoteData = { ...remoteData, ...restSettings };
        if (restUser && (typeof restUser.deletedMessageRecovery === "boolean" || typeof restUser.viewOnceRecovery === "boolean")) {
          remoteData = { ...remoteData, ...restUser };
        }
      } catch {}
    }

    if (remoteData) {
      const merged = normalizeSingleUserPref({ ...localExisting, ...remoteData });
      userPreferencesStore[uid] = merged;
      userPreferencesStore[safeUserId] = merged;
      await persistUserPreferencesLocal();
    }
  }

  const stored = userPreferencesStore[uid] || userPreferencesStore[safeUserId] || {};
  return normalizeSingleUserPref(stored);
}

export async function setUserPreferences(userIdOrUid = "default", arg2 = {}, arg3 = null, arg4 = "") {
  await loadUserPreferencesStore();
  let updates = arg2;
  let authToken = arg3;
  let secondKey = arg4;
  if (typeof arg2 === "string" && arg3 && typeof arg3 === "object") {
    secondKey = arg2;
    updates = arg3;
    authToken = typeof arg4 === "string" ? arg4 : null;
  }
  const { uid, safeUserId } = normalizeUserPrefKeys(userIdOrUid, secondKey);
  fetchedUserPrefsFromFirestore.add(uid);

  const current = normalizeSingleUserPref(userPreferencesStore[uid] || userPreferencesStore[safeUserId] || {});
  const updated = {
    ...current,
    ...(typeof updates.deletedMessageRecovery === "boolean"
      ? { deletedMessageRecovery: updates.deletedMessageRecovery }
      : {}),
    ...(typeof updates.viewOnceRecovery === "boolean"
      ? { viewOnceRecovery: updates.viewOnceRecovery }
      : {}),
    updatedAt: new Date().toISOString(),
  };

  userPreferencesStore[uid] = updated;
  userPreferencesStore[safeUserId] = updated;
  await persistUserPreferencesLocal();

  // Persist to Firestore (both `user_settings/{safeUserId}` and `users/{uid}`)
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, setDoc } = await import("firebase/firestore");
      await Promise.all([
        setDoc(doc(db, "user_settings", safeUserId), { uid, safeUserId, ...updated }, { merge: true }).catch(() => {}),
        setDoc(doc(db, "users", uid), {
          deletedMessageRecovery: updated.deletedMessageRecovery,
          viewOnceRecovery: updated.viewOnceRecovery,
          preferencesUpdatedAt: updated.updatedAt,
        }, { merge: true }).catch(() => {}),
      ]);
    } catch {}
  }

  try {
    await writeFirestoreDocumentRest("user_settings", safeUserId, { uid, safeUserId, ...updated }, authToken);
  } catch {}

  return updated;
}

export async function isDeletedMessageRecoveryEnabled(userIdOrUid = "default", secondKey = "") {
  const prefs = await getUserPreferences(userIdOrUid, secondKey);
  return prefs.deletedMessageRecovery === true;
}

export async function isViewOnceRecoveryEnabled(userIdOrUid = "default", secondKey = "") {
  const prefs = await getUserPreferences(userIdOrUid, secondKey);
  return prefs.viewOnceRecovery !== false;
}

// Distributed event claims cache to ensure only one bot session processes each welcome/goodbye event
const localEventClaims = new Map();

/**
 * Distributed event claim coordinator across multiple connected bot sessions.
 * Guarantees exactly ONE connected bot session sends the welcome/goodbye message per participant join/leave event.
 */
export async function claimParticipantEvent(groupId, participantJid, action, userId = "default", ttlMs = 60000) {
  const cleanGroup = sanitizeDocId(groupId);
  const cleanParticipant = normalizedUser(participantJid);
  const eventId = `evt_${cleanGroup}_${action}_${sanitizeDocId(cleanParticipant)}`;
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
 * Releases a previously claimed participant join/leave event if the selected admin bot session
 * disconnects or fails before the greeting message is sent, allowing another eligible admin bot to take over.
 */
export async function releaseParticipantEvent(groupId, participantJid, action) {
  const cleanGroup = sanitizeDocId(groupId);
  const cleanParticipant = normalizedUser(participantJid);
  const eventId = `evt_${cleanGroup}_${action}_${sanitizeDocId(cleanParticipant)}`;
  localEventClaims.delete(eventId);

  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, deleteDoc } = await import("firebase/firestore");
      await deleteDoc(doc(db, "group_events", eventId));
    } catch (err) {
      logger.debug("Distributed Firestore event claim release notice", err.message);
    }
  }
}

/**
 * Distributed violation claim coordinator across multiple connected bot sessions.
 * Guarantees exactly ONE connected bot session handles a specific violating message
 * (deleting it, incrementing the warning by 1, and sending the warning/removal notice).
 */
export async function claimViolationEvent(groupId, messageId, participantJid, userId = "default", ttlMs = 120000, isStatusMention = false) {
  const cleanGroup = sanitizeDocId(groupId);
  const cleanMsgId = sanitizeDocId(messageId || "unknown");
  const cleanParticipant = normalizedUser(participantJid);
  const eventId = `viol_${cleanGroup}_${cleanMsgId}`;
  const now = Date.now();

  // Cross-path deduplication window (10s) when WhatsApp delivers both Path A (status@broadcast)
  // and Path B (in-group notification) with distinct message IDs for the same status mention.
  const statusWindowId = isStatusMention && cleanParticipant
    ? `viol_status_${cleanGroup}_${sanitizeDocId(cleanParticipant)}`
    : null;

  // 1. Fast local process memory check
  const localClaim = localEventClaims.get(eventId);
  if (localClaim && now - localClaim < ttlMs) {
    return false; // Already claimed by another session in this process
  }
  if (statusWindowId) {
    const windowClaim = localEventClaims.get(statusWindowId);
    if (windowClaim && now - windowClaim < 10000) {
      return false; // Already claimed via the other status mention delivery path
    }
    localEventClaims.set(statusWindowId, now);
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
      const windowDocRef = statusWindowId ? doc(db, "group_events", statusWindowId) : null;

      const claimed = await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(eventDocRef);
        if (snap.exists()) {
          const data = snap.data() || {};
          if (now - (data.timestamp || 0) < ttlMs) {
            return false; // Already claimed by another active connected bot session!
          }
        }
        if (windowDocRef) {
          const wSnap = await transaction.get(windowDocRef);
          if (wSnap.exists()) {
            const wData = wSnap.data() || {};
            if (now - (wData.timestamp || 0) < 10000) {
              return false; // Already claimed via other status mention path!
            }
          }
          transaction.set(windowDocRef, {
            groupId,
            messageId: cleanMsgId,
            participant: cleanParticipant,
            claimedBy: userId,
            timestamp: now,
            expiresAt: new Date(now + 10000).toISOString(),
          });
        }
        transaction.set(eventDocRef, {
          groupId,
          messageId: cleanMsgId,
          participant: cleanParticipant,
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

/**
 * Releases a previously claimed violation/warning event if the selected admin bot session
 * disconnects or fails before the warning action is completed, allowing another eligible admin bot to take over.
 */
export async function releaseViolationEvent(groupId, messageId, participantJid = "", isStatusMention = false) {
  const cleanGroup = sanitizeDocId(groupId);
  const cleanMsgId = sanitizeDocId(messageId || "unknown");
  const cleanParticipant = normalizedUser(participantJid);
  const eventId = `viol_${cleanGroup}_${cleanMsgId}`;
  const statusWindowId = isStatusMention && cleanParticipant
    ? `viol_status_${cleanGroup}_${sanitizeDocId(cleanParticipant)}`
    : null;

  localEventClaims.delete(eventId);
  if (statusWindowId) {
    localEventClaims.delete(statusWindowId);
  }

  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, deleteDoc } = await import("firebase/firestore");
      await deleteDoc(doc(db, "group_events", eventId));
      if (statusWindowId) {
        await deleteDoc(doc(db, "group_events", statusWindowId));
      }
    } catch (err) {
      logger.debug("Distributed Firestore violation claim release notice", err.message);
    }
  }
}




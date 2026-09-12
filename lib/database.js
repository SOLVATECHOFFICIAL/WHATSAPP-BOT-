import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, SETTINGS_FILE } from "./config.js";
import { logger } from "./logger.js";

const defaults = {
  antiLink: false,
  antiBot: false,
  warningLimit: 3,
  warnings: {},
};

// Map of userId -> { settings: Record<string, any>, loaded: boolean, writeTail: Promise<void> }
const userStores = new Map();

function getUserStore(userId = "default") {
  const safeId = String(userId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!userStores.has(safeId)) {
    const filePath = safeId === "default" 
      ? SETTINGS_FILE 
      : path.join(DATA_DIR, "data", `group-settings-${safeId}.json`);
    userStores.set(safeId, {
      filePath,
      settings: {},
      loaded: false,
      writeTail: Promise.resolve(),
    });
  }
  return userStores.get(safeId);
}

async function ensureLoaded(userId = "default") {
  const store = getUserStore(userId);
  if (store.loaded) return store;
  try {
    store.settings = JSON.parse(await fs.readFile(store.filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") logger.error(`Could not read group settings for user ${userId}`, error.message);
    store.settings = {};
  }
  store.loaded = true;
  return store;
}

function normalized(store, groupId) {
  const stored = store.settings[groupId] || {};
  return {
    ...defaults,
    antiLink: typeof stored.antiLink === "boolean" ? stored.antiLink : Boolean(stored.anti),
    antiBot: Boolean(stored.antiBot),
    warningLimit: Number(stored.warningLimit || 3),
    warnings: stored.warnings && typeof stored.warnings === "object" ? stored.warnings : {},
  };
}

function persist(store) {
  store.writeTail = store.writeTail
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(store.filePath), { recursive: true });
      const temp = `${store.filePath}.tmp`;
      await fs.writeFile(temp, JSON.stringify(store.settings, null, 2));
      await fs.rename(temp, store.filePath);
    });
  return store.writeTail;
}

export async function getGroupSettings(groupId, userId = "default") {
  const store = await ensureLoaded(userId);
  return normalized(store, groupId);
}

export async function setGroupSetting(groupId, key, value, userId = "default") {
  const store = await ensureLoaded(userId);
  store.settings[groupId] = { ...normalized(store, groupId), [key]: value };
  await persist(store);
  return store.settings[groupId];
}

export async function addWarning(groupId, participant, userId = "default") {
  const store = await ensureLoaded(userId);
  const current = normalized(store, groupId);
  const warnings = { ...current.warnings, [participant]: (current.warnings[participant] || 0) + 1 };
  store.settings[groupId] = { ...current, warnings };
  await persist(store);
  return {
    count: warnings[participant],
    limit: current.warningLimit,
    exceeded: warnings[participant] >= current.warningLimit,
  };
}

export async function clearWarning(groupId, participant, userId = "default") {
  const store = await ensureLoaded(userId);
  const current = normalized(store, groupId);
  const warnings = { ...current.warnings };
  delete warnings[participant];
  store.settings[groupId] = { ...current, warnings };
  await persist(store);
  return warnings;
}

export async function resetWarnings(groupId, userId = "default") {
  const store = await ensureLoaded(userId);
  const current = normalized(store, groupId);
  store.settings[groupId] = { ...current, warnings: {} };
  await persist(store);
  return store.settings[groupId];
}

export async function setWarningLimit(groupId, limit, userId = "default") {
  const store = await ensureLoaded(userId);
  const current = normalized(store, groupId);
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 3));
  store.settings[groupId] = { ...current, warningLimit: safeLimit };
  await persist(store);
  return safeLimit;
}
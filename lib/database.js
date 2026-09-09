import fs from "node:fs/promises";
import path from "node:path";
import { SETTINGS_FILE } from "./config.js";
import { logger } from "./logger.js";

const defaults = {
  antiLink: false,
  antiBot: false,
  warnings: {},
};
let settings = {};
let loaded = false;
let writeTail = Promise.resolve();

async function ensureLoaded() {
  if (loaded) return;
  try {
    settings = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") logger.error("Could not read group settings", error.message);
    settings = {};
  }
  loaded = true;
}

function normalized(groupId) {
  const stored = settings[groupId] || {};
  return {
    ...defaults,
    // Preserve the original single `.anti` switch as anti-link protection.
    antiLink: typeof stored.antiLink === "boolean" ? stored.antiLink : Boolean(stored.anti),
    antiBot: Boolean(stored.antiBot),
    warnings: stored.warnings && typeof stored.warnings === "object" ? stored.warnings : {},
  };
}

function persist() {
  writeTail = writeTail
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
      const temp = `${SETTINGS_FILE}.tmp`;
      await fs.writeFile(temp, JSON.stringify(settings, null, 2));
      await fs.rename(temp, SETTINGS_FILE);
    });
  return writeTail;
}

export async function getGroupSettings(groupId) {
  await ensureLoaded();
  return normalized(groupId);
}

export async function setGroupSetting(groupId, key, value) {
  await ensureLoaded();
  settings[groupId] = { ...normalized(groupId), [key]: value };
  await persist();
  return settings[groupId];
}

export async function addWarning(groupId, participant) {
  await ensureLoaded();
  const current = normalized(groupId);
  const warnings = { ...current.warnings, [participant]: (current.warnings[participant] || 0) + 1 };
  settings[groupId] = { ...current, warnings };
  await persist();
  return warnings[participant];
}

export async function clearWarning(groupId, participant) {
  await ensureLoaded();
  const current = normalized(groupId);
  const warnings = { ...current.warnings };
  delete warnings[participant];
  settings[groupId] = { ...current, warnings };
  await persist();
}
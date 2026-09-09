import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(rootDir, "..");
export const DATA_DIR = path.resolve(process.env.BOT_DATA_DIR || ROOT_DIR);
export const PORT = Number(process.env.PORT || 8000);
export const BOT_NAME = "SOLVATECH BOT";
export const OWNER_NAME = "SOLVATECHOFFICIAL";
export const PREFIX = ".";
export const SESSION_DIR = path.join(DATA_DIR, "sessions");
export const SETTINGS_FILE = path.join(DATA_DIR, "data", "group-settings.json");
export const LOG_FILE = path.join(DATA_DIR, "logs", "bot.log");
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const COMMAND_NAMES = [
  "alive",
  "ping",
  "menu",
  "groupinfo",
  "add",
  "kick",
  "promote",
  "demote",
  "tagall",
  "tagadmin",
  "lock",
  "unlock",
  "anti",
  "sticker",
  "vv",
  "antilink",
  "antibot",
];
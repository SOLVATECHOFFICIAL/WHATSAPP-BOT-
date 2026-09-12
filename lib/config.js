import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(rootDir, "..");

/**
 * ============================================================================
 * RAILWAY / CONTAINER PERSISTENCE ARCHITECTURE NOTES:
 * ============================================================================
 * Currently, WhatsApp Baileys credentials and bot group settings are stored
 * in the local filesystem under:
 *   - SESSION_DIR: `${DATA_DIR}/sessions/session_${userId}` (WhatsApp multi-device auth keys)
 *   - SETTINGS_FILE / DATA: `${DATA_DIR}/data/group-settings-${userId}.json` (Per-user bot settings)
 *   - LOG_FILE: `${DATA_DIR}/logs/bot.log`
 *
 * In standard cloud container deployments like Railway (or Render/Heroku/Fly.io):
 * Containers have ephemeral filesystems. When redeploying or restarting, any local files
 * created during runtime will be wiped unless a Persistent Volume is attached.
 *
 * To deploy reliably on Railway:
 * 1. Attach a Railway Persistent Volume mounted to `/data`
 * 2. Set the environment variable:
 *      BOT_DATA_DIR=/data
 * 3. The application will then automatically place all user sessions (`/data/sessions`)
 *    and group settings (`/data/data`) onto the persistent volume across redeploys.
 * 4. In a multi-instance production cluster, replace useMultiFileAuthState with a database-backed
 *    auth store (such as Firestore or PostgreSQL) to allow horizontal scaling.
 * ============================================================================
 */
export const DATA_DIR = path.resolve(process.env.BOT_DATA_DIR || ROOT_DIR);
export const PORT = 3000;
export const BOT_NAME = "SOLVATECH BOT";
export const OWNER_NAME = "SOLVATECHOFFICIAL";
export const PREFIX = ".";
export const SESSION_DIR = path.join(DATA_DIR, "sessions");
export const SETTINGS_FILE = path.join(DATA_DIR, "data", "group-settings.json");
export const LOG_FILE = path.join(DATA_DIR, "logs", "bot.log");
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const COMMAND_NAMES = [
  "ping",
  "menu",
  "link",
  "tagall",
  "admin",
  "admins",
  "tagadmin",
  "sticker",
  "antisticker",
  "read",
  "open",
  "vv",
  "rd",
  "pin",
  "kick",
  "add",
  "promote",
  "demote",
  "lock",
  "unlock",
  "antilink",
  "antibot",
  "anti",
  "warns",
  "clearwarns",
  "resetwarns",
  "spam",
  "stop",
  "alive",
  "groupinfo",
];
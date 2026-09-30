import fs from "node:fs/promises";
import fsSync from "node:fs";
import pino from "pino";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  WAMessageStubType,
  proto,
} from "@whiskeysockets/baileys";
import { getGroupSettings, addWarning, clearWarning, claimParticipantEvent, releaseParticipantEvent, claimViolationEvent, releaseViolationEvent, getUserPreferences, syncGroupSettingsFromFirestore } from "./database.js";
import path from "node:path";
import { PAIRING_TTL_MS, SESSION_DIR } from "./config.js";
import { createKeyedQueue } from "./queue.js";
import { getContextInfo, getMessageContent, getMessageText, isCommand, isGroup, isStatusMentionMessage, isViewOnceMessage, extractStatusMentionGroupJids, extractStatusMentionSenders, extractStatusMentionCanonicalId, inspectStatusMentionStructure, extractParticipantNumber, extractParticipantJid, jidAliases, messageSenderJids, normalizeNumber, normalizedUser, parseCommand } from "./helpers.js";
import { isAdmin, isOwner, participantJid, resolveManualWarnTarget } from "./permissions.js";
import { logger } from "./logger.js";
import { handleDeletedMessage, handleIncomingViewOnceMessage, recordIncomingMessage } from "./deleted-messages.js";
import { checkNumberLock, lockNumberToUser } from "./number-lock.js";
import { getUserLicenseStatus } from "./license.js";
import { downloadMediaUrl } from "./media.js";
import { stopAllSpamTasks } from "./spam-manager.js";
import {
  evaluateGameAnswer,
  getActiveGame,
  getMetaChatMode,
  getPendingClarification,
  recordChatMessage,
  recordPresenceUpdate,
  removeChatMessageById,
  syncMetaChatsFromFirestore,
} from "./chat-memory.js";

import {
  readFirestoreDocumentRest,
  writeFirestoreDocumentRest,
  deleteFirestoreDocumentRest,
  readFirestoreCollectionRest,
} from "./auth.js";

const SOLVATECH_PUBLIC_LOGO = "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";

// Map of userId -> debounce timer for syncing session files to Firestore
const sessionSyncTimers = new Map();

function isValidRegisteredCredsJson(rawContent) {
  if (!rawContent || typeof rawContent !== "string") return false;
  try {
    const parsed = JSON.parse(rawContent);
    return Boolean(
      parsed &&
      (parsed.me?.id || parsed.registered === true || parsed.account)
    );
  } catch {
    return false;
  }
}

async function restoreSessionFromFirestore(safeUserId, userSessionDir) {
  const credsFile = path.join(userSessionDir, "creds.json");
  if (fsSync.existsSync(credsFile)) {
    try {
      const localRaw = await fs.readFile(credsFile, "utf8");
      if (isValidRegisteredCredsJson(localRaw)) {
        return true;
      }
    } catch {}
  }

  let sessionData = null;
  try {
    const restDoc = await readFirestoreDocumentRest("whatsapp_sessions", safeUserId);
    if (restDoc && restDoc.files) {
      sessionData = restDoc;
    }
  } catch (err) {
    logger.debug(`Firestore REST session read fallback for ${safeUserId}`, err.message);
  }

  if (!sessionData || !sessionData.files || !isValidRegisteredCredsJson(sessionData.files["creds.json"])) {
    return false;
  }

  try {
    await fs.mkdir(userSessionDir, { recursive: true });
    for (const [filename, fileContent] of Object.entries(sessionData.files)) {
      if (typeof fileContent === "string" && filename.endsWith(".json")) {
        const filePath = path.join(userSessionDir, filename);
        await fs.writeFile(filePath, fileContent, "utf8");
      }
    }
    logger.info(`Restored WhatsApp session files from Firestore for user ${safeUserId}`);
    return true;
  } catch (err) {
    logger.warn(`Could not restore WhatsApp session from Firestore for user ${safeUserId}`, err.message);
    return false;
  }
}

async function syncSessionToFirestore(safeUserId, userSessionDir, immediate = false) {
  if (sessionSyncTimers.has(safeUserId)) {
    clearTimeout(sessionSyncTimers.get(safeUserId));
    sessionSyncTimers.delete(safeUserId);
  }

  const runSync = async () => {
    sessionSyncTimers.delete(safeUserId);
    try {
      if (!fsSync.existsSync(userSessionDir)) return;
      const filenames = await fs.readdir(userSessionDir);
      const jsonFiles = filenames.filter((f) => f.endsWith(".json"));
      if (!jsonFiles.includes("creds.json")) return;

      // Prioritize creds.json and app-state-sync files first, then newest session/pre-key files,
      // keeping total payload < 700 KB so Firestore's 1 MB document limit is NEVER exceeded!
      const prioritized = [
        "creds.json",
        ...jsonFiles.filter((f) => f !== "creds.json" && (f.startsWith("app-state-sync") || f.startsWith("session-"))),
        ...jsonFiles.filter((f) => f !== "creds.json" && !f.startsWith("app-state-sync") && !f.startsWith("session-")),
      ];

      const filesMap = {};
      let totalBytes = 0;
      const MAX_BUDGET_BYTES = 700 * 1024;

      for (const filename of prioritized) {
        const filePath = path.join(userSessionDir, filename);
        try {
          const content = await fs.readFile(filePath, "utf8");
          const byteLen = Buffer.byteLength(content, "utf8");
          if (filename !== "creds.json" && totalBytes + byteLen > MAX_BUDGET_BYTES) {
            continue;
          }
          filesMap[filename] = content;
          totalBytes += byteLen;
        } catch {}
      }

      if (filesMap["creds.json"] && isValidRegisteredCredsJson(filesMap["creds.json"])) {
        const payload = {
          updatedAt: new Date().toISOString(),
          fileCount: Object.keys(filesMap).length,
          files: filesMap,
        };
        await writeFirestoreDocumentRest("whatsapp_sessions", safeUserId, payload, null, false).catch(() => {});
      }
    } catch (err) {
      logger.warn(`Failed to sync WhatsApp session to Firestore for user ${safeUserId}`, err.message);
    }
  };

  if (immediate) {
    await runSync();
    return;
  }

  const timer = setTimeout(runSync, 1200);
  sessionSyncTimers.set(safeUserId, timer);
}

async function deleteSessionFromFirestore(safeUserId) {
  if (sessionSyncTimers.has(safeUserId)) {
    clearTimeout(sessionSyncTimers.get(safeUserId));
    sessionSyncTimers.delete(safeUserId);
  }

  try {
    await deleteFirestoreDocumentRest("whatsapp_sessions", safeUserId);
    logger.info(`Deleted WhatsApp session from Firestore for user ${safeUserId}`);
  } catch (err) {
    logger.warn(`Could not delete WhatsApp session from Firestore for user ${safeUserId}`, err.message);
  }
  try {
    await writeFirestoreDocumentRest("whatsapp_sessions", safeUserId, {
      updatedAt: new Date().toISOString(),
      fileCount: 0,
      files: {},
    }, null, false).catch(() => {});
  } catch {}
}

async function prepareMediaPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const normalizeMedia = async (mediaVal) => {
    if (!mediaVal) return mediaVal;

    // 1. If it's already a Buffer, return as-is
    if (Buffer.isBuffer(mediaVal)) {
      return mediaVal;
    }

    // 2. Extract string URL or local path
    let urlOrPath = null;
    if (typeof mediaVal === "string") {
      urlOrPath = mediaVal;
    } else if (typeof mediaVal === "object" && mediaVal.url) {
      urlOrPath = mediaVal.url;
    }

    if (!urlOrPath) return mediaVal;

    // 3. If it's a web URL (http/https)
    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
      try {
        const { buffer } = await downloadMediaUrl(urlOrPath);
        return buffer;
      } catch (err) {
        logger.warn(`Could not download media from URL ${urlOrPath}: ${err.message}`);
        throw err;
      }
    }

    // 4. If it's a local file path
    try {
      if (fsSync.existsSync(urlOrPath)) {
        return await fs.readFile(urlOrPath);
      }
    } catch {}

    // 5. Fallback for solva.webp or logo to public GitHub Pages URL
    if (urlOrPath.includes("solva.webp") || urlOrPath.includes("logo")) {
      try {
        logger.info(`Local file ${urlOrPath} not found on server, downloading from ${SOLVATECH_PUBLIC_LOGO}`);
        const { buffer } = await downloadMediaUrl(SOLVATECH_PUBLIC_LOGO);
        return buffer;
      } catch (err) {
        logger.warn(`Could not download SOLVATECH logo fallback: ${err.message}`);
      }
    }

    return mediaVal;
  };

  const copy = { ...payload };

  try {
    if (copy.image) copy.image = await normalizeMedia(copy.image);
    if (copy.video) copy.video = await normalizeMedia(copy.video);
    if (copy.audio) copy.audio = await normalizeMedia(copy.audio);
    if (copy.document) copy.document = await normalizeMedia(copy.document);
    if (copy.sticker) copy.sticker = await normalizeMedia(copy.sticker);
  } catch (err) {
    logger.error("Failed to prepare media payload for WhatsApp", err.message || err);
  }

  return copy;
}

// Import all commands
import alive from "../commands/alive.js";
import ping from "../commands/ping.js";
import uptime from "../commands/uptime.js";
import owner from "../commands/owner.js";
import menu from "../commands/menu.js";
import groupinfo from "../commands/groupinfo.js";
import profile from "../commands/profile.js";
import expire from "../commands/expire.js";
import add from "../commands/add.js";
import kick from "../commands/kick.js";
import promote from "../commands/promote.js";
import demote from "../commands/demote.js";
import tagall from "../commands/tagall.js";
import admin from "../commands/admin.js";
import lock from "../commands/lock.js";
import unlock from "../commands/unlock.js";
import anti from "../commands/anti.js";
import sticker from "../commands/sticker.js";
import antisticker from "../commands/antisticker.js";
import read from "../commands/read.js";
import open from "../commands/open.js";
import rd from "../commands/rd.js";
import pin from "../commands/pin.js";
import spam from "../commands/spam.js";
import stop from "../commands/stop.js";
import link from "../commands/link.js";
import send from "../commands/send.js";
import share from "../commands/share.js";
import warn from "../commands/warn.js";
import warns from "../commands/warns.js";
import clearwarns from "../commands/clearwarns.js";
import resetwarns from "../commands/resetwarns.js";
import welcome from "../commands/welcome.js";
import goodbye from "../commands/goodbye.js";
import meta from "../commands/meta.js";

const commands = new Map([
  ["meta", meta],
  ["metaai", meta],
  ["ai", meta],
  ["start", (ctx) => meta({ ...ctx, text: `start ${ctx.text || "meta"}` })],
  ["private", (ctx) => meta({ ...ctx, text: "private meta" })],
  ["public", (ctx) => meta({ ...ctx, text: "public meta" })],
  ["alive", alive],
  ["restart", alive],
  ["ping", ping],
  ["status", ping],
  ["uptime", uptime],
  ["runtime", uptime],
  ["owner", owner],
  ["developer", owner],
  ["menu", menu],
  ["help", menu],
  ["commands", menu],
  ["share", share],
  ["link", link],
  ["groupinfo", groupinfo],
  ["info", groupinfo],
  ["group", groupinfo],
  ["profile", profile],
  ["whois", profile],
  ["user", profile],
  ["expire", expire],
  ["expiry", expire],
  ["license", expire],
  ["add", add],
  ["kick", kick],
  ["promote", promote],
  ["demote", demote],
  ["tagall", tagall],
  ["admin", admin],
  ["admins", admin],
  ["tagadmin", admin],
  ["lock", lock],
  ["unlock", unlock],
  ["anti", anti],
  ["antilink", anti],
  ["antibot", anti],
  ["antistatus", anti],
  ["antistatusmention", anti],
  ["warn", warn],
  ["warns", warns],
  ["warnings", warns],
  ["clearwarns", clearwarns],
  ["clearwarn", clearwarns],
  ["resetwarns", resetwarns],
  ["resetwarn", resetwarns],
  ["welcome", welcome],
  ["autowelcome", welcome],
  ["goodbye", goodbye],
  ["autogoodbye", goodbye],
  ["sticker", sticker],
  ["s", sticker],
  ["antisticker", antisticker],
  ["read", read],
  ["ocr", read],
  ["open", open],
  ["vv", open],
  ["viewonce", open],
  ["rd", rd],
  [".", rd],
  ["", rd],
  ["pin", pin],
  ["spam", spam],
  ["stop", stop],
  ["send", send],
]);

function cleanCode(code) {
  return String(code || "").replace(/[\s-]/g, "").toUpperCase();
}

function getDisconnectCode(error) {
  return error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode ?? null;
}

function describeSocketError(error, fallback = "Connection closed") {
  const code = getDisconnectCode(error);
  const message = String(error?.message || fallback);
  return {
    code,
    message: code ? `WhatsApp pairing socket closed (status ${code}): ${message}` : message,
  };
}

const globalPairingEvents = [];
const MAX_GLOBAL_PAIRING_EVENTS = 150;

function recordGlobalPairingEvent(event) {
  const entry = {
    id: `pair_ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...event,
  };
  globalPairingEvents.unshift(entry);
  if (globalPairingEvents.length > MAX_GLOBAL_PAIRING_EVENTS) {
    globalPairingEvents.pop();
  }
  return entry;
}

function classifyPairingFailure(errorInfo = {}, context = {}) {
  const rawMsg = String(errorInfo.message || "").toLowerCase();
  const code = errorInfo.code;
  const elapsedMs = context.startedAt ? Date.now() - context.startedAt : 0;
  const stageFailed = context.handshakeReceived ? 5 : (context.stage || 3);

  const withCompatFields = (diag) => ({
    ...diag,
    code: diag.diagnosticCode,
    detail: `${diag.summary} ${diag.rootCause || ""}`.trim(),
    stageFailed,
  });

  if (code === "NUMBER_LOCKED_TO_ANOTHER_ACCOUNT" || code === "ACCOUNT_LOCKED_TO_DIFFERENT_NUMBER") {
    return withCompatFields({
      diagnosticCode: "NUMBER_LOCK_CONFLICT",
      title: "Phone Number Lock Conflict",
      summary: errorInfo.message || "This account or WhatsApp number is locked to a different binding.",
      rootCause: "SOLVATECH enforces a 1-number-per-account security lock. You attempted to link a number that does not match your account's locked number.",
      howToFix: [
        "Click '🗑️ Wipe & Change Number' in your Pairing Console to release your current number lock.",
        "Once unlocked, enter your desired WhatsApp number and click 'Get Pairing Code' again.",
      ],
    });
  }

  if (
    context.expired ||
    code === 408 ||
    code === 428 ||
    rawMsg.includes("timed out") ||
    rawMsg.includes("qr refs attempts ended") ||
    (elapsedMs > 85000 && !context.handshakeReceived)
  ) {
    return withCompatFields({
      diagnosticCode: "TIMEOUT_USER_DELAY",
      title: "Pairing Code Expired — Entered Too Late or Handshake Timed Out",
      summary: "You did not finish entering the 8-character code on WhatsApp before the pairing window closed, or your phone took too long to respond.",
      rootCause: "Reason #4 (Network / Input Timeout): WhatsApp's pairing WebSocket only waits ~60–90 seconds for your mobile phone to submit the 8-character code and complete key exchange.",
      howToFix: [
        "Open WhatsApp > Linked Devices > Link with phone number FIRST so the code entry screen is ready on your phone.",
        "Click '🧹 Clear Bugs & Cache' below, then click 'Get Pairing Code' and type the 8 characters immediately (within 30 seconds).",
        "Ensure your phone is on stable Wi-Fi or strong 4G/5G with Battery Saver and Data Saver turned OFF.",
      ],
    });
  }

  if (rawMsg.includes("405") || code === 405 || rawMsg.includes("multi-device") || rawMsg.includes("companion") || rawMsg.includes("limit")) {
    return withCompatFields({
      diagnosticCode: "MULTI_DEVICE_LIMIT",
      title: "WhatsApp 4-Device Companion Limit or Sync Overload",
      summary: "Meta rejected the companion link because your WhatsApp account has reached the maximum 4 linked devices or has a heavy chat backup backlog.",
      rootCause: "Reason #1 (Multi-Device Companion Limit): WhatsApp allows at most 4 linked devices per phone number. Or your phone is stuck encrypting a huge chat history bundle.",
      howToFix: [
        "Open WhatsApp on your phone > Settings > Linked Devices.",
        "Log out / remove any old or inactive linked devices (WhatsApp Web, Desktop, or old bots).",
        "If WhatsApp is currently running a Google Drive / iCloud chat backup, pause or cancel it while linking.",
        "Click '🧹 Clear Bugs & Cache' and request a fresh pairing code.",
      ],
    });
  }

  if (code === 401 || code === 403 || rawMsg.includes("forbidden") || rawMsg.includes("rejected") || rawMsg.includes("unauthorized")) {
    return withCompatFields({
      diagnosticCode: "META_ACCOUNT_RESTRICTION",
      title: "Meta Companion Restriction or Unofficial WhatsApp App",
      summary: "WhatsApp's authentication server refused to sign the companion device registration for this number.",
      rootCause: "Reason #2 / #3 (Modded Client or Account Flag): Using GBWhatsApp/FMWhatsApp/clones, or Meta placed a temporary companion-linking cooldown on this number.",
      howToFix: [
        "Verify you are using the official WhatsApp or WhatsApp Business app from the Play Store / App Store (not GBWhatsApp or modded clones).",
        "Remove any old linked devices under WhatsApp > Linked Devices.",
        "Wait 2–3 minutes, click '🧹 Clear Bugs & Cache', and generate a fresh pairing code.",
      ],
    });
  }

  if (code === 500 || rawMsg.includes("bad mac") || rawMsg.includes("key") || rawMsg.includes("decrypt") || rawMsg.includes("noise")) {
    return withCompatFields({
      diagnosticCode: "STALE_KEY_MISMATCH",
      title: "Cryptographic Key Mismatch (Auto-Cleaned)",
      summary: "Leftover session keys from an interrupted attempt conflicted with the new pairing handshake. The system has automatically purged the stale cache.",
      rootCause: "Reason #5 (Stale Cryptographic Keys): A previous incomplete attempt left partial Noise/Signal keys on disk that did not match the new 8-digit seed.",
      howToFix: [
        "Click '🧹 Clear Bugs & Cache' to ensure a 100% clean cryptographic slate.",
        "Click 'Get Pairing Code' again — your next code will use brand-new keys.",
      ],
    });
  }

  return withCompatFields({
    diagnosticCode: "NETWORK_SOCKET_DROP",
    title: "Network Socket Drop During Handshake",
    summary: errorInfo.message || "The connection between your phone, Meta's servers, and the bot dropped while linking (stuck on 'Logging in…').",
    rootCause: "Reason #4 (Network Latency & Sync Drop): Your phone lost connection or timed out while encrypting and transmitting the companion registration packet.",
    howToFix: [
      "Switch your phone to a stable Wi-Fi or fast mobile data connection and turn off any VPN.",
      "Open WhatsApp > Linked Devices and unlink any stuck 'Chrome (Ubuntu)' or inactive device entries.",
      "Click '🧹 Clear Bugs & Cache' below, then request a new pairing code and enter it right away.",
    ],
  });
}

export function createWhatsAppController(options = {}) {
  const userId = options.userId || "default";
  let verifiedUid = options.verifiedUid || options.userId || "";
  let userEmail = options.userEmail || "";
  const userSessionDir = options.sessionDir || (options.userId ? path.join(SESSION_DIR, options.userId) : SESSION_DIR);
  let sock = null;
  let intentionalDisconnect = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let nextScheduledRetryTime = null;
  let nextScheduledDelayMs = 0;
  let successfulReconnectsCount = 0;
  let failedReconnectsCount = 0;
  let lastReconnectSuccessTime = null;
  let pairingCode = "";
  let pairingExpiresAt = 0;
  let pairingNumber = "";
  let lastError = "";
  let lastErrorCode = null;
  let state = "idle";
  let botNumber = "";
  let connecting = null;
  let pairingRequest = null;
  let pairingReady = null;
  let sessionRegistered = false;
  const messageQueue = createKeyedQueue();

  // Activity, Session and Reconnection State Tracking
  let connectedAt = null;
  let lastActive = null;
  let disconnectedAt = null;

  function recordActivity() {
    lastActive = new Date().toISOString();
  }

  // Auto-Reconnection Attempt Log storage (circular buffer, max 100 entries)
  const reconnectLogs = [];
  const MAX_RECONNECT_LOGS = 100;

  // Live 6-Stage Pairing Inspector & Diagnostics State (Visible to User & Super Admin)
  let pairingInspector = {
    active: false,
    stage: 0, // 0=Idle, 1=Socket, 2=CodeReady, 3=WaitingUser, 4=HandshakeReceived, 5=Registering515, 6=Connected
    stageId: "IDLE",
    stageLabel: "Ready to Pair",
    stageDetail: "Enter your WhatsApp phone number and click Get Pairing Code to start.",
    status: "idle", // "idle" | "in_progress" | "waiting_user" | "handshake" | "connected" | "failed"
    phone: "",
    code: "",
    startedAt: null,
    updatedAt: null,
    expiresAt: null,
    handshakeReceived: false,
    stagesHistory: [],
    failureDiagnostic: null,
  };

  function updatePairingInspector(patch = {}) {
    const nowIso = new Date().toISOString();
    const prevStage = pairingInspector.stage;
    const merged = {
      ...pairingInspector,
      ...patch,
      updatedAt: nowIso,
    };
    if (patch.stageDetail && !patch.whatIsHappening) {
      merged.whatIsHappening = patch.stageDetail;
    }
    if (patch.stageLabel && !patch.statusIndicator) {
      merged.statusIndicator =
        merged.status === "connected"
          ? "🟢 Device Linked"
          : merged.status === "handshake"
            ? "🔵 Handshake Active"
            : merged.status === "waiting_user"
              ? "🟡 Enter Code on Phone"
              : merged.status === "failed"
                ? "🔴 Failed"
                : "🟡 In Progress";
    }
    pairingInspector = merged;
    if (patch.stage && patch.stage !== prevStage) {
      const hist = Array.isArray(pairingInspector.stagesHistory) ? [...pairingInspector.stagesHistory] : [];
      hist.push({
        stage: patch.stage,
        stageId: patch.stageId || pairingInspector.stageId,
        label: patch.stageLabel || pairingInspector.stageLabel,
        detail: patch.stageDetail || pairingInspector.stageDetail,
        timestamp: nowIso,
      });
      pairingInspector.stagesHistory = hist.slice(-12);
    }
    recordGlobalPairingEvent({
      userId,
      verifiedUid: verifiedUid || userId,
      userEmail: userEmail || "",
      phone: pairingInspector.phone || pairingNumber || botNumber || "",
      stage: pairingInspector.stage,
      stageId: pairingInspector.stageId,
      stageLabel: pairingInspector.stageLabel,
      stageDetail: pairingInspector.stageDetail,
      status: pairingInspector.status,
      diagnostic: pairingInspector.failureDiagnostic || null,
    });
  }

  // Device Battery Telemetry State
  let battery = {
    level: 100,
    isCharging: false,
    charging: false,
    powersave: false,
    updatedAt: new Date().toISOString(),
    status: "good",
    available: false,
  };

  function addReconnectLog(entry = {}) {
    const now = new Date();
    const logItem = {
      id: `recon_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: now.toISOString(),
      timeFormatted: now.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      }),
      timeMs: now.getTime(),
      attempt: entry.attempt ?? reconnectAttempt,
      type: entry.type || "AUTO_RECONNECT",
      reason: entry.reason || "Automatic reconnect trigger",
      statusCode: entry.statusCode ?? null,
      delayMs: entry.delayMs ?? 0,
      status: entry.status || "IN_PROGRESS", // "SCHEDULED", "IN_PROGRESS", "SUCCESS", "FAILED", "DISCONNECTED"
      botNumber: botNumber || pairingNumber || "",
      batteryLevel: battery.level,
      battery: { ...battery },
      message: entry.message || entry.reason || "Automatic reconnect event",
    };

    reconnectLogs.unshift(logItem);
    if (reconnectLogs.length > MAX_RECONNECT_LOGS) {
      reconnectLogs.pop();
    }
    return logItem;
  }

  function updateBatteryTelemetry(attrs = {}) {
    recordActivity();
    const rawVal = attrs.value !== undefined ? parseInt(attrs.value, 10) : undefined;
    const isCharging = attrs.live === "true" || attrs.live === "1" || attrs.charging === "true" || attrs.charging === true;
    const powersave = attrs.powersave === "true" || attrs.powersave === "1" || attrs.powersave === true;
    
    let level = battery.level;
    if (rawVal !== undefined && !isNaN(rawVal)) {
      level = Math.max(0, Math.min(100, rawVal));
    }

    battery = {
      level,
      isCharging: Boolean(isCharging),
      charging: Boolean(isCharging),
      powersave: Boolean(powersave),
      updatedAt: new Date().toISOString(),
      status: level <= 15 ? "critical" : level <= 30 ? "low" : level <= 60 ? "fair" : "good",
      available: true,
    };
  }

  function setUserInfo(info = {}) {
    if (info.verifiedUid) verifiedUid = info.verifiedUid;
    if (info.userEmail) userEmail = info.userEmail;
  }

  function beginPairingReadyWait(timeoutMs = 30000) {
    if (pairingReady) return pairingReady.promise;

    let timeoutId;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    // Attach handler to prevent unhandled rejection crashes
    promise.catch(() => {});

    pairingReady = {
      promise,
      resolve(value) {
        clearTimeout(timeoutId);
        pairingReady = null;
        resolvePromise(value);
      },
      reject(error) {
        clearTimeout(timeoutId);
        pairingReady = null;
        rejectPromise(error);
      },
    };
    timeoutId = setTimeout(() => {
      pairingReady?.reject(new Error("Timed out waiting for WhatsApp to prepare the pairing session."));
    }, timeoutMs);
    return promise;
  }

  function resolvePairingReady() {
    pairingReady?.resolve();
  }

  function rejectPairingReady(error) {
    pairingReady?.reject(error);
  }

  function isSocketTrulyOpen() {
    if (!sock) return false;
    const wsReadyState = sock.ws?.socket?.readyState ?? sock.ws?.readyState;
    return Boolean(sock.ws?.isOpen === true || wsReadyState === 1);
  }

  function status() {
    const expired = pairingExpiresAt > 0 && Date.now() > pairingExpiresAt;
    if (expired) {
      const expiredNum = pairingNumber;
      pairingCode = "";
      pairingExpiresAt = 0;
      pairingNumber = "";
      if (state === "pairing") {
        state = "error";
        const diag = classifyPairingFailure(
          { code: 408, message: "Pairing code timer expired before mobile verification completed." },
          { expired: true, startedAt: pairingRequestStartedAt, handshakeReceived: pairingInspector.handshakeReceived }
        );
        lastError = `${diag.title}: ${diag.summary}`;
        lastErrorCode = diag.diagnosticCode;
        updatePairingInspector({
          active: false,
          status: "failed",
          phone: expiredNum || pairingInspector.phone,
          code: "",
          stageLabel: "Pairing Code Expired (Entered Too Late)",
          stageDetail: diag.summary,
          failureDiagnostic: diag,
        });
      }
    }
    const saved = hasSavedSession();
    const hasIdentity = Boolean(sock?.user?.id || sock?.authState?.creds?.me?.id);
    const trulyConnected = state === "connected" && isSocketTrulyOpen() && hasIdentity;
    const effectiveState = state === "connected" && !trulyConnected ? (saved ? "connecting" : "idle") : state;
    const nextRetryMs = nextScheduledRetryTime ? Math.max(0, new Date(nextScheduledRetryTime).getTime() - Date.now()) : 0;
    const isReconnecting = effectiveState === "connecting" || nextRetryMs > 0;
    const resolvedNumber = botNumber || sock?.user?.id?.split(":")[0]?.split("@")[0] || sock?.authState?.creds?.me?.id?.split(":")[0]?.split("@")[0] || pairingNumber || "";
    return {
      status: effectiveState,
      state: effectiveState,
      connected: trulyConnected,
      botNumber: resolvedNumber,
      phoneNumber: resolvedNumber,
      number: resolvedNumber,
      connectedAt,
      lastActive: lastActive || connectedAt || null,
      disconnectedAt,
      hasSavedSession: saved,
      isRecoverable: saved && effectiveState !== "logged_out" && effectiveState !== "expired",
      isReconnecting,
      pairingCode: pairingCode ? cleanCode(pairingCode) : "",
      pairingCodeExpiresAt: pairingExpiresAt || null,
      pairingNumber,
      lastError,
      lastErrorCode,
      pairingInspector: { ...pairingInspector },
      battery: { ...battery },
      reconnectLogs: reconnectLogs.slice(0, 50),
      reconnectStats: {
        attempt: reconnectAttempt,
        currentAttempt: reconnectAttempt,
        successfulReconnects: successfulReconnectsCount,
        failedReconnects: failedReconnectsCount,
        lastSuccessTime: lastReconnectSuccessTime || connectedAt,
        lastReconnectSuccessTime: lastReconnectSuccessTime || connectedAt,
        nextRetryTime: nextScheduledRetryTime,
        nextScheduledRetryTime,
        nextRetryInMs: nextRetryMs,
        nextScheduledDelayMs,
        botNumber: resolvedNumber,
        isReconnectScheduled: nextRetryMs > 0,
        totalLogsCount: reconnectLogs.length,
      },
    };
  }

  const botSentMessageIds = new Set();
  function markBotSent(id) {
    if (!id) return;
    botSentMessageIds.add(id);
    if (botSentMessageIds.size > 5000) {
      const first = botSentMessageIds.values().next().value;
      botSentMessageIds.delete(first);
    }
  }

  async function handleAntiViolation({
    chatId,
    message,
    sender,
    senderJids = [],
    protectionName,
    reason,
    isStatusMention = false,
    warningDeleteDelayMs = WARNING_NOTICE_DELETE_DELAY_MS,
  }) {
    const currentSession = {
      userId,
      isConnected: () => state === "connected" && Boolean(sock),
      getSocket: () => sock,
      getBotNumber: () => botNumber,
      markBotSent,
    };

    return executeStrictGroupWarning({
      chatId,
      message,
      sender,
      senderJids,
      protectionName,
      reason,
      isStatusMention,
      currentSession,
      botSentMessageIds,
      warningDeleteDelayMs,
    });
  }

  class ParticipantMessageQueue {
    constructor() {
      this.queue = [];
      this.processing = false;
    }

    enqueue(task) {
      this.queue.push(task);
      this.processNext();
    }

    async processNext() {
      if (this.processing || this.queue.length === 0) return;
      this.processing = true;

      while (this.queue.length > 0) {
        const task = this.queue.shift();
        try {
          await task();
        } catch (err) {
          logger.error("Participant queue task execution error:", err.message || err);
        }
        if (this.queue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      }

      this.processing = false;
      if (this.queue.length > 0) {
        this.processNext();
      }
    }
  }

  const participantQueue = new ParticipantMessageQueue();

  async function handleGroupParticipantsUpdate(userId, { id: groupId, participants, action }, sock, botSentMessageIds) {
    if (!groupId || !Array.isArray(participants) || participants.length === 0) return;
    if (action !== "add" && action !== "remove") return;

    const settings = await getGroupSettings(groupId, userId);
    if (action === "add" && !settings.welcome) return;
    if (action === "remove" && !settings.goodbye) return;

    const currentSession = {
      userId,
      isConnected: () => state === "connected" && Boolean(sock),
      getSocket: () => sock,
      getBotNumber: () => botNumber,
      markBotSent,
    };

    // Find all currently connected SOLVATECH BOT sessions whose WhatsApp account is a GROUP ADMIN in this group.
    // Normal group members and non-admin sessions can NEVER be selected.
    const baseAdminSessions = await findEligibleAdminSessionsForGroup(groupId, null, currentSession);
    if (baseAdminSessions.length === 0) {
      // Zero connected admin bot sessions in this group -> strictly send nothing and do not claim
      return;
    }

    const referenceMetadata = baseAdminSessions[0]?.metadata || null;
    const seenParticipantNums = new Set();
    const targets = [];

    for (const rawParticipant of participants) {
      const targetInfo = extractParticipantTargetDetails(rawParticipant, referenceMetadata);
      if (!targetInfo || !targetInfo.userNum || seenParticipantNums.has(targetInfo.userNum)) {
        continue;
      }
      seenParticipantNums.add(targetInfo.userNum);
      targets.push(targetInfo);
    }

    if (targets.length === 0) return;

    for (const targetInfo of targets) {
      // Filter eligible connected admin sessions to strictly exclude the joining/leaving member themselves
      const eligibleAdminsForTarget = baseAdminSessions.filter(
        (adminSess) => !doesSessionMatchParticipant(adminSess, targetInfo)
      );

      if (eligibleAdminsForTarget.length === 0) {
        continue;
      }

      // Select ONE deterministic eligible admin bot session
      const selectedAdmin = eligibleAdminsForTarget[0];

      // Claim the event atomically in Firebase/Firestore so other sessions do not duplicate it
      const claimed = await claimParticipantEvent(groupId, targetInfo.userNum, action, selectedAdmin.userId);
      if (!claimed) {
        continue;
      }

      const { userNum, userJid } = targetInfo;

      sharedParticipantQueue.enqueue(async () => {
        // Order candidate admin sessions starting with the selected admin, followed by any other connected admin sessions for failover
        const freshAdmins = await findEligibleAdminSessionsForGroup(groupId, targetInfo, currentSession);
        const orderedAdmins = [];
        const seenSocks = new Set();

        for (const candidate of [selectedAdmin, ...freshAdmins]) {
          if (!candidate || !candidate.sock || seenSocks.has(candidate.sock)) continue;
          const verified = await verifySessionIsConnectedGroupAdmin(candidate, groupId, targetInfo);
          if (verified) {
            seenSocks.add(verified.sock);
            orderedAdmins.push(verified);
          }
        }

        if (orderedAdmins.length === 0) {
          // Selected admin disconnected/lost admin before processing and no other admin bot is connected
          await releaseParticipantEvent(groupId, userNum, action);
          return;
        }

        let delivered = false;
        for (const adminSession of orderedAdmins) {
          let groupName = "the group";
          try {
            const meta = adminSession.metadata || (await adminSession.sock.groupMetadata(groupId));
            if (meta?.subject) groupName = meta.subject;
          } catch {}

          const messageText =
            action === "add"
              ? [
                  `🎉 *WELCOME* @${userNum}! 👋🏽`,
                  "",
                  `Welcome to *${groupName}*! ❤️`,
                  "",
                  "Please check and follow the group rules.",
                  "",
                  "Enjoy your stay! 🥳",
                ].join("\n")
              : [
                  `👋🏽 *GOODBYE* @${userNum}!`,
                  "",
                  `Thanks for being part of *${groupName}*. ❤️`,
                  "",
                  "Take care and stay blessed!",
                ].join("\n");

          try {
            const sent = await adminSession.sock.sendMessage(groupId, {
              text: messageText,
              mentions: [userJid],
            });
            if (sent?.key?.id) {
              adminSession.markBotSent?.(sent.key.id);
              botSentMessageIds.add(sent.key.id);
            }
            delivered = true;
            break;
          } catch (sendErr) {
            logger.error(
              `Failed to send auto ${action === "add" ? "welcome" : "goodbye"} message via admin session ${adminSession.userId}`,
              sendErr.message || sendErr
            );
          }
        }

        if (!delivered) {
          await releaseParticipantEvent(groupId, userNum, action);
        }
      });
    }
  }

  async function processMessage(message) {
    if (!sock || !message) return;
    const hasPayload = Boolean(
      message.message ||
      message.messageStubType ||
      message.statusMentionMessageInfo ||
      message.isMentionedInStatus ||
      (Array.isArray(message.statusMentions) && message.statusMentions.length > 0)
    );
    if (!hasPayload) return;

    const chatId = message.key?.remoteJid;
    if (!chatId) return;

    // Ignore bot's own generated messages (DDD notifications, command responses, etc.)
    if (message.key?.id && botSentMessageIds.has(message.key.id)) {
      return;
    }

    // Handle real-time participant join/leave stub messages in messages.upsert
    if (message.messageStubType && isGroup(chatId)) {
      const stub = message.messageStubType;
      const isAdd = stub === WAMessageStubType.GROUP_PARTICIPANT_ADD ||
                    stub === WAMessageStubType.GROUP_PARTICIPANT_INVITE ||
                    stub === WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN ||
                    stub === 27 || stub === 31 || stub === 71;
      const isRemove = stub === WAMessageStubType.GROUP_PARTICIPANT_LEAVE ||
                       stub === WAMessageStubType.GROUP_PARTICIPANT_REMOVE ||
                       stub === 32 || stub === 28;

      if (isAdd || isRemove) {
        const action = isAdd ? "add" : "remove";
        const stubParams = message.messageStubParameters || [];
        await handleGroupParticipantsUpdate(userId, { id: chatId, participants: stubParams, action }, sock, botSentMessageIds);
        return;
      }
    }

    const isStatusMentionEvent = isStatusMentionMessage(message, chatId);

    // Record incoming message for 24h recovery or handle protocol delete
    // Never treat a Status Mention notification (e.g. ProtocolMessage type 25) as a REVOKE delete!
    const msgContent = getMessageContent(message);
    const protocolMsg = msgContent?.protocolMessage;
    const isRevokeProtocol = !isStatusMentionEvent && protocolMsg && Boolean(protocolMsg.key?.id) && (
      protocolMsg.type === 0 ||
      protocolMsg.type === "REVOKE" ||
      protocolMsg.type === proto?.Message?.ProtocolMessage?.Type?.REVOKE
    );

    if (isRevokeProtocol) {
      const targetKey = {
        id: protocolMsg.key?.id,
        remoteJid: protocolMsg.key?.remoteJid || message.key?.remoteJid || chatId,
        participant: protocolMsg.key?.participant || message.key?.participant || message.participant,
        fromMe: Boolean(protocolMsg.key?.fromMe ?? message.key?.fromMe),
      };
      removeChatMessageById(targetKey.remoteJid, targetKey.id);
      await handleDeletedMessage(
        userId,
        { targetKey, rawMessage: message, protocolMessage: protocolMsg },
        sock,
        botSentMessageIds,
        { verifiedUid, botNumber }
      );
      return;
    }
    if (message.message) {
      recordChatMessage(userId, message, {
        botNumber,
        ownJid: sock.user?.id || "",
        isBotGenerated: Boolean(message.key?.id && botSentMessageIds.has(message.key.id)),
      });
      const viewOnceMsg = isViewOnceMessage(message);
      if (viewOnceMsg) {
        recordIncomingMessage(userId, message, sock, Boolean(message.key?.fromMe));
      } else {
        const userPrefs = await getUserPreferences(userId, verifiedUid || userId);
        if (userPrefs.deletedMessageRecovery) {
          recordIncomingMessage(userId, message, sock, Boolean(message.key?.fromMe));
        }
      }
    }

    const rawSenderJids = messageSenderJids(message, chatId);
    let mappedPnForSender = "";
    try {
      const lidCandidate = [message.key?.participant, message.key?.remoteJid].find((j) => j && String(j).endsWith("@lid"));
      if (lidCandidate && sock.signalRepository?.lidMapping?.getPNForLID) {
        mappedPnForSender = (await sock.signalRepository.lidMapping.getPNForLID(lidCandidate)) || "";
      }
    } catch {}
    if (mappedPnForSender) {
      rawSenderJids.push(mappedPnForSender);
    }

    const ownJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
      sock.authState?.creds?.me?.id,
      sock.authState?.creds?.me?.lid,
      botNumber ? `${botNumber}@s.whatsapp.net` : "",
      pairingNumber ? `${pairingNumber}@s.whatsapp.net` : "",
    ].filter(Boolean);
    const ownAliases = new Set(ownJids.flatMap(jidAliases));

    const senderIsLinkedAccount = Boolean(message.key?.fromMe) ||
      rawSenderJids.some((jid) => jidAliases(jid).some((alias) => ownAliases.has(alias)));
    const senderJids = message.key?.fromMe
      ? [...new Set([...ownJids, ...rawSenderJids])]
      : rawSenderJids;
    const sender = message.key?.fromMe
      ? normalizedUser(ownJids[0] || senderJids[0] || chatId)
      : normalizedUser(senderJids[0] || chatId);
    const text = getMessageText(message);

    try {
      // 0. Path A: Handle WhatsApp Status Broadcasts (status@broadcast) mentioning protected groups
      if (chatId === "status@broadcast") {
        const mentionedGroups = extractStatusMentionGroupJids(message, "");
        if (mentionedGroups.length > 0) {
          const statusSenderCandidates = extractStatusMentionSenders(message);
          const statusSender = normalizedUser(
            statusSenderCandidates[0] || message.key?.participant || message.participant || ownJids[0] || ""
          );

          for (const targetGroupId of mentionedGroups) {
            logger.info(
              "[Anti-Status-Mention] Path A (status@broadcast) group mention detected",
              inspectStatusMentionStructure(message, targetGroupId)
            );
            const settings = await getGroupSettings(targetGroupId, userId);
            if (settings.antiStatusMention && statusSender) {
              await handleAntiViolation({
                chatId: targetGroupId,
                message,
                sender: statusSender,
                senderJids: statusSenderCandidates,
                protectionName: "Anti-Status-Mention protection",
                reason: "Anti-Status-Mention violation",
                isStatusMention: true,
              });
            }
          }
        }
        return;
      }

      if (isGroup(chatId)) {
        const settings = await getGroupSettings(chatId, userId);

        // 1. Path B: In-group Anti-Status-Mention Protection
        // Checked before generic senderIsAdmin so status-specific sender fields (protocolMessage,
        // statusNotificationMessage, statusMentionSources, contextInfo) are always resolved first.
        if (isStatusMentionEvent) {
          logger.info(
            "[Anti-Status-Mention] Path B (in-group) status mention detected",
            inspectStatusMentionStructure(message, chatId)
          );
          if (settings.antiStatusMention) {
            const statusSenderCandidates = [
              ...new Set(
                [...extractStatusMentionSenders(message), ...senderJids].filter(
                  (j) => j && typeof j === "string" && !j.endsWith("@g.us") && j !== "status@broadcast"
                )
              ),
            ];
            const effectiveStatusSender = normalizedUser(statusSenderCandidates[0] || sender);
            await handleAntiViolation({
              chatId,
              message,
              sender: effectiveStatusSender,
              senderJids: statusSenderCandidates,
              protectionName: "Anti-Status-Mention protection",
              reason: "Anti-Status-Mention violation",
              isStatusMention: true,
            });
            return;
          }
        }

        // Check if sender is an admin before applying Anti-Link and Anti-Bot protections
        let senderIsAdmin = false;
        try {
          const metadata = await sock.groupMetadata(chatId);
          senderIsAdmin = isAdmin(metadata, [sender, ...senderJids]);
        } catch {}

        if (!senderIsAdmin) {
          // 2. Anti-Link Protection
          const linkSourceText = [
            text,
            msgContent?.extendedTextMessage?.matchedText,
            msgContent?.extendedTextMessage?.canonicalUrl,
          ]
            .filter(Boolean)
            .join(" ");
          const hasExternalLink =
            Boolean(linkSourceText) &&
            /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/)[^\s]+/i.test(linkSourceText);
          if (settings.antiLink && hasExternalLink) {
            await handleAntiViolation({
              chatId,
              message,
              sender,
              senderJids,
              protectionName: "Anti-Link protection",
              reason: "Anti-Link violation",
            });
            return;
          }

          // 3. Anti-Bot Protection (Unauthorized automated bot account activity)
          const parsed = parseCommand(text);
          const isOurBotCommand = Boolean((parsed.command && commands.has(parsed.command)) || text.trim() === ".");
          const isBotActivity = !isOurBotCommand && Boolean(text) && /^\s*[.!\/#$][a-zA-Z0-9]/i.test(text);
          if (settings.antiBot && isBotActivity) {
            await handleAntiViolation({
              chatId,
              message,
              sender,
              senderJids,
              protectionName: "Anti-Bot protection",
              reason: "Anti-Bot violation",
            });
            return;
          }
        }
      }

      if (!text || !isCommand(text)) {
        const activeMetaSession = getMetaChatMode(userId, chatId);
        const pendingClarification = getPendingClarification(userId, chatId, sender);
        const lowerPlain = String(text || "").trim().toLowerCase();

        // 1. Check if owner sent a natural non-prefixed Meta control phrase
        const isNaturalOwnerMetaControl =
          senderIsLinkedAccount &&
          Boolean(lowerPlain) &&
          (/^(?:start\s+meta|stop\s+meta|meta\s+on|meta\s+off|private\s+meta|public\s+meta|meta\s+private|meta\s+public|public\s+your\s*self|private\s+your\s*self|make\s+your\s*self\s+public|make\s+your\s*self\s+private|off\s+your\s*self|stop\s+your\s*self|list\s+where\s+you\s+are\s+on|meta\s+list)$/i.test(
            lowerPlain
          ) ||
            /\b(?:meta\s+off\s+all|off\s+all\s+my\s+chats?|stop\s+meta\s+everywhere|check\s+all\s+the\s+places?\s+you\s+are\s+responding)\b/i.test(
              lowerPlain
            ));

        if (isNaturalOwnerMetaControl) {
          const cleanControlPrompt = lowerPlain.replace(/^meta\s+/i, "").trim();
          const reply = (body, options = {}) =>
            typeof body === "string"
              ? sock.sendMessage(chatId, { text: body, ...options })
              : sock.sendMessage(chatId, { ...body, ...options });
          await meta({
            sock,
            message,
            chatId,
            sender,
            senderJids,
            senderIsLinkedAccount,
            args: cleanControlPrompt.split(/\s+/),
            command: "meta",
            text: cleanControlPrompt,
            isContinuousMeta: true,
            startedAt: Date.now(),
            reply,
            userId,
            verifiedUid: verifiedUid || userId,
            userEmail: userEmail || "",
            botNumber: botNumber || sock.user?.id?.split(":")[0]?.split("@")[0] || "",
          });
          return;
        }

        // 2. Check if there is an active interactive clarification waiting for a reply (e.g. country code or pic outfit)
        if (pendingClarification && text && (senderIsLinkedAccount || activeMetaSession?.enabled)) {
          await sock.sendPresenceUpdate("composing", chatId).catch(() => {});
          const reply = (body, options = {}) =>
            typeof body === "string"
              ? sock.sendMessage(chatId, { text: body, ...options })
              : sock.sendMessage(chatId, { ...body, ...options });
          try {
            await meta({
              sock,
              message,
              chatId,
              sender,
              senderJids,
              senderIsLinkedAccount,
              args: text.trim().split(/\s+/),
              command: "meta",
              text: text.trim(),
              isContinuousMeta: true,
              startedAt: Date.now(),
              reply,
              userId,
              verifiedUid: verifiedUid || userId,
              userEmail: userEmail || "",
              botNumber: botNumber || sock.user?.id?.split(":")[0]?.split("@")[0] || "",
            });
          } finally {
            await sock.sendPresenceUpdate("paused", chatId).catch(() => {});
          }
          return;
        }

        // 3. Check if an interactive group game/quiz is active in this chat and evaluate participant's answer
        if (text && getActiveGame(chatId)) {
          const gameClaimId = message.key?.id ? `game_ans_${message.key.id}` : null;
          if (!gameClaimId || await claimViolationEvent(chatId, gameClaimId, sender || "player", userId, 30000, false)) {
            const evalRes = evaluateGameAnswer(chatId, text, sender, message.pushName || "");
            if (evalRes.matched && evalRes.responseText) {
              await sock.sendMessage(chatId, {
                text: evalRes.responseText,
                ...(evalRes.mentions?.length ? { mentions: evalRes.mentions } : {}),
              });
              return;
            }
          }
        }

        // 4. Continuous Meta AI Mode (.meta on — always PUBLIC for all)
        if (activeMetaSession?.enabled) {
          const hasMediaOrText = Boolean(text) || Boolean(msgContent?.imageMessage);

          if (hasMediaOrText) {
            await sock.sendPresenceUpdate("composing", chatId).catch(() => {});
            const reply = (body, options = {}) =>
              typeof body === "string"
                ? sock.sendMessage(chatId, { text: body, ...options })
                : sock.sendMessage(chatId, { ...body, ...options });
            try {
              await meta({
                sock,
                message,
                chatId,
                sender,
                senderJids,
                senderIsLinkedAccount,
                args: (text || "").trim().split(/\s+/).filter(Boolean),
                command: "meta",
                text: (text || "").trim(),
                isContinuousMeta: true,
                startedAt: Date.now(),
                reply,
                userId,
                verifiedUid: verifiedUid || userId,
                userEmail: userEmail || "",
                botNumber: botNumber || sock.user?.id?.split(":")[0]?.split("@")[0] || "",
              });
            } finally {
              await sock.sendPresenceUpdate("paused", chatId).catch(() => {});
            }
          }
        }
        return;
      }

      const { command, args, text: commandText } = parseCommand(text);
      let handler = commands.get(command);
      if (command === "" && text.trim() === ".") {
        handler = rd;
      }
      if (!handler) return;

      // Manual ".warn" in groups is strictly coordinated through connected group-admin bot sessions only.
      // Normal group members can NEVER issue or act as the bot for ".warn".
      if (command === "warn" && isGroup(chatId)) {
        const currentSession = {
          userId,
          isConnected: () => state === "connected" && Boolean(sock),
          getSocket: () => sock,
          getBotNumber: () => botNumber,
          markBotSent,
        };
        await executeManualWarn({
          sock,
          chatId,
          sender,
          senderJids,
          args,
          message,
          userId,
          botNumber,
          currentSession,
          botSentMessageIds,
        });
        return;
      }

      // STRICT OWNER-ONLY COMMAND RESTRICTION:
      // Commands can ONLY be triggered and executed by the linked account / owner of this bot.
      // One bot for one person: nobody else can command, trigger, or control another user's bot.
      if (!senderIsLinkedAccount) {
        return;
      }

      // Prevent a normal group member's bot session from acting on group warning control commands
      if (isGroup(chatId) && ["warns", "warnings", "clearwarns", "clearwarn", "resetwarns", "resetwarn", "anti", "antilink", "antibot", "antistatus", "antistatusmention"].includes(command)) {
        try {
          const meta = await sock.groupMetadata(chatId);
          if (!isAdmin(meta, [sender, ...senderJids, ...ownJids])) {
            return;
          }
        } catch {
          return;
        }
      }

      // FAST RESPONSE SYSTEM:
      // 1. Immediately send the configured processing reaction before expensive operations
      await sock.sendMessage(chatId, {
        react: { text: "⏳", key: message.key },
      }).catch(() => {});

      await sock.sendPresenceUpdate("composing", chatId).catch(() => {});

      const reply = (body, options = {}) => {
        if (typeof body === "string") {
          return sock.sendMessage(chatId, { text: body, ...options });
        }
        return sock.sendMessage(chatId, { ...body, ...options });
      };

      try {
        await handler({
          sock,
          message,
          chatId,
          sender,
          senderJids,
          senderIsLinkedAccount,
          args,
          command,
          text: commandText,
          startedAt: Date.now(),
          reply,
          userId,
          verifiedUid: verifiedUid || userId,
          userEmail: userEmail || "",
          botNumber: botNumber || sock.user?.id?.split(":")[0]?.split("@")[0] || "",
        });

        // Clear or set success reaction on completion (unless handler already reacted & fast-deleted the command message)
        if (!message._alreadyReactedAndDeleted) {
          await sock.sendMessage(chatId, {
            react: { text: "✅", key: message.key },
          }).catch(() => {});
        }
      } catch (err) {
        // Set error reaction without crashing
        await sock.sendMessage(chatId, {
          react: { text: "❌", key: message.key },
        }).catch(() => {});
        throw err;
      } finally {
        await sock.sendPresenceUpdate("paused", chatId).catch(() => {});
        await sock.sendPresenceUpdate("available").catch(() => {});
      }
    } catch (error) {
      logger.error(`Message processing failed for command .${text}`, error.stack || error.message);
      const messageText = String(error.message || "");
      if (isCommand(text)) {
        const { command } = parseCommand(text);
        const reply = (body, options = {}) => sock.sendMessage(chatId, { text: body, ...options });
        await reply(messageText.startsWith("❌") ? messageText : `❌ The .${command} command could not be completed: ${messageText}`);
      }
    }
  }

  function bindSocket(nextSocket, saveCreds) {
    sock = nextSocket;

    // HARD SECURITY GUARD: Disable automatic or unintended WhatsApp profile picture updates
    // The bot must NEVER alter or overwrite the user's personal/linked WhatsApp profile picture.
    nextSocket.updateProfilePicture = async (...args) => {
      logger.warn("Automatic profile-picture update is disabled. Preserving user's original WhatsApp profile picture.");
      return;
    };
    nextSocket.removeProfilePicture = async (...args) => {
      logger.warn("Automatic profile-picture removal is disabled. Preserving user's original WhatsApp profile picture.");
      return;
    };

    const originalSendMessage = nextSocket.sendMessage.bind(nextSocket);
    nextSocket.sendMessage = async (jid, content, options) => {
      let processedContent = content;
      try {
        processedContent = await prepareMediaPayload(content);
      } catch (err) {
        logger.warn("Media preparation error in sendMessage:", err.message);
      }
      const result = await originalSendMessage(jid, processedContent, options);
      recordActivity();
      if (result?.key?.id) {
        markBotSent(result.key.id);
        if (processedContent && !processedContent.delete && !processedContent.react) {
          recordChatMessage(userId, result, {
            fromMe: true,
            botNumber,
            ownJid: nextSocket.user?.id || "",
            isBotGenerated: true,
            textOverride:
              typeof processedContent.text === "string"
                ? processedContent.text
                : typeof processedContent.caption === "string"
                  ? processedContent.caption
                  : "",
          });
        }
      }
      return result;
    };
    // Listen for device battery telemetry from Baileys if transmitted
    try {
      if (sock.ws && typeof sock.ws.on === "function") {
        sock.ws.on("CB:ib,,battery", (node) => {
          try {
            if (node?.attrs) updateBatteryTelemetry(node.attrs);
          } catch {}
        });
      }
      sock.ev.on("CB:ib,,battery", (node) => {
        try {
          if (node?.attrs) updateBatteryTelemetry(node.attrs);
        } catch {}
      });
    } catch {}

    const trackSaveCreds = () => {
      const p = Promise.resolve(saveCreds()).catch((err) => {
        logger.warn("saveCreds warning", err?.message || err);
      });
      inFlightCredsSave = p;
      return p;
    };

    sock.ev.on("creds.update", async () => {
      recordActivity();
      const credsNow = nextSocket.authState?.creds;
      if (credsNow?.me && !credsNow.me.name) {
        credsNow.me.name = credsNow.me.verifiedName || nextSocket.user?.name || "~";
      }
      await trackSaveCreds();
      if (credsNow?.account && credsNow?.me?.id) {
        sessionRegistered = true;
        const extractedNum = credsNow.me.id.split(":")[0].split("@")[0];
        if (extractedNum && !botNumber) {
          botNumber = extractedNum;
        }
        if (pairingInspector.active && pairingInspector.stage < 4) {
          updatePairingInspector({
            stage: 4,
            stageId: "STAGE_4_HANDSHAKE",
            stageLabel: "Stage 4/6: Handshake Received",
            stageDetail: "WhatsApp mobile submitted the pairing verification packet (link_code_companion_reg).",
            status: "handshake",
            handshakeReceived: true,
          });
        }
        void syncSessionToFirestore(userId, userSessionDir, true);
      } else {
        void syncSessionToFirestore(userId, userSessionDir, false);
      }
    });
    sock.ev.on("messaging-history.set", ({ messages: historyMessages = [] }) => {
      try {
        for (const msg of historyMessages) {
          if (msg?.message && msg?.key?.remoteJid) {
            recordChatMessage(userId, msg, {
              botNumber,
              ownJid: sock.user?.id || "",
              isHistorical: true,
            });
          }
        }
      } catch {}
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      recordActivity();
      for (const message of messages) {
        if (message?.key?.id && message?.message) {
          recentRawMessagesCache.set(message.key.id, message.message);
          if (recentRawMessagesCache.size > 400) {
            const oldestKey = recentRawMessagesCache.keys().next().value;
            if (oldestKey) recentRawMessagesCache.delete(oldestKey);
          }
        }
        if (type === "append") {
          const rawTs = Number(message?.messageTimestamp || 0);
          const msgTimeMs = rawTs > 0 ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.now();
          const textCandidate = getMessageText(message);
          const isRecentCmd = isCommand(textCandidate) && Date.now() - msgTimeMs <= 180000;
          if (!isRecentCmd && Date.now() - msgTimeMs > 60000) {
            if (message?.message && message?.key?.remoteJid) {
              recordChatMessage(userId, message, {
                botNumber,
                ownJid: sock.user?.id || "",
                isHistorical: true,
              });
            }
            continue;
          }
        }
        messageQueue.add(message.key?.remoteJid, () => processMessage(message)).catch((error) => {
          logger.error("Queued message failed", error.stack || error.message);
        });
      }
    });
    sock.ev.on("messages.update", (updates) => {
      recordActivity();
      for (const update of updates) {
        const isRevokeUpdate =
          update.update?.messageStubType === WAMessageStubType?.REVOKE ||
          update.update?.messageStubType === 1 ||
          update.update?.messageStubType === "REVOKE" ||
          update.update?.messageStubType === 132 ||
          update.update?.messageStubType === "ADMIN_REVOKE" ||
          (update.update?.protocolMessage && (
            update.update.protocolMessage.type === 0 ||
            update.update.protocolMessage.type === "REVOKE" ||
            update.update.protocolMessage.type === proto?.Message?.ProtocolMessage?.Type?.REVOKE
          ));

        if (isRevokeUpdate) {
          const targetKey = {
            id: update.key?.id || update.update?.key?.id,
            remoteJid: update.key?.remoteJid || update.update?.key?.remoteJid || "",
            participant: update.key?.participant || update.update?.key?.participant || "",
            fromMe: Boolean(update.key?.fromMe ?? update.update?.key?.fromMe),
          };
          const targetChat = targetKey.remoteJid || update.key?.remoteJid;
          if (targetChat) {
            messageQueue.add(
              targetChat,
              () => handleDeletedMessage(userId, { targetKey, update }, sock, botSentMessageIds, { verifiedUid, botNumber })
            ).catch((error) => {
              logger.error("Queued deleted update failed", error.stack || error.message);
            });
          }
        } else if (update.update && update.key?.remoteJid) {
          const mergedMsg = { key: update.key, ...update.update };
          if (isStatusMentionMessage(mergedMsg, update.key.remoteJid)) {
            messageQueue.add(update.key.remoteJid, () => processMessage(mergedMsg)).catch((error) => {
              logger.error("Queued status mention update failed", error.stack || error.message);
            });
          }
        }
      }
    });

    sock.ev.on("group-participants.update", async (update) => {
      recordActivity();
      try {
        await handleGroupParticipantsUpdate(userId, update, sock, botSentMessageIds);
      } catch (err) {
        logger.error("Group participants update handler error", err.message || err);
      }
    });
    sock.ev.on("presence.update", ({ id, presences }) => {
      try {
        if (!id || !presences || typeof presences !== "object") return;
        for (const [pJid, pData] of Object.entries(presences)) {
          if (pJid && pData?.lastKnownPresence) {
            recordPresenceUpdate(id, pJid, pData.lastKnownPresence);
          }
        }
      } catch {}
    });
    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications }) => {
      // Wait strictly for Baileys' pair-device QR signal (or an open session)
      // which only fires AFTER validateConnection() completes the Noise handshake
      // in companion-registration mode. Resolving earlier corrupts pairing.
      if (qr || connection === "open") {
        resolvePairingReady();
      }

      if (receivedPendingNotifications) {
        try {
          if (nextSocket.authState?.creds?.me && !nextSocket.authState.creds.me.name) {
            nextSocket.authState.creds.me.name = nextSocket.authState.creds.me.verifiedName || nextSocket.user?.name || "~";
          }
          nextSocket.ev?.flush?.();
          nextSocket.sendPresenceUpdate("available").catch(() => {});
        } catch {}
      }

      // WhatsApp emits isNewLogin after pair-success and then intentionally
      // closes the socket with status 515 so it can reconnect authenticated.
      if (isNewLogin) {
        sessionRegistered = true;
        lastError = "";
        lastErrorCode = null;
        const newNum = nextSocket.authState?.creds?.me?.id?.split(":")[0]?.split("@")[0] || pairingNumber || botNumber;
        if (newNum) botNumber = newNum;
        if (nextSocket.authState?.creds?.me && !nextSocket.authState.creds.me.name) {
          nextSocket.authState.creds.me.name = "~";
        }
        updatePairingInspector({
          active: true,
          stage: 4,
          stageId: "STAGE_4_HANDSHAKE",
          stageLabel: "Stage 4/6: Mobile Handshake Verified",
          stageDetail: "Phone accepted the 8-digit pairing code. Preparing device registration...",
          status: "handshake",
          handshakeReceived: true,
          failureDiagnostic: null,
        });
        void trackSaveCreds().then(() => syncSessionToFirestore(userId, userSessionDir, true)).catch(() => {});
        addReconnectLog({
          type: "PAIRING_SUCCESS",
          reason: "New WhatsApp pairing established",
          status: "SUCCESS",
          message: "Pairing code verified. Reconnecting authenticated session...",
        });
      }

      if (connection === "open") {
        const wasReconnect = reconnectAttempt > 0;
        if (wasReconnect) {
          successfulReconnectsCount += 1;
        }
        reconnectAttempt = 0;
        nextScheduledRetryTime = null;
        nextScheduledDelayMs = 0;
        lastReconnectSuccessTime = new Date().toISOString();
        connectedAt = new Date().toISOString();
        lastActive = new Date().toISOString();
        disconnectedAt = null;
        sessionRegistered = true;
        state = "connected";
        botNumber =
          nextSocket.user?.id?.split(":")[0]?.split("@")[0] ||
          nextSocket.authState?.creds?.me?.id?.split(":")[0]?.split("@")[0] ||
          pairingNumber ||
          botNumber ||
          "";
        lastError = "";
        lastErrorCode = null;
        pairingCode = "";
        pairingExpiresAt = 0;
        pairingNumber = "";

        // Ensure me.name is present so Baileys sendPresenceUpdate("available") never skips sending <presence type="available"/>
        if (nextSocket.authState?.creds?.me && !nextSocket.authState.creds.me.name) {
          nextSocket.authState.creds.me.name = nextSocket.authState.creds.me.verifiedName || nextSocket.user?.name || "~";
        }
        try {
          nextSocket.ev?.flush?.();
          nextSocket.sendPresenceUpdate("available").catch(() => {});
          setTimeout(() => {
            try {
              if (sock === nextSocket) {
                nextSocket.ev?.flush?.();
                nextSocket.sendPresenceUpdate("available").catch(() => {});
              }
            } catch {}
          }, 1500);
        } catch {}

        updatePairingInspector({
          active: false,
          stage: 6,
          stageId: "STAGE_6_CONNECTED",
          stageLabel: "Stage 6/6: Device Linked & Online",
          stageDetail: `WhatsApp companion handshake verified and sealed for +${botNumber || "your number"}. Bot is online!`,
          status: "connected",
          phone: botNumber || pairingInspector.phone,
          code: "",
          handshakeReceived: true,
          failureDiagnostic: null,
        });
        logger.info("WhatsApp connection opened", botNumber);
        void trackSaveCreds().then(() => syncSessionToFirestore(userId, userSessionDir, true)).catch(() => {});

        addReconnectLog({
          type: wasReconnect ? "RECONNECT_SUCCESS" : "CONNECTED",
          reason: wasReconnect ? "Automatic reconnection established" : "WhatsApp connection opened",
          status: "SUCCESS",
          message: `Bot online and ready on +${botNumber || "WhatsApp"}`,
        });

        // Ensure all group setups and meta chat configurations are synced authoritatively from Firebase Firestore
        syncGroupSettingsFromFirestore(true).catch(() => {});
        syncMetaChatsFromFirestore().catch(() => {});

        // Verify permanent WhatsApp number lock
        if (botNumber && verifiedUid) {
          const currentUid = verifiedUid;
          const currentEmail = userEmail;
          checkNumberLock(botNumber, currentUid, currentEmail).then((lockCheck) => {
            if (!lockCheck.allowed) {
              logger.warn(`Rejecting WhatsApp connection for ${botNumber}: ${lockCheck.message}`);
              intentionalDisconnect = true;
              try { nextSocket.ws?.close(); } catch {}
              sock = null;
              state = "error";
              lastError = lockCheck.message;
              lastErrorCode = lockCheck.reason;
              addReconnectLog({
                type: "LOCK_REJECTED",
                reason: lockCheck.message,
                statusCode: 403,
                status: "FAILED",
                message: lockCheck.message,
              });
            } else {
              lockNumberToUser(botNumber, currentUid, currentEmail).catch((err) => {
                logger.error("Failed to store number lock", err.message);
              });
            }
          }).catch((err) => {
            logger.error("Number lock check error", err.message);
          });
        }
      }
      if (connection === "connecting") {
        if (state !== "pairing") {
          state = "connecting";
        }
      }
      if (connection === "close") {
        disconnectedAt = new Date().toISOString();
        stopAllSpamTasks();
        if (sock !== nextSocket) return;
        const errorInfo = describeSocketError(lastDisconnect?.error);
        const wasIntentional = intentionalDisconnect;
        const isExpired = state === "expired";
        const isRestartRequired = errorInfo.code === DisconnectReason.restartRequired || errorInfo.code === 515;
        const isLoggedOut = errorInfo.code === DisconnectReason.loggedOut || errorInfo.code === 401;
        const isReplaced = errorInfo.code === DisconnectReason.connectionReplaced || errorInfo.code === 440;
        const saved = hasSavedSession();
        const hasAnyCreds = Boolean(nextSocket?.authState?.creds?.me?.id || nextSocket?.authState?.creds?.registered || nextSocket?.authState?.creds?.account || saved);
        const pairingFailed = !isRestartRequired && !sessionRegistered && !hasAnyCreds && (state === "pairing" || Boolean(pairingRequest));

        // If device was explicitly unlinked/loggedOut (401) from phone, clean up dead credentials
        // so we do not loop forever faking an active/reconnecting session.
        if (isLoggedOut && !wasIntentional && !isExpired && !isRestartRequired) {
          sessionRegistered = false;
          botNumber = "";
          pairingCode = "";
          pairingExpiresAt = 0;
          pairingNumber = "";
          (async () => {
            try {
              await fs.rm(userSessionDir, { recursive: true, force: true });
              await fs.mkdir(userSessionDir, { recursive: true });
              await deleteSessionFromFirestore(userId);
            } catch {}
          })();
        }

        const shouldReconnect =
          !wasIntentional &&
          !isExpired &&
          !isLoggedOut &&
          !isReplaced &&
          (isRestartRequired || sessionRegistered || saved);

        state = isExpired
          ? "expired"
          : wasIntentional
            ? "idle"
            : isLoggedOut
              ? "logged_out"
              : (pairingFailed || !shouldReconnect)
                ? "error"
                : "connecting";

        if (isRestartRequired) {
          pairingCode = "";
          pairingExpiresAt = 0;
          pairingNumber = "";
          lastError = "";
          lastErrorCode = null;
          updatePairingInspector({
            active: true,
            stage: 5,
            stageId: "STAGE_5_REGISTERING",
            stageLabel: "Stage 5/6: Finalizing Companion Registration (515)",
            stageDetail: "Handshake accepted by Meta servers (status 515). Restarting authenticated socket...",
            status: "handshake",
            handshakeReceived: true,
            failureDiagnostic: null,
          });
        } else if (isLoggedOut) {
          lastError = "WhatsApp session was unlinked from your phone. Please generate a new pairing code to link again.";
          lastErrorCode = 401;
          if (pairingInspector.active || pairingFailed) {
            const diag = classifyPairingFailure(
              { code: 401, message: lastError },
              { startedAt: pairingRequestStartedAt, handshakeReceived: pairingInspector.handshakeReceived }
            );
            updatePairingInspector({
              active: false,
              status: "failed",
              stageLabel: diag.title,
              stageDetail: diag.summary,
              failureDiagnostic: diag,
            });
          }
        } else {
          lastError = wasIntentional ? "" : errorInfo.message;
          lastErrorCode = wasIntentional ? null : errorInfo.code;
          if (pairingFailed && !wasIntentional) {
            const diag = classifyPairingFailure(errorInfo, {
              startedAt: pairingRequestStartedAt,
              handshakeReceived: pairingInspector.handshakeReceived,
            });
            lastError = `${diag.title}: ${diag.summary}`;
            lastErrorCode = diag.diagnosticCode;
            updatePairingInspector({
              active: false,
              status: "failed",
              stageLabel: diag.title,
              stageDetail: diag.summary,
              failureDiagnostic: diag,
            });
            // Automatically purge half-written unauthenticated session files so Reason #5 never blocks next attempt
            (async () => {
              try {
                await fs.rm(userSessionDir, { recursive: true, force: true });
                await fs.mkdir(userSessionDir, { recursive: true });
              } catch {}
            })();
          }
        }

        if (!wasIntentional) logger.warn("WhatsApp connection closed", `${errorInfo.code || "unknown"} ${errorInfo.message}`);
        rejectPairingReady(new Error(errorInfo.message));
        sock = null;

        if (shouldReconnect) {
          reconnectAttempt += 1;
          const delay = isRestartRequired
            ? 800
            : reconnectAttempt <= 3
              ? 1500
              : Math.min(5000, 1500 + reconnectAttempt * 500);
          nextScheduledDelayMs = delay;
          nextScheduledRetryTime = new Date(Date.now() + delay).toISOString();
          logger.warn("Scheduling instant WhatsApp reconnect", `${delay}ms (attempt #${reconnectAttempt})`);

          addReconnectLog({
            type: isRestartRequired ? "RESTART_REQUIRED" : "RECONNECT_SCHEDULED",
            reason: isRestartRequired ? "Handshake complete (515 restart required)" : (errorInfo.message || `Socket closed (status ${errorInfo.code})`),
            statusCode: errorInfo.code,
            delayMs: delay,
            attempt: reconnectAttempt,
            status: "SCHEDULED",
            message: isRestartRequired
              ? "WhatsApp handshake complete. Reconnecting in 0.8s..."
              : `Socket closed (${errorInfo.code || "unknown"}). Auto-reconnecting attempt #${reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`,
          });

          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(async () => {
            if (inFlightCredsSave) {
              await inFlightCredsSave.catch(() => {});
            }
            addReconnectLog({
              type: "RECONNECT_EXECUTING",
              reason: `Executing reconnect attempt #${reconnectAttempt}`,
              attempt: reconnectAttempt,
              status: "IN_PROGRESS",
              message: `Reconnection attempt #${reconnectAttempt} in progress...`,
            });
            void connect();
          }, delay);
        } else if (wasIntentional) {
          nextScheduledRetryTime = null;
          nextScheduledDelayMs = 0;
          addReconnectLog({
            type: "INTENTIONAL_DISCONNECT",
            reason: "User requested disconnect",
            status: "DISCONNECTED",
            message: "WhatsApp session disconnected intentionally.",
          });
        } else if (isLoggedOut) {
          failedReconnectsCount += 1;
          nextScheduledRetryTime = null;
          nextScheduledDelayMs = 0;
          addReconnectLog({
            type: "LOGGED_OUT",
            reason: "WhatsApp device was unlinked from phone (401)",
            statusCode: 401,
            status: "FAILED",
            message: "Device unlinked from WhatsApp mobile app. Ready to pair again.",
          });
        } else {
          failedReconnectsCount += 1;
          nextScheduledRetryTime = null;
          nextScheduledDelayMs = 0;
          addReconnectLog({
            type: "PAIRING_FAILED",
            reason: errorInfo.message || "Pairing attempt timed out or closed",
            statusCode: errorInfo.code,
            status: "FAILED",
            message: errorInfo.message || "Pairing aborted.",
          });
        }
      }
    });
  }

  let connectingStartedAt = 0;
  let lastKeepAlivePingAt = 0;
  let pairingRequestStartedAt = 0;
  let inFlightCredsSave = null;
  const recentRawMessagesCache = new Map();

  async function connect(options = {}) {
    const { forPairing = false } = options;
    if (connecting) return connecting;
    if (sock) return sock;
    intentionalDisconnect = false;
    connectingStartedAt = Date.now();
    connecting = (async () => {
      if (inFlightCredsSave) {
        await inFlightCredsSave.catch(() => {});
      }
      await fs.mkdir(userSessionDir, { recursive: true });
      if (!forPairing) {
        await restoreSessionFromFirestore(userId, userSessionDir);
      }
      const { state: authState, saveCreds } = await useMultiFileAuthState(userSessionDir);
      const isTrulyPaired = Boolean(
        authState.creds.registered === true ||
        Boolean(authState.creds.me?.id) ||
        Boolean(authState.creds.account)
      );
      if (forPairing) {
        delete authState.creds.me;
        delete authState.creds.pairingCode;
        authState.creds.registered = false;
        await saveCreds();
      } else if (isTrulyPaired && authState.creds.me && !authState.creds.me.name) {
        // Ensure me.name is non-empty so Baileys sendPresenceUpdate("available") sends <presence type="available"/>
        authState.creds.me.name = authState.creds.me.verifiedName || "~";
        await saveCreds();
      }
      if (isTrulyPaired && authState.creds.me?.id && !botNumber) {
        botNumber = authState.creds.me.id.split(":")[0].split("@")[0] || "";
      }
      let version;
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
        logger.info("Using latest WhatsApp Web version", version.join("."));
      } catch (error) {
        logger.warn("Could not fetch latest WhatsApp Web version; using library default", error.message);
      }
      const nextSocket = makeWASocket({
        ...(version ? { version } : {}),
        qrTimeout: PAIRING_TTL_MS,
        keepAliveIntervalMs: 12000,
        connectTimeoutMs: 45000,
        defaultQueryTimeoutMs: 45000,
        retryRequestDelayMs: 350,
        maxMsgRetryCount: 5,
        markOnlineOnConnect: true,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: "silent" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: (msg) => msg?.syncType === 0 || msg?.syncType === 4,
        getMessage: async (key) => {
          if (!key?.id) return undefined;
          return recentRawMessagesCache.get(key.id) || undefined;
        },
      });
      bindSocket(nextSocket, saveCreds);
      sessionRegistered = isTrulyPaired;
      if (state !== "pairing") {
        state = "connecting";
      }
      return nextSocket;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function requestPairingCode(number) {
    const phone = normalizeNumber(number);
    if (phone.length < 7 || phone.length > 15 || phone.startsWith("0")) {
      throw new Error("Enter a valid Nigerian mobile number such as 09012345678, or use international format 2349012345678.");
    }

    // Verify if number or account is locked
    const lockCheck = await checkNumberLock(phone, verifiedUid, userEmail);
    if (!lockCheck.allowed) {
      const diag = classifyPairingFailure(
        { code: lockCheck.reason, message: lockCheck.message },
        { startedAt: Date.now(), handshakeReceived: false }
      );
      updatePairingInspector({
        active: false,
        stage: 1,
        stageId: "STAGE_1_LOCK_BLOCKED",
        stageLabel: diag.title,
        stageDetail: diag.summary,
        status: "failed",
        phone,
        code: "",
        failureDiagnostic: diag,
      });
      const err = new Error(lockCheck.message);
      err.code = lockCheck.reason;
      throw err;
    }

    if (pairingRequest && Date.now() - pairingRequestStartedAt < 8000) {
      throw new Error("A pairing request is currently in progress. Please wait a few seconds.");
    }

    // Clean up any previous stale socket or old session files for this user
    await disconnect();
    intentionalDisconnect = false;
    pairingRequestStartedAt = Date.now();
    pairingInspector.stagesHistory = [];
    updatePairingInspector({
      active: true,
      stage: 1,
      stageId: "STAGE_1_SOCKET",
      stageLabel: "Stage 1/6: Opening WhatsApp Web Gateway Socket",
      stageDetail: "Connecting to wss://web.whatsapp.com/ws/chat and initializing clean Noise protocol keys...",
      status: "in_progress",
      phone,
      code: "",
      startedAt: new Date().toISOString(),
      expiresAt: null,
      handshakeReceived: false,
      failureDiagnostic: null,
    });

    let trackedRequest;
    const request = (async () => {
      try {
        const ready = beginPairingReadyWait(30000);
        const candidate = await connect({ forPairing: true });
        if (!candidate || candidate !== sock) throw new Error("WhatsApp connection closed before pairing.");
        // Wait until Baileys completes the Noise registration handshake and emits the initial pair-device QR
        await ready;
        updatePairingInspector({
          active: true,
          stage: 2,
          stageId: "STAGE_2_CODE_READY",
          stageLabel: "Stage 2/6: Generating Fresh Ephemeral Pairing Key",
          stageDetail: "Noise handshake ready; requesting 8-character companion pairing code from Meta...",
          status: "in_progress",
          phone,
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (candidate !== sock || !isSocketTrulyOpen()) {
          throw new Error("WhatsApp pairing socket closed before the pairing request was sent.");
        }

        const code = await candidate.requestPairingCode(phone);
        pairingCode = code;
        pairingExpiresAt = Date.now() + PAIRING_TTL_MS;
        pairingNumber = phone;
        state = "pairing";
        lastError = "";
        lastErrorCode = null;
        updatePairingInspector({
          active: true,
          stage: 3,
          stageId: "STAGE_3_WAITING_USER",
          stageLabel: "Stage 3/6: Waiting for Mobile Code Entry",
          stageDetail: `8-character code (${cleanCode(code)}) issued for +${phone}. Open WhatsApp > Linked Devices > Link with phone number and enter it now.`,
          status: "waiting_user",
          phone,
          code: cleanCode(code),
          expiresAt: new Date(pairingExpiresAt).toISOString(),
          failureDiagnostic: null,
        });
        logger.info("Real WhatsApp pairing code generated", `for ${phone}; socket remains active`);
        return { code: cleanCode(code), expiresAt: pairingExpiresAt, phone };
      } catch (error) {
        const errorInfo = describeSocketError(error, "Pairing code request failed");
        const diag = classifyPairingFailure(errorInfo, {
          startedAt: pairingRequestStartedAt,
          handshakeReceived: pairingInspector.handshakeReceived,
        });
        if (state !== "connected") {
          state = "error";
          lastError = `${diag.title}: ${diag.summary}`;
          lastErrorCode = diag.diagnosticCode;
        }
        updatePairingInspector({
          active: false,
          status: "failed",
          phone,
          stageLabel: diag.title,
          stageDetail: diag.summary,
          failureDiagnostic: diag,
        });
        rejectPairingReady(error);
        logger.warn("Real WhatsApp pairing request failed", errorInfo.message);
        throw error;
      }
    })();

    trackedRequest = request.finally(() => {
      if (pairingRequest === trackedRequest) pairingRequest = null;
    });
    // Attach error handler to prevent unhandled rejection on stored reference
    trackedRequest.catch(() => {});
    pairingRequest = trackedRequest;
    return trackedRequest;
  }

  async function disconnect() {
    intentionalDisconnect = true;
    clearTimeout(reconnectTimer);
    pairingCode = "";
    pairingExpiresAt = 0;
    pairingNumber = "";
    botNumber = "";
    lastError = "";
    lastErrorCode = null;
    state = "idle";
    connectedAt = null;
    lastActive = null;
    disconnectedAt = new Date().toISOString();
    sessionRegistered = false;
    pairingRequest = null;
    if (sock) {
      try {
        sock.ws?.close();
      } catch (error) {
        logger.warn("Socket close failed", error.message);
      }
    }
    sock = null;
    await fs.rm(userSessionDir, { recursive: true, force: true });
    await fs.mkdir(userSessionDir, { recursive: true });
    await deleteSessionFromFirestore(userId);
  }

  async function stopForExpiry() {
    intentionalDisconnect = true;
    clearTimeout(reconnectTimer);
    pairingCode = "";
    pairingExpiresAt = 0;
    pairingNumber = "";
    state = "expired";
    connectedAt = null;
    disconnectedAt = new Date().toISOString();
    lastError = "License expired. Please redeem a valid activation code in your dashboard to resume your WhatsApp session.";
    lastErrorCode = "LICENSE_EXPIRED";
    if (sock) {
      try {
        sock.ws?.close();
      } catch (error) {
        logger.warn("Socket close on expiry failed", error.message);
      }
    }
    sock = null;
  }

  function hasSavedSession() {
    try {
      const credsFile = path.join(userSessionDir, "creds.json");
      if (!fsSync.existsSync(credsFile)) return false;
      const raw = fsSync.readFileSync(credsFile, "utf8");
      return isValidRegisteredCredsJson(raw);
    } catch {
      return false;
    }
  }

  async function start() {
    await fs.mkdir(userSessionDir, { recursive: true });
    await restoreSessionFromFirestore(userId, userSessionDir);
    if (!hasSavedSession()) {
      state = "idle";
      lastError = "";
      lastErrorCode = null;
      sessionRegistered = false;
      return null;
    }
    const { state: authState } = await useMultiFileAuthState(userSessionDir);
    const isPaired = Boolean(
      authState.creds.registered || (authState.creds.account && authState.creds.me?.id)
    );
    if (!isPaired) {
      state = "idle";
      lastError = "";
      lastErrorCode = null;
      sessionRegistered = false;
      return null;
    }
    sessionRegistered = true;
    return connect();
  }

  async function triggerManualReconnect() {
    if (state === "connected" && isSocketTrulyOpen() && Boolean(sock?.user?.id)) {
      return { success: true, message: "Bot is already connected.", status: state };
    }
    if (connecting) {
      return { success: true, message: "Reconnection is already in progress.", status: state };
    }
    clearTimeout(reconnectTimer);
    await restoreSessionFromFirestore(userId, userSessionDir);
    if (!hasSavedSession()) {
      state = "idle";
      sessionRegistered = false;
      return {
        success: false,
        message: "No linked WhatsApp session found for your account. Please enter your phone number and link with a pairing code first.",
        status: "idle",
      };
    }
    addReconnectLog({
      type: "MANUAL_RECONNECT_REQUEST",
      reason: "User initiated manual reconnection",
      status: "IN_PROGRESS",
      message: "Initiating immediate reconnection attempt...",
    });
    const result = await start();
    return { success: Boolean(result), message: result ? "Reconnection process initiated." : "No saved session available to reconnect.", status: state };
  }

  async function ensureAlive() {
    if (intentionalDisconnect || state === "expired" || state === "logged_out" || state === "pairing" || pairingRequest) {
      return;
    }
    const now = Date.now();
    const saved = sessionRegistered && hasSavedSession();
    if (!saved) return;

    // 1. If connected, verify underlying WebSocket is truly open and send periodic keepalive ping
    if (state === "connected" && sock) {
      const wsReadyState = sock.ws?.socket?.readyState ?? sock.ws?.readyState;
      // readyState 2 = CLOSING, 3 = CLOSED
      if (wsReadyState === 2 || wsReadyState === 3 || sock.ws?.isClosed) {
        logger.warn(`Watchdog detected dead WebSocket for user ${userId}; triggering instant reconnect`);
        try {
          sock.ws?.close?.();
        } catch {}
        sock = null;
        state = "connecting";
        clearTimeout(reconnectTimer);
        void connect();
        return;
      }

      if (now - lastKeepAlivePingAt >= 10000) {
        lastKeepAlivePingAt = now;
        try {
          if (typeof sock.ws?.ping === "function") {
            sock.ws.ping();
          } else if (typeof sock.ws?.socket?.ping === "function") {
            sock.ws.socket.ping();
          }
        } catch {}
      }
      return;
    }

    // 2. If stuck in "connecting" for > 45 seconds without opening, reset hung socket and reconnect
    if ((state === "connecting" || connecting) && connectingStartedAt > 0 && now - connectingStartedAt > 45000) {
      logger.warn(`Watchdog resetting hung connecting socket (>45s) for user ${userId}`);
      if (sock) {
        try {
          sock.ws?.close?.();
        } catch {}
        sock = null;
      }
      connecting = null;
      clearTimeout(reconnectTimer);
      void connect();
      return;
    }

    // 3. If disconnected / idle / error while registered credentials exist and no connect is active, reconnect now!
    if (!connecting && !sock) {
      clearTimeout(reconnectTimer);
      void connect();
    }
  }

  async function clearBugsAndCache() {
    const memBefore = process.memoryUsage();
    const trulyConn = state === "connected" && isSocketTrulyOpen() && Boolean(sock?.user?.id);
    botSentMessageIds.clear();
    lastError = "";
    lastErrorCode = null;

    if (!trulyConn) {
      // Safe to flush hanging/unauthenticated socket & stale partial session files
      clearTimeout(reconnectTimer);
      pairingCode = "";
      pairingExpiresAt = 0;
      pairingNumber = "";
      pairingRequest = null;
      rejectPairingReady(new Error("Cache cleared by user"));
      if (sock) {
        try {
          sock.ws?.close?.();
        } catch {}
        sock = null;
      }
      connecting = null;

      // If there is no valid registered session on disk, wipe any partial/stale files completely
      if (!hasSavedSession()) {
        try {
          await fs.rm(userSessionDir, { recursive: true, force: true });
          await fs.mkdir(userSessionDir, { recursive: true });
        } catch {}
        state = "idle";
        sessionRegistered = false;
      } else {
        // Registered session exists -> trigger clean reconnect
        state = "connecting";
        void connect();
      }

      updatePairingInspector({
        active: false,
        stage: 0,
        stageId: "IDLE",
        stageLabel: "Cache & Stale Keys Flushed — Ready to Pair",
        stageDetail: "All temporary buffers, stuck sockets, and stale pairing keys were cleared. Enter your number to generate a fresh code.",
        status: "idle",
        code: "",
        failureDiagnostic: null,
      });
    } else {
      // Active verified connection stays 100% online; only flush memory buffers & error flags
      updatePairingInspector({
        active: false,
        stage: 6,
        stageId: "STAGE_6_CONNECTED",
        stageLabel: "Stage 6/6: Device Linked & Online (Cache Optimized)",
        stageDetail: `In-memory message queues and temporary caches flushed while keeping +${botNumber} online.`,
        status: "connected",
        failureDiagnostic: null,
      });
    }

    try {
      if (typeof global.gc === "function") global.gc();
    } catch {}

    const memAfter = process.memoryUsage();
    return {
      ok: true,
      keptActiveConnection: trulyConn,
      memoryBeforeMb: Math.round((memBefore.heapUsed / 1024 / 1024) * 10) / 10,
      memoryAfterMb: Math.round((memAfter.heapUsed / 1024 / 1024) * 10) / 10,
      message: trulyConn
        ? "In-memory message buffers and temporary caches cleared! Your active WhatsApp connection and settings remain 100% intact."
        : "Stale pairing keys, hanging sockets, and temporary caches flushed! Ready for a fresh pairing code.",
    };
  }

  const controllerInstance = {
    userId,
    start,
    requestPairingCode,
    disconnect,
    stopForExpiry,
    hasSavedSession,
    setUserInfo,
    getVerifiedUid: () => verifiedUid,
    getUserEmail: () => userEmail,
    getStatus: status,
    getSocket: () => sock,
    getBotNumber: () => botNumber,
    markBotSent,
    isConnected: () => state === "connected" && isSocketTrulyOpen() && Boolean(sock?.user?.id),
    isConnecting: () => state === "connecting",
    isPairing: () => state === "pairing" || Boolean(pairingRequest),
    getReconnectLogs: () => reconnectLogs.slice(0, 50),
    getBatteryTelemetry: () => ({ ...battery }),
    getPairingInspector: () => ({ ...pairingInspector }),
    clearBugsAndCache,
    triggerManualReconnect,
    ensureAlive,
  };
  registeredControllers.add(controllerInstance);
  return controllerInstance;
}

const userControllers = new Map();
const registeredControllers = new Set();

class SharedParticipantMessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  enqueue(task) {
    this.queue.push(task);
    this.processNext();
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      try {
        await task();
      } catch (err) {
        logger.error("Participant queue task execution error:", err.message || err);
      }
      if (this.queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }

    this.processing = false;
    if (this.queue.length > 0) {
      this.processNext();
    }
  }
}

const sharedParticipantQueue = new SharedParticipantMessageQueue();

export function extractParticipantTargetDetails(p, metadata = null) {
  if (!p) return null;
  let parsed = p;
  if (typeof p === "string") {
    const trimmed = p.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {}
    }
  }

  const rawCandidates = [];
  if (typeof parsed === "object" && parsed !== null) {
    for (const key of ["phoneNumber", "id", "jid", "lid", "pn", "user", "participant"]) {
      if (parsed[key] && typeof parsed[key] === "string") {
        rawCandidates.push(parsed[key]);
      }
    }
  } else if (typeof parsed === "string") {
    rawCandidates.push(parsed);
  }

  const initialAliases = new Set(rawCandidates.flatMap(jidAliases));
  const initialNumbers = new Set(rawCandidates.map((j) => extractParticipantNumber(j)).filter(Boolean));

  if (metadata && Array.isArray(metadata.participants)) {
    const matched = metadata.participants.find((item) => {
      const itemJids = [item.id, item.jid, item.lid, item.phoneNumber].filter(Boolean);
      const itemAliases = itemJids.flatMap(jidAliases);
      if (itemAliases.some((a) => initialAliases.has(a))) return true;
      const itemPhoneNums = itemJids
        .filter((j) => String(j).endsWith("@s.whatsapp.net"))
        .map((j) => extractParticipantNumber(j))
        .filter(Boolean);
      return itemPhoneNums.some((n) => initialNumbers.has(n));
    });

    if (matched) {
      for (const field of [matched.phoneNumber, matched.jid, matched.id, matched.lid]) {
        if (field && typeof field === "string") {
          rawCandidates.push(field);
        }
      }
    }
  }

  const preferredPhone =
    rawCandidates.find((j) => String(j).endsWith("@s.whatsapp.net")) ||
    rawCandidates[0] ||
    p;

  const userNum = extractParticipantNumber(preferredPhone) || extractParticipantNumber(p);
  if (!userNum) return null;

  const aliases = new Set([
    ...rawCandidates.flatMap(jidAliases),
    ...rawCandidates.map((j) => extractParticipantNumber(j)).filter(Boolean),
    userNum,
    `${userNum}@s.whatsapp.net`,
  ]);

  return {
    userNum,
    userJid: `${userNum}@s.whatsapp.net`,
    aliases,
  };
}

export function doesSessionMatchParticipant(sessionInfo, targetInfo) {
  if (!sessionInfo || !targetInfo) return false;
  if (targetInfo.userNum && sessionInfo.botNumbers?.has(targetInfo.userNum)) {
    return true;
  }
  for (const alias of targetInfo.aliases || []) {
    if (sessionInfo.botAliases?.has(alias) || sessionInfo.botNumbers?.has(alias)) {
      return true;
    }
  }
  return false;
}

export async function verifySessionIsConnectedGroupAdmin(candidate, groupId, targetInfo = null) {
  if (!candidate) return null;
  const isConn = typeof candidate.isConnected === "function" ? candidate.isConnected() : true;
  const s = typeof candidate.getSocket === "function" ? candidate.getSocket() : candidate.sock;
  if (!isConn || !s) return null;
  if (s.ws && s.ws.isOpen === false) return null;

  const botRawNum =
    (typeof candidate.getBotNumber === "function" ? candidate.getBotNumber() : candidate.botNumber) || "";
  const botJids = [
    s.user?.id,
    s.user?.lid,
    s.user?.phoneNumber,
    botRawNum ? `${botRawNum}@s.whatsapp.net` : "",
  ]
    .filter(Boolean)
    .map(normalizedUser);

  if (botJids.length === 0) return null;

  const botAliases = new Set(botJids.flatMap(jidAliases));
  const botNumbers = new Set(botJids.map((j) => extractParticipantNumber(j)).filter(Boolean));

  const sessionObj = {
    userId: candidate.userId || "default",
    sock: s,
    markBotSent: candidate.markBotSent,
    botJids,
    botAliases,
    botNumbers,
    metadata: null,
  };

  // Joining/leaving member can NEVER be selected as sender
  if (targetInfo && doesSessionMatchParticipant(sessionObj, targetInfo)) {
    return null;
  }

  let metadata = null;
  try {
    metadata = await s.groupMetadata(groupId);
  } catch {
    return null;
  }

  if (!metadata || !Array.isArray(metadata.participants)) {
    return null;
  }

  // Strictly require the bot's WhatsApp account to be a group admin in this group
  const botIsGroupAdmin =
    isAdmin(metadata, botJids) ||
    Boolean(
      metadata.participants.find((item) => {
        const isItemAdmin = item.admin === "admin" || item.admin === "superadmin" || item.admin === true;
        if (!isItemAdmin) return false;
        const itemJids = [item.id, item.jid, item.lid, item.phoneNumber].filter(Boolean);
        const itemNumbers = itemJids.map((j) => extractParticipantNumber(j)).filter(Boolean);
        return itemNumbers.some((num) => botNumbers.has(num));
      })
    );

  if (!botIsGroupAdmin) {
    return null;
  }

  // Re-check targetInfo with resolved group metadata in case target was passed as LID
  if (targetInfo) {
    const enrichedTarget = extractParticipantTargetDetails(targetInfo.userJid, metadata) || targetInfo;
    if (doesSessionMatchParticipant(sessionObj, enrichedTarget)) {
      return null;
    }
  }

  sessionObj.metadata = metadata;
  return sessionObj;
}

export async function findEligibleAdminSessionsForGroup(groupId, targetInfo = null, currentSession = null) {
  const candidates = [];
  const seenSockets = new Set();

  const allControllers = [
    ...(currentSession ? [currentSession] : []),
    ...userControllers.values(),
    ...registeredControllers.values(),
  ];

  for (const ctrl of allControllers) {
    if (!ctrl) continue;
    const s = typeof ctrl.getSocket === "function" ? ctrl.getSocket() : ctrl.sock;
    if (!s || seenSockets.has(s)) continue;
    seenSockets.add(s);
    candidates.push(ctrl);
  }

  const eligible = [];
  for (const candidate of candidates) {
    const verified = await verifySessionIsConnectedGroupAdmin(candidate, groupId, targetInfo);
    if (verified) {
      eligible.push(verified);
    }
  }

  eligible.sort((a, b) => {
    const aKey = `${a.userId || ""}_${a.botJids?.[0] || ""}`;
    const bKey = `${b.userId || ""}_${b.botJids?.[0] || ""}`;
    return aKey.localeCompare(bKey);
  });

  return eligible;
}

export const WARNING_NOTICE_DELETE_DELAY_MS = 5000;

export function scheduleAutoDeleteNotice(adminSock, chatId, messageKey, delayMs = WARNING_NOTICE_DELETE_DELAY_MS) {
  if (!adminSock || !chatId || !messageKey?.id) return null;
  const safeDelay = typeof delayMs === "number" && delayMs >= 0 ? delayMs : WARNING_NOTICE_DELETE_DELAY_MS;
  const timer = setTimeout(async () => {
    try {
      await adminSock.sendMessage(chatId, {
        delete: {
          remoteJid: chatId,
          fromMe: true,
          id: messageKey.id,
          ...(messageKey.participant ? { participant: messageKey.participant } : {}),
        },
      });
    } catch (err) {
      logger.debug?.("Could not auto-delete temporary warning notice", err?.message || err);
    }
  }, safeDelay);

  if (typeof timer?.unref === "function") {
    timer.unref();
  }
  return timer;
}

async function dispatchWarningViaOrderedAdmins({
  orderedAdmins,
  chatId,
  target,
  kickTarget,
  allTargetJids = [],
  targetInfo,
  deleteKey = null,
  protectionName = "group rules",
  isManualWarn = false,
  isStatusMention = false,
  botSentMessageIds = null,
  warningDeleteDelayMs = WARNING_NOTICE_DELETE_DELAY_MS,
}) {
  for (const candidate of orderedAdmins) {
    const adminSession = await verifySessionIsConnectedGroupAdmin(candidate, chatId, targetInfo);
    if (!adminSession || !adminSession.sock) continue;

    // 1. Delete the specific violating message (where WhatsApp allows deletion)
    let contentWasDeleted = false;
    if (deleteKey && deleteKey.id && deleteKey.remoteJid === chatId) {
      try {
        await adminSession.sock.sendMessage(chatId, { delete: deleteKey });
        contentWasDeleted = true;
      } catch (delErr) {
        logger.debug?.("Could not delete violating message via admin session", delErr?.message || delErr);
      }
    }

    // 2. Increase the target's shared warning count
    const warningResult = await addWarning(chatId, target, protectionName, adminSession.userId, allTargetJids);
    const { count, limit } = warningResult;
    const targetNumber = extractParticipantNumber(target) || target.split("@")[0].split(":")[0];
    const mentionJids = [...new Set([target, kickTarget].filter(Boolean))];

    const detailNoticeLines = isStatusMention
      ? ["📢 Mentioning this group in a WhatsApp Status is not allowed.", ""]
      : contentWasDeleted
        ? ["🚫 The violating content has been removed.", ""]
        : [];

    const violationDescription = isManualWarn
      ? "You have received an official warning from a group admin."
      : `Your action violated the group's *${protectionName}*.`;

    try {
      // 3. Send warning notice or remove member if limit exceeded (warnings permanently stay in chat for accountability)
      if (count < limit) {
        const warningText = [
          `╭━━〔 ⚠️ *SOLVATECH WARNING ${count}/${limit}* 〕━━╮`,
          "",
          `┃ 👤 *Member:* @${targetNumber}`,
          `┃ 📝 *Reason:* _${violationDescription}_`,
          `┃ 🔢 *Warnings:* *${count}* of *${limit}* maximum`,
          ...(detailNoticeLines.length > 0 ? ["", ...detailNoticeLines.map((l) => l ? `┃ ${l}` : "")] : []),
          "",
          "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
          "",
          "_Please adhere to the group rules. Further violations will result in removal._",
        ].join("\n");

        const sent = await adminSession.sock.sendMessage(chatId, {
          text: warningText,
          mentions: mentionJids,
        });
        if (sent?.key?.id) {
          adminSession.markBotSent?.(sent.key.id);
          botSentMessageIds?.add?.(sent.key.id);
        }
        return true;
      }

      if (count === limit) {
        const finalWarningText = [
          `╭━━〔 ⚠️ *FINAL WARNING ${count}/${limit}* 〕━━╮`,
          "",
          `┃ 👤 *Member:* @${targetNumber}`,
          `┃ 🚨 *Status:* *MAXIMUM WARNING REACHED*`,
          `┃ 🔢 *Warnings:* *${count}* of *${limit}* limit`,
          ...(detailNoticeLines.length > 0 ? ["", ...detailNoticeLines.map((l) => l ? `┃ ${l}` : "")] : []),
          "",
          "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
          "",
          "⛔ *CRITICAL NOTICE:* _This is your final warning. Any further violation will result in immediate removal._",
        ].join("\n");

        const sent = await adminSession.sock.sendMessage(chatId, {
          text: finalWarningText,
          mentions: mentionJids,
        });
        if (sent?.key?.id) {
          adminSession.markBotSent?.(sent.key.id);
          botSentMessageIds?.add?.(sent.key.id);
        }
        return true;
      }

      // count > limit: Remove member from group using the admin bot session
      try {
        await adminSession.sock.groupParticipantsUpdate(chatId, [kickTarget], "remove");
        await clearWarning(chatId, [target, kickTarget, ...allTargetJids], adminSession.userId).catch(() => {});

        const removedText = [
          "╭━━〔 🚨 *WARNING LIMIT EXCEEDED* 〕━━╮",
          "",
          `┃ 👤 *Member:* @${targetNumber}`,
          `┃ ⚠️ *Violations:* *${count}* (Limit: *${limit}*)`,
          `┃ 👢 *Action Taken:* _Removed from group_`,
          ...(detailNoticeLines.length > 0 ? ["", ...detailNoticeLines.map((l) => l ? `┃ ${l}` : "")] : []),
          "",
          "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
          "",
          "🚪 _This user has been removed for repeatedly exceeding the group warning threshold._",
        ].join("\n");

        const sent = await adminSession.sock.sendMessage(chatId, {
          text: removedText,
          mentions: mentionJids,
        });
        if (sent?.key?.id) {
          adminSession.markBotSent?.(sent.key.id);
          botSentMessageIds?.add?.(sent.key.id);
        }
        return true;
      } catch (removeErr) {
        logger.error(`Failed to remove participant ${kickTarget} from group:`, removeErr.message);
        const failText = [
          "╭━━〔 🚨 *WARNING LIMIT EXCEEDED* 〕━━╮",
          "",
          `┃ 👤 *Member:* @${targetNumber}`,
          `┃ ⚠️ *Violations:* *${count}* (Limit: *${limit}*)`,
          `┃ ⚠️ *Notice:* _Could not remove member automatically_`,
          ...(detailNoticeLines.length > 0 ? ["", ...detailNoticeLines.map((l) => l ? `┃ ${l}` : "")] : []),
          "",
          "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
          "",
          "⚠️ _Please ensure the bot has administrator permissions to remove members._",
        ].join("\n");

        const sent = await adminSession.sock.sendMessage(chatId, {
          text: failText,
          mentions: mentionJids,
        });
        if (sent?.key?.id) {
          adminSession.markBotSent?.(sent.key.id);
          botSentMessageIds?.add?.(sent.key.id);
        }
        return true;
      }
    } catch (sendErr) {
      logger.warn(`Admin session ${adminSession.userId} failed to complete warning dispatch`, sendErr.message || sendErr);
    }
  }

  return false;
}

export async function executeStrictGroupWarning({
  chatId,
  message,
  sender,
  senderJids = [],
  protectionName = "group rules",
  isStatusMention = false,
  currentSession = null,
  botSentMessageIds = null,
  warningDeleteDelayMs = WARNING_NOTICE_DELETE_DELAY_MS,
}) {
  if (!chatId || !isGroup(chatId)) return false;

  // 1. Find all connected SOLVATECH BOT sessions whose WhatsApp account is currently a GROUP ADMIN in this group.
  // If ZERO connected bot sessions are group admins, do NOT perform the warning action.
  const baseAdminSessions = await findEligibleAdminSessionsForGroup(chatId, null, currentSession);
  if (baseAdminSessions.length === 0) {
    return false;
  }

  const metadata = baseAdminSessions[0]?.metadata || null;
  if (!metadata || !Array.isArray(metadata.participants)) {
    return false;
  }

  // 2. Identify the actual violating participant (the target)
  const allCandidateJids = [
    ...new Set(
      [
        sender,
        ...(Array.isArray(senderJids) ? senderJids : []),
        ...(isStatusMention ? extractStatusMentionSenders(message) : []),
      ].filter((j) => j && typeof j === "string" && !j.endsWith("@g.us") && j !== "status@broadcast")
    ),
  ];

  const matchedJid = participantJid(metadata, allCandidateJids);
  const wantedAliases = new Set(allCandidateJids.flatMap(jidAliases));
  const matchedParticipant = metadata.participants.find((item) => {
    const aliases = [
      ...(item.id ? jidAliases(item.id) : []),
      ...(item.jid ? jidAliases(item.jid) : []),
      ...(item.lid ? jidAliases(item.lid) : []),
      ...(item.phoneNumber ? jidAliases(item.phoneNumber) : []),
    ];
    return aliases.some((alias) => wantedAliases.has(alias));
  });

  const preferredPhoneJid =
    matchedParticipant?.phoneNumber ||
    matchedParticipant?.jid ||
    allCandidateJids.find((j) => j.endsWith("@s.whatsapp.net")) ||
    matchedJid ||
    allCandidateJids[0] ||
    sender;

  const target = normalizedUser(preferredPhoneJid);
  const kickTarget = matchedParticipant?.id || matchedJid || target;

  if (!target || target.endsWith("@g.us") || target === "status@broadcast") {
    logger.warn(`[${protectionName}] Could not resolve valid participant JID for violation in ${chatId}`);
    return false;
  }

  const allTargetJids = [
    ...new Set(
      [
        target,
        kickTarget,
        matchedParticipant?.id,
        matchedParticipant?.jid,
        matchedParticipant?.lid,
        matchedParticipant?.phoneNumber,
        ...allCandidateJids,
      ].filter(Boolean)
    ),
  ];

  // 3. Admins cannot be warned: check target's current group role
  if (isAdmin(metadata, allTargetJids) || isOwner(metadata, allTargetJids)) {
    return false;
  }

  const targetInfo = extractParticipantTargetDetails(target, metadata) || {
    userNum: extractParticipantNumber(target),
    userJid: target,
    aliases: new Set(allTargetJids.flatMap(jidAliases)),
  };

  // 4. Strictly exclude the violating member from ever being selected as the warning sender
  const eligibleAdminsForTarget = baseAdminSessions.filter(
    (adminSess) => !doesSessionMatchParticipant(adminSess, targetInfo)
  );
  if (eligibleAdminsForTarget.length === 0) {
    return false;
  }

  const selectedAdmin = eligibleAdminsForTarget[0];
  const deleteKey =
    message?.key?.remoteJid === chatId && message?.key?.id && !message?.messageStubType
      ? {
          remoteJid: chatId,
          fromMe: false,
          id: message.key.id,
          participant: message.key.participant || message.participant || matchedParticipant?.id || kickTarget || target,
        }
      : null;

  // 5. Coordinate across multiple connected admin bots and across Path A / Path B delivery
  const canonicalMsgId = isStatusMention
    ? extractStatusMentionCanonicalId(message) || message?.key?.id
    : message?.key?.id;

  if (canonicalMsgId) {
    const claimed = await claimViolationEvent(
      chatId,
      canonicalMsgId,
      target,
      selectedAdmin.userId,
      120000,
      isStatusMention
    );
    if (!claimed) {
      // If Path A (status@broadcast) already claimed the status mention warning before Path B
      // (in-group notification) arrived, still delete the in-group status mention message once.
      if (isStatusMention && deleteKey && message?.key?.id) {
        const delClaimed = await claimViolationEvent(
          chatId,
          `del_${message.key.id}`,
          target,
          selectedAdmin.userId,
          60000,
          false
        );
        if (delClaimed) {
          try {
            await selectedAdmin.sock.sendMessage(chatId, { delete: deleteKey });
          } catch {}
        }
      }
      return false;
    }
  }

  const orderedAdmins = [selectedAdmin, ...eligibleAdminsForTarget.slice(1)];
  const delivered = await dispatchWarningViaOrderedAdmins({
    orderedAdmins,
    chatId,
    target,
    kickTarget,
    allTargetJids,
    targetInfo,
    deleteKey,
    protectionName,
    isManualWarn: false,
    isStatusMention,
    botSentMessageIds,
    warningDeleteDelayMs,
  });

  if (!delivered && canonicalMsgId) {
    await releaseViolationEvent(chatId, canonicalMsgId, target, isStatusMention);
  }

  return delivered;
}

export async function executeManualWarn({
  sock,
  chatId,
  sender,
  senderJids = [],
  args = [],
  message,
  userId = "default",
  botNumber = "",
  currentSession = null,
  botSentMessageIds = null,
  warningDeleteDelayMs = WARNING_NOTICE_DELETE_DELAY_MS,
}) {
  if (!chatId || !isGroup(chatId)) {
    return false;
  }

  const effectiveSession =
    currentSession ||
    (sock
      ? {
          userId,
          isConnected: () => true,
          getSocket: () => sock,
          getBotNumber: () => botNumber || sock.user?.id?.split(":")[0]?.split("@")[0] || "",
        }
      : null);

  // 1. Verify at least one connected SOLVATECH BOT session is a current group admin in this group.
  // If no connected bot session is a group admin, do NOT perform the warning action.
  const baseAdminSessions = await findEligibleAdminSessionsForGroup(chatId, null, effectiveSession);
  if (baseAdminSessions.length === 0) {
    return false;
  }

  const metadata = baseAdminSessions[0]?.metadata || null;
  if (!metadata || !Array.isArray(metadata.participants)) {
    return false;
  }

  // 2. Verify the person issuing ".warn" is currently a GROUP ADMIN in this group.
  // Normal group members can NEVER use ".warn".
  const callerCandidateJids = [
    sender,
    ...(Array.isArray(senderJids) ? senderJids : []),
    ...messageSenderJids(message, ""),
  ].filter((j) => j && typeof j === "string" && !j.endsWith("@g.us") && j !== "status@broadcast");

  if (!isAdmin(metadata, callerCandidateJids)) {
    return false;
  }

  // 3. Resolve the target strictly from:
  //    - the replied-to message sender (Reply method), OR
  //    - the explicitly tagged user (Tag method).
  //    Never resolve the admin issuing ".warn" as a fallback target.
  const resolved = resolveManualWarnTarget(metadata, message, args, chatId);

  if (!resolved || !resolved.canonicalJid) {
    const usageEventId = message?.key?.id ? `warn_usage_${message.key.id}` : null;
    if (usageEventId) {
      const claimed = await claimViolationEvent(
        chatId,
        usageEventId,
        sender || "admin",
        baseAdminSessions[0].userId,
        60000,
        false
      );
      if (!claimed) return false;
    }

    for (const candidate of baseAdminSessions) {
      const adminSession = await verifySessionIsConnectedGroupAdmin(candidate, chatId, null);
      if (!adminSession || !adminSession.sock) continue;
      try {
        const sent = await adminSession.sock.sendMessage(chatId, {
          text: [
            "╭━━〔 ⚠️ *WARN COMMAND USAGE* 〕━━╮",
            "",
            "┃ 💡 *Reply method:* Reply to a violating message with *.warn*",
            "┃ 👤 *Tag method:* Tag a member: *.warn @user*",
            "",
            "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
          ].join("\n"),
        });
        if (sent?.key?.id) {
          adminSession.markBotSent?.(sent.key.id);
          botSentMessageIds?.add?.(sent.key.id);
        }
        break;
      } catch {}
    }
    return false;
  }

  const target = resolved.canonicalJid;
  const kickTarget = resolved.matchedParticipant?.id || resolved.mentionJid || target;
  const allTargetJids = [...new Set([target, kickTarget, ...(resolved.allJids || [])].filter(Boolean))];

  // 4. Check the target's current group role (and ensure the admin issuing .warn is never warned).
  // If the target is a group admin (or owner), do NOT increase their warning count, do NOT remove them,
  // do NOT delete their message, and do NOT alter their shared warning balance.
  const callerAliases = new Set(callerCandidateJids.flatMap(jidAliases));
  const callerNumbers = new Set(callerCandidateJids.map((j) => extractParticipantNumber(j)).filter(Boolean));
  const targetNum = extractParticipantNumber(target);
  const targetIsCaller =
    allTargetJids.some((j) => callerAliases.has(j)) || Boolean(targetNum && callerNumbers.has(targetNum));

  const targetIsGroupAdmin =
    targetIsCaller || isAdmin(metadata, allTargetJids) || isOwner(metadata, allTargetJids);

  if (targetIsGroupAdmin) {
    const adminTargetEventId = message?.key?.id ? `warn_admintarget_${message.key.id}` : null;
    if (adminTargetEventId) {
      const claimed = await claimViolationEvent(
        chatId,
        adminTargetEventId,
        target,
        baseAdminSessions[0].userId,
        60000,
        false
      );
      if (!claimed) return false;
    }

    for (const candidate of baseAdminSessions) {
      const adminSession = await verifySessionIsConnectedGroupAdmin(candidate, chatId, null);
      if (!adminSession || !adminSession.sock) continue;
      try {
        const sent = await adminSession.sock.sendMessage(chatId, {
          text: "🛡️ *Protection Notice:* _Group administrators and owners cannot be warned._",
        });
        if (sent?.key?.id) {
          adminSession.markBotSent?.(sent.key.id);
          botSentMessageIds?.add?.(sent.key.id);
        }
        break;
      } catch {}
    }
    return false;
  }

  const targetInfo = extractParticipantTargetDetails(target, metadata) || {
    userNum: targetNum,
    userJid: target,
    aliases: new Set(allTargetJids.flatMap(jidAliases)),
  };

  // 5. Filter eligible connected admin bot sessions to strictly exclude the target member
  const eligibleAdminsForTarget = baseAdminSessions.filter(
    (adminSess) => !doesSessionMatchParticipant(adminSess, targetInfo)
  );
  if (eligibleAdminsForTarget.length === 0) {
    return false;
  }

  const selectedAdmin = eligibleAdminsForTarget[0];
  const canonicalEventId = message?.key?.id
    ? `manualwarn_${message.key.id}`
    : resolved.quotedMessageId
      ? `manualwarn_${resolved.quotedMessageId}`
      : null;

  if (canonicalEventId) {
    const claimed = await claimViolationEvent(
      chatId,
      canonicalEventId,
      target,
      selectedAdmin.userId,
      120000,
      false
    );
    if (!claimed) {
      return false;
    }
  }

  const orderedAdmins = [selectedAdmin, ...eligibleAdminsForTarget.slice(1)];
  const delivered = await dispatchWarningViaOrderedAdmins({
    orderedAdmins,
    chatId,
    target,
    kickTarget,
    allTargetJids,
    targetInfo,
    deleteKey: resolved.quotedDeleteKey || null,
    protectionName: "Manual warning (.warn)",
    isManualWarn: true,
    isStatusMention: false,
    botSentMessageIds,
    warningDeleteDelayMs,
  });

  if (!delivered && canonicalEventId) {
    await releaseViolationEvent(chatId, canonicalEventId, target, false);
  }

  return delivered;
}

export async function restoreAllSessions() {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const uidsToRestore = new Set();

    // 1. Scan local session directory
    try {
      const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) uidsToRestore.add(entry.name);
      }
    } catch {}

    // 2. Scan Firestore for saved sessions (survives full Railway volume wipes)
    try {
      const docs = await readFirestoreCollectionRest("whatsapp_sessions");
      for (const docSnap of docs || []) {
        if (docSnap?.id) uidsToRestore.add(docSnap.id);
      }
    } catch (err) {
      logger.debug("Firestore session scan notice during auto-restore", err.message);
    }

    let restoredCount = 0;
    for (const userId of uidsToRestore) {
      const userSessionDir = path.join(SESSION_DIR, userId);
      try {
        const controller = getWhatsAppController(userId, { verifiedUid: userId });
        if (
          controller.isConnected() ||
          controller.isConnecting() ||
          controller.isPairing?.() ||
          controller.getStatus().status === "pairing" ||
          controller.getStatus().status === "logged_out"
        ) {
          continue;
        }
        await restoreSessionFromFirestore(userId, userSessionDir);
        if (controller.hasSavedSession()) {
          const licenseStatus = await getUserLicenseStatus(userId);
          if (licenseStatus.hasActiveLicense) {
            logger.info(`Auto-restoring saved WhatsApp session for user: ${userId}`);
            await controller.start();
            restoredCount++;
          } else {
            logger.info(`Skipping auto-restore for user ${userId}: License expired.`);
            controller.stopForExpiry();
          }
        }
      } catch (err) {
        logger.warn(`Could not restore session for user ${userId}`, err.message);
      }
    }
    if (restoredCount > 0) {
      logger.info(`Session auto-restore complete. Restored ${restoredCount} active user session(s).`);
    }
  } catch (error) {
    logger.warn("Could not scan session directory for auto-restore", error.message);
  }
}

export async function auditActiveSessions() {
  for (const [userId, controller] of userControllers.entries()) {
    const verifiedUid = controller.getVerifiedUid() || userId;
    const userEmail = controller.getUserEmail();
    const st = controller.getStatus();
    if (st.status === "connected" || st.status === "connecting" || st.status === "pairing") {
      try {
        const licenseStatus = await getUserLicenseStatus(verifiedUid, userEmail);
        if (!licenseStatus.hasActiveLicense) {
          logger.warn(`Stopping active WhatsApp session for user ${verifiedUid}: License expired.`);
          await controller.stopForExpiry();
        }
      } catch (err) {
        logger.debug("License audit notice", err.message);
      }
    }
  }
}

export function getWhatsAppController(userId = "default", options = {}) {
  const id = String(userId || "default").trim();
  if (!userControllers.has(id)) {
    userControllers.set(id, createWhatsAppController({ userId: id, ...options }));
  } else if (options.verifiedUid || options.userEmail) {
    const existing = userControllers.get(id);
    existing.setUserInfo(options);
  }
  return userControllers.get(id);
}

/**
 * Admin helper: Disconnects the WhatsApp socket/session for a user without modifying number lock
 */
export async function disconnectUserWhatsAppSession(userId) {
  const id = String(userId || "").trim();
  if (!id) return { success: false, message: "User ID required" };

  let targetCtrl = userControllers.get(id);
  if (!targetCtrl) {
    for (const [key, ctrl] of userControllers.entries()) {
      if (ctrl.getVerifiedUid() === id || ctrl.getUserEmail() === id) {
        targetCtrl = ctrl;
        break;
      }
    }
  }

  if (targetCtrl) {
    await targetCtrl.disconnect();
    return { success: true, message: "WhatsApp session disconnected successfully." };
  }

  return { success: true, message: "No active WhatsApp connection for this user." };
}

/**
 * Read-only helper: Returns statuses of all registered user WhatsApp controllers for admin visibility
 */
export function getAllWhatsAppStatuses() {
  const list = [];
  for (const [userId, ctrl] of userControllers.entries()) {
    try {
      const st = ctrl.getStatus();
      list.push({
        userId,
        verifiedUid: ctrl.getVerifiedUid() || userId,
        userEmail: ctrl.getUserEmail() || "",
        status: st.status,
        state: st.state,
        connected: st.connected,
        botNumber: st.botNumber || "",
        pairingNumber: st.pairingNumber || st.pairingInspector?.phone || "",
        pairingCode: st.pairingCode || "",
        connectedAt: st.connectedAt || null,
        lastActive: st.lastActive || null,
        lastError: st.lastError || "",
        lastErrorCode: st.lastErrorCode || null,
        pairingInspector: st.pairingInspector || null,
      });
    } catch {}
  }
  return list;
}

export function getAllPairingInspectorStates() {
  const activeInspectors = [];
  for (const [userId, ctrl] of userControllers.entries()) {
    try {
      const st = ctrl.getStatus();
      const insp = st.pairingInspector || {};
      if (insp.stage > 0 || st.status === "pairing" || st.status === "error" || st.lastError) {
        activeInspectors.push({
          userId,
          verifiedUid: ctrl.getVerifiedUid() || userId,
          userEmail: ctrl.getUserEmail() || "",
          botNumber: st.botNumber || "",
          pairingNumber: st.pairingNumber || insp.phone || "",
          connectionStatus: st.status,
          connected: st.connected,
          lastError: st.lastError || "",
          inspector: insp,
        });
      }
    } catch {}
  }
  activeInspectors.sort((a, b) => {
    const tA = new Date(a.inspector?.updatedAt || 0).getTime();
    const tB = new Date(b.inspector?.updatedAt || 0).getTime();
    return tB - tA;
  });
  return {
    inspectors: activeInspectors,
    recentEvents: globalPairingEvents.slice(0, 80),
  };
}

export async function clearAllSystemBugsAndCache() {
  const memBefore = process.memoryUsage();
  let flushedControllers = 0;
  let activePreserved = 0;
  let cleanedDirs = 0;

  for (const [, ctrl] of userControllers.entries()) {
    try {
      const res = await ctrl.clearBugsAndCache();
      if (res.keptActiveConnection) activePreserved++;
      else flushedControllers++;
    } catch {}
  }

  // Also scan SESSION_DIR for any orphaned/unregistered directories without valid creds.json
  try {
    const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(SESSION_DIR, entry.name);
      const credsPath = path.join(dirPath, "creds.json");
      let isValid = false;
      try {
        if (fsSync.existsSync(credsPath)) {
          isValid = isValidRegisteredCredsJson(fsSync.readFileSync(credsPath, "utf8"));
        }
      } catch {}
      const ctrl = userControllers.get(entry.name);
      const isCurrentlyPairing = ctrl && ctrl.isPairing?.();
      if (!isValid && !isCurrentlyPairing) {
        await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
        cleanedDirs++;
      }
    }
  } catch {}

  try {
    if (typeof global.gc === "function") global.gc();
  } catch {}

  const memAfter = process.memoryUsage();
  const beforeMb = Math.round((memBefore.heapUsed / 1024 / 1024) * 10) / 10;
  const afterMb = Math.round((memAfter.heapUsed / 1024 / 1024) * 10) / 10;
  const rssMb = Math.round((memAfter.rss / 1024 / 1024) * 10) / 10;

  return {
    ok: true,
    flushedControllers,
    activePreserved,
    cleanedDirs,
    memoryBeforeMb: beforeMb,
    memoryAfterMb: afterMb,
    rssMb,
    freedMb: Math.max(0, Math.round((beforeMb - afterMb) * 10) / 10),
    message: `System cache & bugs cleared! Preserved ${activePreserved} active session(s), flushed ${flushedControllers} idle/stuck controller(s), and cleaned ${cleanedDirs} unauthenticated session folder(s). RAM Heap: ${afterMb} MB (RSS: ${rssMb} MB).`,
  };
}

// ---------------------------------------------------------------------------
// 1-SECOND CONTINUOUS GLOBAL WATCHDOG & HEARTBEAT FOR ALL LINKED SESSIONS
// Ensures no linked session anywhere in the world ever stays disconnected!
// ---------------------------------------------------------------------------
let globalWatchdogStarted = false;

export function startGlobalSessionWatchdog() {
  if (globalWatchdogStarted) return;
  globalWatchdogStarted = true;

  // Every 1 second (1000ms): inspect and ping all registered WhatsApp sessions
  setInterval(() => {
    for (const ctrl of registeredControllers) {
      try {
        void ctrl.ensureAlive?.();
      } catch {}
    }
  }, 1000);

  // Every 45 seconds: scan disk & Firestore for any saved sessions not yet loaded in memory
  setInterval(() => {
    void restoreAllSessions();
  }, 45000);
}

startGlobalSessionWatchdog();




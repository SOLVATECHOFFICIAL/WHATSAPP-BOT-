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
import { getGroupSettings, addWarning, clearWarning, claimParticipantEvent, claimViolationEvent } from "./database.js";
import path from "node:path";
import { PAIRING_TTL_MS, SESSION_DIR } from "./config.js";
import { createKeyedQueue } from "./queue.js";
import { getContextInfo, getMessageContent, getMessageText, isCommand, isGroup, isStatusMentionMessage, jidAliases, messageSenderJids, normalizeNumber, normalizedUser, parseCommand } from "./helpers.js";
import { isAdmin, participantJid } from "./permissions.js";
import { logger } from "./logger.js";
import { handleDeletedMessage, recordIncomingMessage } from "./deleted-messages.js";
import { checkNumberLock, lockNumberToUser } from "./number-lock.js";
import { getUserLicenseStatus } from "./license.js";
import { downloadMediaUrl } from "./media.js";
import { stopAllSpamTasks } from "./spam-manager.js";

import { getFirebaseServerFirestore } from "./auth.js";

const SOLVATECH_PUBLIC_LOGO = "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";

// Map of userId -> debounce timer for syncing session files to Firestore
const sessionSyncTimers = new Map();

async function restoreSessionFromFirestore(safeUserId, userSessionDir) {
  const credsFile = path.join(userSessionDir, "creds.json");
  if (fsSync.existsSync(credsFile)) return true;

  const db = getFirebaseServerFirestore();
  if (!db) return false;

  try {
    const { doc, getDoc } = await import("firebase/firestore");
    const docSnap = await getDoc(doc(db, "whatsapp_sessions", safeUserId));
    if (!docSnap.exists()) return false;

    const sessionData = docSnap.data();
    if (!sessionData || !sessionData.files) return false;

    await fs.mkdir(userSessionDir, { recursive: true });
    for (const [filename, fileContent] of Object.entries(sessionData.files)) {
      if (typeof fileContent === "string") {
        const filePath = path.join(userSessionDir, filename);
        await fs.writeFile(filePath, fileContent, "utf8");
      }
    }
    logger.info(`Restored WhatsApp session files from Firestore for user ${safeUserId}`);
    return fsSync.existsSync(credsFile);
  } catch (err) {
    logger.warn(`Could not restore WhatsApp session from Firestore for user ${safeUserId}`, err.message);
    return false;
  }
}

async function syncSessionToFirestore(safeUserId, userSessionDir) {
  const db = getFirebaseServerFirestore();
  if (!db) return;

  if (sessionSyncTimers.has(safeUserId)) {
    clearTimeout(sessionSyncTimers.get(safeUserId));
  }

  const timer = setTimeout(async () => {
    sessionSyncTimers.delete(safeUserId);
    try {
      if (!fsSync.existsSync(userSessionDir)) return;
      const filenames = await fs.readdir(userSessionDir);
      const filesMap = {};

      for (const filename of filenames) {
        if (filename.endsWith(".json")) {
          const filePath = path.join(userSessionDir, filename);
          try {
            const content = await fs.readFile(filePath, "utf8");
            filesMap[filename] = content;
          } catch {}
        }
      }

      if (filesMap["creds.json"]) {
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "whatsapp_sessions", safeUserId), {
          updatedAt: new Date().toISOString(),
          fileCount: Object.keys(filesMap).length,
          files: filesMap,
        }, { merge: true });
        logger.debug(`Synced WhatsApp session files to Firestore for user ${safeUserId}`);
      }
    } catch (err) {
      logger.warn(`Failed to sync WhatsApp session to Firestore for user ${safeUserId}`, err.message);
    }
  }, 1500);

  sessionSyncTimers.set(safeUserId, timer);
}

async function deleteSessionFromFirestore(safeUserId) {
  if (sessionSyncTimers.has(safeUserId)) {
    clearTimeout(sessionSyncTimers.get(safeUserId));
    sessionSyncTimers.delete(safeUserId);
  }

  const db = getFirebaseServerFirestore();
  if (!db) return;

  try {
    const { doc, deleteDoc } = await import("firebase/firestore");
    await deleteDoc(doc(db, "whatsapp_sessions", safeUserId));
    logger.info(`Deleted WhatsApp session from Firestore for user ${safeUserId}`);
  } catch (err) {
    logger.warn(`Could not delete WhatsApp session from Firestore for user ${safeUserId}`, err.message);
  }
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
import warns from "../commands/warns.js";
import clearwarns from "../commands/clearwarns.js";
import resetwarns from "../commands/resetwarns.js";
import welcome from "../commands/welcome.js";
import goodbye from "../commands/goodbye.js";

const commands = new Map([
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
  ["warns", warns],
  ["warnings", warns],
  ["warn", warns],
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

  // Device Battery Telemetry State
  let battery = {
    level: 100,
    isCharging: false,
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

  function status() {
    const expired = pairingExpiresAt > 0 && Date.now() > pairingExpiresAt;
    if (expired) {
      pairingCode = "";
      pairingExpiresAt = 0;
      pairingNumber = "";
    }
    const saved = hasSavedSession();
    const isReconnecting = state === "connecting" || Boolean(nextScheduledRetryTime && Date.now() < nextScheduledRetryTime);
    return {
      status: state,
      state,
      connected: state === "connected",
      botNumber,
      number: botNumber,
      connectedAt,
      lastActive: lastActive || connectedAt || null,
      disconnectedAt,
      hasSavedSession: saved,
      isRecoverable: saved && state !== "logged_out" && state !== "expired",
      isReconnecting,
      pairingCode: pairingCode ? cleanCode(pairingCode) : "",
      pairingCodeExpiresAt: pairingExpiresAt || null,
      pairingNumber,
      lastError,
      lastErrorCode,
      battery: { ...battery },
      reconnectLogs: reconnectLogs.slice(0, 50),
      reconnectStats: {
        currentAttempt: reconnectAttempt,
        successfulReconnects: successfulReconnectsCount,
        failedReconnects: failedReconnectsCount,
        lastReconnectSuccessTime,
        nextScheduledRetryTime,
        nextScheduledDelayMs,
        isReconnectScheduled: Boolean(nextScheduledRetryTime && Date.now() < nextScheduledRetryTime),
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

  async function handleAntiViolation({ chatId, message, sender, senderJids, protectionName, reason }) {
    let metadata = null;
    try {
      metadata = await sock.groupMetadata(chatId);
    } catch (metaErr) {
      logger.debug("Could not fetch group metadata for anti violation", metaErr.message);
    }

    const target = (metadata ? participantJid(metadata, [sender, ...senderJids]) : null) || sender;
    if (!target) return false;

    // Check if target is admin (admins are exempt from anti protections)
    if (metadata && isAdmin(metadata, [sender, ...senderJids, target])) {
      return false;
    }

    // Coordinate across multiple connected admin bots: exactly ONE bot handles this violation
    const msgId = message?.key?.id;
    if (msgId) {
      const claimed = await claimViolationEvent(chatId, msgId, target, userId);
      if (!claimed) {
        // Another connected admin bot is already handling/processing this exact violation
        return false;
      }
    }

    // 1. Remove the violating message/content
    if (message?.key?.remoteJid === chatId && message?.key?.id) {
      await sock.sendMessage(chatId, { delete: message.key }).catch((error) => {
        logger.debug?.("Could not delete violating message", error.message);
      });
    }

    // 2. Increment shared warning counter in Firebase & local store
    const warningResult = await addWarning(chatId, target, protectionName, userId);
    const { count, limit } = warningResult;
    const targetNumber = target.split("@")[0].split(":")[0];

    // 3. Send warning or enforce removal based on threshold
    if (count < limit) {
      const warningText = [
        `⚠️ *SOLVATECH WARNING ${count}/${limit}*`,
        "",
        `@${targetNumber}`,
        "",
        `Your action violated the group's *${protectionName}*.`,
        "",
        "🚫 The violating content has been removed.",
        "",
        "Please follow the group rules. Further violations may lead to removal.",
      ].join("\n");

      await sock.sendMessage(chatId, {
        text: warningText,
        mentions: [target],
      }).catch((sendErr) => logger.warn("Failed to send warning message", sendErr.message));
      return true;
    }

    if (count === limit) {
      const finalWarningText = [
        `⚠️ *SOLVATECH WARNING ${count}/${limit}*`,
        "",
        `@${targetNumber}`,
        "",
        "You have reached the group's maximum warning limit.",
        "",
        "🚫 The violating content has been removed.",
        "",
        "This is your final warning.",
        "",
        "Any further violation will result in removal from the group.",
      ].join("\n");

      await sock.sendMessage(chatId, {
        text: finalWarningText,
        mentions: [target],
      }).catch((sendErr) => logger.warn("Failed to send final warning message", sendErr.message));
      return true;
    }

    // count > limit: Warning limit exceeded on this violation -> attempt removal
    const botJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
    ].filter(Boolean).map(normalizedUser);

    const botIsAdmin = metadata ? isAdmin(metadata, botJids) : false;

    if (botIsAdmin) {
      try {
        await sock.groupParticipantsUpdate(chatId, [target], "remove");
        // Clear member warnings on successful removal
        await clearWarning(chatId, target, userId).catch(() => {});

        const removedText = [
          "🚨 *SOLVATECH WARNING LIMIT EXCEEDED*",
          "",
          `@${targetNumber}`,
          "",
          "Your warning limit has been exceeded.",
          "",
          "🚫 The violating content has been removed.",
          "",
          "👢 You have been removed from the group.",
        ].join("\n");

        await sock.sendMessage(chatId, {
          text: removedText,
          mentions: [target],
        });
        return true;
      } catch (removeErr) {
        logger.error(`Failed to remove participant ${target} from group:`, removeErr.message);
        const failText = [
          "🚨 *SOLVATECH WARNING LIMIT EXCEEDED*",
          "",
          `@${targetNumber}`,
          "",
          "Your warning limit has been exceeded.",
          "",
          "🚫 The violating content has been removed.",
          "",
          "⚠️ *Removal Notice:* I could not remove this member automatically. Please check group administrator permissions.",
        ].join("\n");

        await sock.sendMessage(chatId, {
          text: failText,
          mentions: [target],
        });
        return true;
      }
    } else {
      const noAdminText = [
        "🚨 *SOLVATECH WARNING LIMIT EXCEEDED*",
        "",
        `@${targetNumber}`,
        "",
        "Your warning limit has been exceeded.",
        "",
        "🚫 The violating content has been removed.",
        "",
        "⚠️ *Action Required:* Group admins should remove this member (Bot is not currently an administrator).",
      ].join("\n");

      await sock.sendMessage(chatId, {
        text: noAdminText,
        mentions: [target],
      });
      return true;
    }
  }

  async function handleGroupParticipantsUpdate(userId, { id: groupId, participants, action }, sock, botSentMessageIds) {
    if (!groupId || !Array.isArray(participants) || participants.length === 0) return;
    if (action !== "add" && action !== "remove") return;

    const currentBotNumber = normalizedUser(sock.user?.id || sock.user?.lid || "");
    const settings = await getGroupSettings(groupId, userId);

    // Handle AUTO WELCOME ("add")
    if (action === "add" && settings.welcome) {
      // 1. Filter out the bot itself
      const potentialNew = participants
        .map((p) => normalizedUser(p))
        .filter((num) => num && num !== currentBotNumber);

      if (potentialNew.length === 0) return;

      // 2. Distributed Event Claim: Exactly ONE connected bot session claims each join event
      const genuineNew = [];
      for (const userNum of potentialNew) {
        const claimed = await claimParticipantEvent(groupId, userNum, "add", userId);
        if (claimed) {
          genuineNew.push(userNum);
        }
      }

      if (genuineNew.length === 0) {
        // Another active bot session has already claimed and processed this join event
        return;
      }

      // Fetch dynamic group name
      let groupName = "the group";
      try {
        const meta = await sock.groupMetadata(groupId);
        if (meta?.subject) groupName = meta.subject;
      } catch {}

      const mentionJids = genuineNew.map((num) => `${num}@s.whatsapp.net`);
      const greetingNames = genuineNew.map((num) => `@${num}`).join(", ");

      const welcomeText = [
        "🎉 *WELCOME TO THE GROUP!* 🎉",
        "",
        `Hey ${greetingNames} 👋🏽`,
        "",
        `Welcome to *${groupName}*! ❤️`,
        "",
        "We're glad to have you here. Feel free to participate, connect with everyone, and enjoy the community.",
        "",
        "📌 *Please check and follow the group rules.*",
        "",
        "Once again, you're warmly welcome! 🥳❤️",
      ].join("\n");

      try {
        const sent = await sock.sendMessage(groupId, {
          text: welcomeText,
          mentions: mentionJids,
        });
        if (sent?.key?.id) {
          botSentMessageIds.add(sent.key.id);
        }
      } catch (sendErr) {
        logger.error("Failed to send auto welcome message", sendErr.message || sendErr);
      }
    }

    // Handle AUTO GOODBYE ("remove")
    if (action === "remove" && settings.goodbye) {
      // 1. Filter out the bot itself
      const potentialDeparted = participants
        .map((p) => normalizedUser(p))
        .filter((num) => num && num !== currentBotNumber);

      if (potentialDeparted.length === 0) return;

      // 2. Distributed Event Claim: Exactly ONE connected bot session claims each departure event
      const genuineDeparted = [];
      for (const userNum of potentialDeparted) {
        const claimed = await claimParticipantEvent(groupId, userNum, "remove", userId);
        if (claimed) {
          genuineDeparted.push(userNum);
        }
      }

      if (genuineDeparted.length === 0) {
        // Another active bot session has already claimed and processed this departure event
        return;
      }

      // Fetch dynamic group name
      let groupName = "the group";
      try {
        const meta = await sock.groupMetadata(groupId);
        if (meta?.subject) groupName = meta.subject;
      } catch {}

      for (const userNum of genuineDeparted) {
        const userJid = `${userNum}@s.whatsapp.net`;

        const goodbyeText = [
          `👋🏽 *GOODBYE* @${userNum}`,
          "",
          `We've noticed that you've left *${groupName}*.`,
          "",
          "Thank you for being part of the community. ❤️",
          "",
          "We wish you all the best!",
          "",
          "👋🏽 Take care and stay blessed.",
        ].join("\n");

        try {
          const sent = await sock.sendMessage(groupId, {
            text: goodbyeText,
            mentions: [userJid],
          });
          if (sent?.key?.id) {
            botSentMessageIds.add(sent.key.id);
          }
        } catch (sendErr) {
          logger.error("Failed to send auto goodbye message", sendErr.message || sendErr);
        }
      }
    }
  }

  async function processMessage(message) {
    if (!sock || !message.message) return;
    const chatId = message.key?.remoteJid;
    if (!chatId) return;

    // Ignore bot's own generated messages (DDD notifications, command responses, etc.)
    if (message.key?.id && botSentMessageIds.has(message.key.id)) {
      return;
    }

    // Record incoming message for 24h recovery or handle protocol delete
    const msgContent = getMessageContent(message);
    const protocolMsg = msgContent?.protocolMessage;
    const isRevokeProtocol = protocolMsg && (
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
      await handleDeletedMessage(userId, { targetKey, rawMessage: message, protocolMessage: protocolMsg }, sock, botSentMessageIds);
      return;
    }
    recordIncomingMessage(userId, message, sock, Boolean(message.key.fromMe));

    const senderJids = messageSenderJids(message, chatId);
    const ownJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
    ].filter(Boolean);
    const ownAliases = new Set(ownJids.flatMap(jidAliases));

    const senderIsLinkedAccount = Boolean(message.key.fromMe) ||
      senderJids.some((jid) => jidAliases(jid).some((alias) => ownAliases.has(alias)));
    const sender = message.key.fromMe
      ? normalizedUser(ownJids[0] || senderJids[0] || chatId)
      : normalizedUser(senderJids[0] || chatId);
    const text = getMessageText(message);

    try {
      if (!message.key.fromMe && isGroup(chatId)) {
        const settings = await getGroupSettings(chatId, userId);

        // Check if sender is an admin before applying anti-protections
        let senderIsAdmin = false;
        try {
          const metadata = await sock.groupMetadata(chatId);
          senderIsAdmin = isAdmin(metadata, [sender, ...senderJids]);
        } catch {}

        if (!senderIsAdmin) {
          // 1. Anti-Link Protection
          const hasExternalLink = Boolean(text) && /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/)[^\s]+/i.test(text);
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

          // 2. Anti-Status-Mention Protection (WhatsApp Status Mentions targeting the group)
          const isStatusMention = isStatusMentionMessage(message, chatId);
          if (settings.antiStatusMention && isStatusMention) {
            await handleAntiViolation({
              chatId,
              message,
              sender,
              senderJids,
              protectionName: "Anti-Status-Mention protection",
              reason: "Anti-Status-Mention violation",
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

      if (!text || !isCommand(text)) return;

      const { command, args, text: commandText } = parseCommand(text);
      let handler = commands.get(command);
      if (command === "" && text.trim() === ".") {
        handler = rd;
      }
      if (!handler) return;

      // STRICT OWNER-ONLY COMMAND RESTRICTION:
      // Commands can ONLY be triggered and executed by the linked account / owner of this bot.
      // One bot for one person: nobody else can command, trigger, or control another user's bot.
      if (!senderIsLinkedAccount) {
        return;
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

        // Clear or set success reaction on completion
        await sock.sendMessage(chatId, {
          react: { text: "✅", key: message.key },
        }).catch(() => {});
      } catch (err) {
        // Set error reaction without crashing
        await sock.sendMessage(chatId, {
          react: { text: "❌", key: message.key },
        }).catch(() => {});
        throw err;
      } finally {
        await sock.sendPresenceUpdate("paused", chatId).catch(() => {});
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

    sock.ev.on("creds.update", async () => {
      recordActivity();
      await saveCreds();
      syncSessionToFirestore(userId, userSessionDir);
    });
    sock.ev.on("messages.upsert", ({ messages }) => {
      recordActivity();
      for (const message of messages) {
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
            messageQueue.add(targetChat, () => handleDeletedMessage(userId, { targetKey, update }, sock, botSentMessageIds)).catch((error) => {
              logger.error("Queued deleted update failed", error.stack || error.message);
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
    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr, isNewLogin }) => {
      // Wait for Baileys' initial pair-device signal rather than only the
      // WebSocket opening. The latter can happen before the Noise handshake
      // is ready, which makes WhatsApp reject an otherwise valid code request.
      if (qr || connection === "open" || (connection === "connecting" && nextSocket.ws?.isOpen)) {
        resolvePairingReady();
      }

      // WhatsApp emits isNewLogin after pair-success and then intentionally
      // closes the socket with status 515 so it can reconnect authenticated.
      if (isNewLogin) {
        sessionRegistered = true;
        lastError = "";
        lastErrorCode = null;
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
        botNumber = nextSocket.user?.id?.split(":")[0]?.split("@")[0] || "";
        lastError = "";
        lastErrorCode = null;
        pairingCode = "";
        pairingExpiresAt = 0;
        pairingNumber = "";
        logger.info("WhatsApp connection opened", botNumber);

        addReconnectLog({
          type: wasReconnect ? "RECONNECT_SUCCESS" : "CONNECTED",
          reason: wasReconnect ? "Automatic reconnection established" : "WhatsApp connection opened",
          status: "SUCCESS",
          message: `Bot online and ready on +${botNumber || "WhatsApp"}`,
        });

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
        state = "connecting";
      }
      if (connection === "close") {
        disconnectedAt = new Date().toISOString();
        stopAllSpamTasks();
        if (sock !== nextSocket) return;
        const errorInfo = describeSocketError(lastDisconnect?.error);
        const wasIntentional = intentionalDisconnect;
        const isLoggedOut = errorInfo.code === DisconnectReason.loggedOut || errorInfo.code === 401;
        const isRestartRequired = errorInfo.code === DisconnectReason.restartRequired || errorInfo.code === 515;
        const pairingFailed = !isRestartRequired && !sessionRegistered && (state === "pairing" || Boolean(pairingRequest));
        const shouldReconnect = !wasIntentional
          && !isLoggedOut
          && (isRestartRequired || sessionRegistered || !pairingFailed);

        if (isLoggedOut) {
          state = "logged_out";
          lastError = "WhatsApp session logged out from phone. Please request a new pairing code.";
          lastErrorCode = "LOGGED_OUT";
          sessionRegistered = false;
          failedReconnectsCount += 1;
          nextScheduledRetryTime = null;
          nextScheduledDelayMs = 0;
          // Clear invalid session credentials on genuine WhatsApp logout
          fs.rm(userSessionDir, { recursive: true, force: true }).catch(() => {});
          deleteSessionFromFirestore(userId).catch(() => {});
          addReconnectLog({
            type: "LOGGED_OUT",
            reason: "Session terminated on phone (Logged Out)",
            statusCode: errorInfo.code,
            status: "FAILED",
            message: "Session logged out from device. Auto-reconnect aborted.",
          });
        } else {
          state = wasIntentional ? "idle" : pairingFailed ? "error" : "disconnected";
        }

        if (isRestartRequired) {
          state = "connecting";
          pairingCode = "";
          pairingExpiresAt = 0;
          pairingNumber = "";
        }

        if (!isLoggedOut) {
          lastError = wasIntentional ? "" : errorInfo.message;
          lastErrorCode = wasIntentional ? null : errorInfo.code;
        }

        if (isRestartRequired) {
          lastError = "";
          lastErrorCode = null;
        }

        if (!wasIntentional) logger.warn("WhatsApp connection closed", `${errorInfo.code || "unknown"} ${errorInfo.message}`);
        rejectPairingReady(new Error(errorInfo.message));
        sock = null;

        if (shouldReconnect) {
          reconnectAttempt += 1;
          const delay = isRestartRequired ? 1500 : Math.min(60000, 1000 * 2 ** Math.min(reconnectAttempt, 6));
          nextScheduledDelayMs = delay;
          nextScheduledRetryTime = new Date(Date.now() + delay).toISOString();
          logger.warn("Scheduling WhatsApp reconnect", `${delay}ms`);

          addReconnectLog({
            type: isRestartRequired ? "RESTART_REQUIRED" : "RECONNECT_SCHEDULED",
            reason: isRestartRequired ? "Handshake complete (515 restart required)" : (errorInfo.message || `Socket closed (status ${errorInfo.code})`),
            statusCode: errorInfo.code,
            delayMs: delay,
            attempt: reconnectAttempt,
            status: "SCHEDULED",
            message: isRestartRequired
              ? "WhatsApp handshake complete. Reconnecting instantly in 1.5s..."
              : `Socket closed (${errorInfo.code || "unknown"}). Auto-reconnecting attempt #${reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`,
          });

          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
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
        } else if (pairingFailed) {
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

  async function connect() {
    if (connecting) return connecting;
    if (sock) return sock;
    intentionalDisconnect = false;
    connecting = (async () => {
      await fs.mkdir(userSessionDir, { recursive: true });
      await restoreSessionFromFirestore(userId, userSessionDir);
      const { state: authState, saveCreds } = await useMultiFileAuthState(userSessionDir);
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
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: "silent" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        // WhatsApp's pairing-code validator expects a canonical browser label.
        // "Desktop" works for ordinary logins but can be rejected at pairing.
        browser: Browsers.macOS("Chrome"),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
      });
      bindSocket(nextSocket, saveCreds);
      sessionRegistered = authState.creds.registered;
      state = "connecting";
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
      const err = new Error(lockCheck.message);
      err.code = lockCheck.reason;
      throw err;
    }

    if (state === "connected") {
      throw new Error("A WhatsApp session is already connected. Disconnect it before requesting a new pairing code.");
    }
    if (pairingRequest) {
      throw new Error("A pairing request is currently in progress. Please wait a moment.");
    }

    // Clean up any previous stale socket or old non-connected registration files
    await disconnect();
    intentionalDisconnect = false;

    let trackedRequest;
    const request = (async () => {
      try {
        const ready = beginPairingReadyWait();
        const candidate = await connect();
        if (!candidate || candidate !== sock) throw new Error("WhatsApp connection closed before pairing.");
        if (candidate.ws?.isOpen) resolvePairingReady();
        await ready;
        if (candidate !== sock || !candidate.ws?.isOpen) {
          throw new Error("WhatsApp pairing socket closed before the pairing request was sent.");
        }

        const code = await candidate.requestPairingCode(phone);
        pairingCode = code;
        pairingExpiresAt = Date.now() + PAIRING_TTL_MS;
        pairingNumber = phone;
        state = "pairing";
        lastError = "";
        lastErrorCode = null;
        logger.info("Real WhatsApp pairing code generated", `for ${phone}; socket remains active`);
        return { code: cleanCode(code), expiresAt: pairingExpiresAt, phone };
      } catch (error) {
        const errorInfo = describeSocketError(error, "Pairing code request failed");
        if (state !== "connected") {
          state = "error";
          lastError = errorInfo.message;
          lastErrorCode = errorInfo.code;
        }
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
      return fsSync.existsSync(credsFile);
    } catch {
      return false;
    }
  }

  async function start() {
    await fs.mkdir(userSessionDir, { recursive: true });
    await restoreSessionFromFirestore(userId, userSessionDir);
    const { state: authState } = await useMultiFileAuthState(userSessionDir);
    if (!authState.creds.registered) {
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
    if (state === "connected") {
      return { success: true, message: "Bot is already connected.", status: state };
    }
    if (connecting) {
      return { success: true, message: "Reconnection is already in progress.", status: state };
    }
    clearTimeout(reconnectTimer);
    addReconnectLog({
      type: "MANUAL_RECONNECT_REQUEST",
      reason: "User initiated manual reconnection",
      status: "IN_PROGRESS",
      message: "Initiating immediate reconnection attempt...",
    });
    const result = await connect();
    return { success: Boolean(result), message: "Reconnection process initiated.", status: state };
  }

  return {
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
    isConnected: () => state === "connected",
    isConnecting: () => state === "connecting",
    getReconnectLogs: () => reconnectLogs.slice(0, 50),
    getBatteryTelemetry: () => ({ ...battery }),
    triggerManualReconnect,
  };
}

const userControllers = new Map();

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
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { collection, getDocs } = await import("firebase/firestore");
        const snap = await getDocs(collection(db, "whatsapp_sessions"));
        snap.forEach((docSnap) => {
          if (docSnap.id) uidsToRestore.add(docSnap.id);
        });
      } catch (err) {
        logger.debug("Firestore session scan notice during auto-restore", err.message);
      }
    }

    let restoredCount = 0;
    for (const userId of uidsToRestore) {
      const userSessionDir = path.join(SESSION_DIR, userId);
      try {
        await restoreSessionFromFirestore(userId, userSessionDir);
        const credsFile = path.join(userSessionDir, "creds.json");
        if (fsSync.existsSync(credsFile)) {
          const controller = getWhatsAppController(userId, { verifiedUid: userId });
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
        botNumber: st.botNumber || "",
        connectedAt: st.connectedAt || null,
        lastError: st.lastError || "",
      });
    } catch {}
  }
  return list;
}



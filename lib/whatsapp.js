import fs from "node:fs/promises";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { getGroupSettings } from "./database.js";
import path from "node:path";
import { PAIRING_TTL_MS, SESSION_DIR } from "./config.js";
import { createKeyedQueue } from "./queue.js";
import { getMessageContent, getMessageText, isCommand, isGroup, jidAliases, messageSenderJids, normalizeNumber, normalizedUser, parseCommand } from "./helpers.js";
import { isAdmin, participantJid } from "./permissions.js";
import { logger } from "./logger.js";
import { handleDeletedMessage, recordIncomingMessage } from "./deleted-messages.js";

// Import all commands
import alive from "../commands/alive.js";
import ping from "../commands/ping.js";
import menu from "../commands/menu.js";
import groupinfo from "../commands/groupinfo.js";
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

const commands = new Map([
  ["alive", alive],
  ["ping", ping],
  ["menu", menu],
  ["link", link],
  ["groupinfo", groupinfo],
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
  ["sticker", sticker],
  ["antisticker", antisticker],
  ["read", read],
  ["open", open],
  ["vv", open],
  ["rd", rd],
  ["pin", pin],
  ["spam", spam],
  ["stop", stop],
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
  const userSessionDir = options.sessionDir || (options.userId ? path.join(SESSION_DIR, options.userId) : SESSION_DIR);
  let sock = null;
  let intentionalDisconnect = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
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
    return {
      status: state,
      connected: state === "connected",
      botNumber,
      number: botNumber,
      pairingCode: pairingCode ? cleanCode(pairingCode) : "",
      pairingCodeExpiresAt: pairingExpiresAt || null,
      pairingNumber,
      lastError,
      lastErrorCode,
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

  async function enforceProtection({ chatId, message, sender, senderJids, reason, deleteMessage = true }) {
    const metadata = await sock.groupMetadata(chatId);
    const target = participantJid(metadata, [sender, ...senderJids]);
    if (!target || isAdmin(metadata, [sender, ...senderJids])) return false;

    const botJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
    ].filter(Boolean);
    if (!isAdmin(metadata, botJids)) {
      logger.warn("Anti protection could not remove a member because the bot is not a group admin", chatId);
      return false;
    }

    if (deleteMessage && message?.key?.remoteJid === chatId) {
      await sock.sendMessage(chatId, { delete: message.key }).catch((error) => {
        logger.debug?.("Could not delete anti-protection message", error.message);
      });
    }
    await sock.groupParticipantsUpdate(chatId, [target], "remove");
    await sock.sendMessage(chatId, {
      text: `❌ @${target.split("@")[0]} was removed by ${reason}.`,
      mentions: [target],
    });
    return true;
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
    if (message.message?.protocolMessage?.type === 0) {
      await handleDeletedMessage(userId, message.message, sock);
      return;
    }
    recordIncomingMessage(userId, message, sock);

    const senderJids = messageSenderJids(message, chatId);
    const ownJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
    ].filter(Boolean);
    const ownAliases = new Set(ownJids.flatMap(jidAliases));

    // Ignore messages from other SOLVATECH bot sessions to prevent cross-routing
    for (const [otherUserId, otherController] of userControllers.entries()) {
      if (otherUserId !== userId) {
        const otherSock = otherController.getSocket();
        if (otherSock?.user) {
          const otherBotAliases = [
            otherSock.user.id,
            otherSock.user.lid,
            otherSock.user.phoneNumber,
          ].filter(Boolean).flatMap(jidAliases);
          if (senderJids.some((j) => jidAliases(j).some((a) => otherBotAliases.includes(a)))) {
            return; // Ignore messages originating from other bot sessions
          }
        }
      }
    }

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
          // Antilink: kick unauthorized member on external link (no warnings)
          const hasExternalLink = Boolean(text) && /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/)[^\s]+/i.test(text);
          if (settings.antiLink && hasExternalLink) {
            await enforceProtection({
              chatId,
              message,
              sender,
              senderJids,
              reason: "anti-link protection",
            });
            return;
          }

          // Antibot: kick unauthorized member sending bot commands / automated bot activity (no warnings)
          const isBotActivity = Boolean(text) && /^\s*[.!\/#$][a-zA-Z0-9]/i.test(text);
          if (settings.antiBot && isBotActivity) {
            await enforceProtection({
              chatId,
              message,
              sender,
              senderJids,
              reason: "anti-bot protection",
            });
            return;
          }
        }
      }

      if (!text || !isCommand(text)) return;
      const { command, args, text: commandText } = parseCommand(text);
      const handler = commands.get(command);
      if (!handler) return;

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
    const originalSendMessage = nextSocket.sendMessage.bind(nextSocket);
    nextSocket.sendMessage = async (...args) => {
      const result = await originalSendMessage(...args);
      if (result?.key?.id) {
        markBotSent(result.key.id);
      }
      return result;
    };
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const message of messages) {
          messageQueue.add(message.key?.remoteJid, () => processMessage(message)).catch((error) => {
          logger.error("Queued message failed", error.stack || error.message);
        });
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
      }

      if (connection === "open") {
        reconnectAttempt = 0;
        sessionRegistered = true;
        state = "connected";
        botNumber = nextSocket.user?.id?.split(":")[0]?.split("@")[0] || "";
        lastError = "";
        lastErrorCode = null;
        pairingCode = "";
        pairingExpiresAt = 0;
        pairingNumber = "";
        logger.info("WhatsApp connection opened", botNumber);
      }
      if (connection === "connecting") state = "connecting";
      if (connection === "close") {
        if (sock !== nextSocket) return;
        const errorInfo = describeSocketError(lastDisconnect?.error);
        const wasIntentional = intentionalDisconnect;
        const isRestartRequired = errorInfo.code === DisconnectReason.restartRequired || errorInfo.code === 515;
        const pairingFailed = !isRestartRequired && (state === "pairing" || Boolean(pairingRequest));
        const shouldReconnect = !wasIntentional
          && errorInfo.code !== DisconnectReason.loggedOut
          && (isRestartRequired || !pairingFailed);
        state = wasIntentional ? "idle" : pairingFailed ? "error" : "disconnected";
        if (isRestartRequired) {
          state = "connecting";
          pairingCode = "";
          pairingExpiresAt = 0;
          pairingNumber = "";
        }
        lastError = wasIntentional ? "" : errorInfo.message;
        lastErrorCode = wasIntentional ? null : errorInfo.code;
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
          logger.warn("Scheduling WhatsApp reconnect", `${delay}ms`);
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => void connect(), delay);
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
  }

  async function start() {
    await fs.mkdir(userSessionDir, { recursive: true });
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

  return {
    userId,
    start,
    requestPairingCode,
    disconnect,
    getStatus: status,
    getSocket: () => sock,
  };
}

const userControllers = new Map();

export function getWhatsAppController(userId = "default") {
  const id = String(userId || "default").trim();
  if (!userControllers.has(id)) {
    userControllers.set(id, createWhatsAppController({ userId: id }));
  }
  return userControllers.get(id);
}
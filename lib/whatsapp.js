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
import { PAIRING_TTL_MS, SESSION_DIR } from "./config.js";
import { createKeyedQueue } from "./queue.js";
import { getMessageContent, getMessageText, isCommand, isGroup, jidAliases, messageSenderJids, normalizeNumber, normalizedUser, parseCommand } from "./helpers.js";
import { isAdmin, participantJid } from "./permissions.js";
import { logger } from "./logger.js";
import alive from "../commands/alive.js";
import ping from "../commands/ping.js";
import menu from "../commands/menu.js";
import groupinfo from "../commands/groupinfo.js";
import add from "../commands/add.js";
import kick from "../commands/kick.js";
import promote from "../commands/promote.js";
import demote from "../commands/demote.js";
import tagall from "../commands/tagall.js";
import tagadmin from "../commands/tagadmin.js";
import lock from "../commands/lock.js";
import unlock from "../commands/unlock.js";
import anti from "../commands/anti.js";
import sticker from "../commands/sticker.js";
import vv from "../commands/vv.js";

const commands = new Map([
  ["alive", alive], ["ping", ping], ["menu", menu], ["groupinfo", groupinfo],
  ["add", add], ["kick", kick], ["promote", promote], ["demote", demote], ["tagall", tagall],
  ["tagadmin", tagadmin], ["lock", lock], ["unlock", unlock], ["anti", anti],
  ["sticker", sticker], ["vv", vv],
  ["antilink", anti],
  ["antibot", anti],
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

export function createWhatsAppController() {
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
    const chatId = message.key.remoteJid;
    if (!chatId) return;
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
        const settings = await getGroupSettings(chatId);
        const hasInviteLink = Boolean(text) && /(?:https?:\/\/)?chat\.whatsapp\.com\/[A-Za-z0-9]+/i.test(text);
        if (settings.antiLink && hasInviteLink) {
          await enforceProtection({
            chatId,
            message,
            sender,
            senderJids,
            reason: "anti-link protection",
          });
          return;
        }

        if (settings.antiBot && text && /^\s*\.at(?:\s|$)/i.test(text)) {
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

      if (!text) return;
      if (!isCommand(text)) return;
      // The linked WhatsApp identity is the only command operator. Messages
      // from other people remain silent instead of exposing command behavior.
      if (!senderIsLinkedAccount) return;
      const { command, args, text: commandText } = parseCommand(text);
      const handler = commands.get(command);
      if (!handler) return;

      // Do not quote the incoming command. Quoting makes .menu, .vv, .anti,
      // etc. appear again in the other participant's or group's interface.
      // The response is still sent to the exact chat where the command
      // arrived, so it is visible to everyone in that group.
      let loading;
      let presenceTimer;
      try {
        await sock.sendPresenceUpdate("composing", chatId).catch(() => {});
        presenceTimer = setInterval(() => {
          void sock.sendPresenceUpdate("composing", chatId).catch(() => {});
        }, 3500);
        loading = await sock.sendMessage(chatId, { text: "⏳ Processing…" });
        const reply = (body, options = {}) => sock.sendMessage(chatId, { text: body, ...options });
        await handler({
          sock,
          message,
          chatId,
          sender,
          senderJids,
          args,
          command,
          text: commandText,
          startedAt: Date.now(),
          reply,
        });
      } finally {
        clearInterval(presenceTimer);
        await sock.sendPresenceUpdate("paused", chatId).catch(() => {});
        // This is intentionally a real WhatsApp message, not a local timer:
        // it disappears as soon as the command's final response is sent.
        if (loading?.key) {
          await sock.sendMessage(chatId, { delete: loading.key }).catch((error) => {
            logger.debug?.("Could not remove command loader", error.message);
          });
        }
      }
    } catch (error) {
      logger.error("Message processing failed", error.stack || error.message);
      const messageText = String(error.message || "");
      if (isCommand(text)) {
        const { command } = parseCommand(text);
        const reply = (body, options = {}) => sock.sendMessage(chatId, { text: body, ...options });
        await reply(messageText.startsWith("❌") ? messageText : `❌ The .${command} command could not be completed.`);
      }
    }
  }

  function bindSocket(nextSocket, saveCreds) {
    sock = nextSocket;
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
      await fs.mkdir(SESSION_DIR, { recursive: true });
      const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
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
    if (state === "connected" || sessionRegistered) {
      throw new Error("A WhatsApp session is already connected or registered. Disconnect it first.");
    }
    if (pairingRequest || ["connecting", "pairing"].includes(state)) {
      throw new Error("A real WhatsApp pairing attempt is already active. Enter its code or disconnect before starting again.");
    }
    if (state === "error" || state === "disconnected") {
      throw new Error("The previous WhatsApp pairing socket is closed. Disconnect it to clear the session before trying again.");
    }

    let trackedRequest;
    const request = (async () => {
      try {
        const ready = beginPairingReadyWait();
        const candidate = await connect();
        if (!candidate || candidate !== sock) throw new Error("WhatsApp connection closed before pairing.");
        if (sessionRegistered) {
          throw new Error("A WhatsApp session is already registered. Disconnect it before requesting a pairing code.");
        }
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
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
    await fs.mkdir(SESSION_DIR, { recursive: true });
  }

  async function start() {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const { state: authState } = await useMultiFileAuthState(SESSION_DIR);
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
    start,
    requestPairingCode,
    disconnect,
    getStatus: status,
    getSocket: () => sock,
  };
}
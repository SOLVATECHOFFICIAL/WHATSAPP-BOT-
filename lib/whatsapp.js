import fs from "node:fs/promises";
import fsSync from "node:fs";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  WAMessageStubType,
  proto,
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
import { checkNumberLock, lockNumberToUser } from "./number-lock.js";
import { getUserLicenseStatus } from "./license.js";
import { downloadMediaUrl } from "./media.js";

const SOLVATECH_PUBLIC_LOGO = "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";

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
  ["restart", alive],
  ["ping", ping],
  ["status", ping],
  ["menu", menu],
  ["help", menu],
  ["commands", menu],
  ["link", link],
  ["groupinfo", groupinfo],
  ["info", groupinfo],
  ["group", groupinfo],
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
  ["s", sticker],
  ["antisticker", antisticker],
  ["read", read],
  ["ocr", read],
  ["open", open],
  ["vv", open],
  ["viewonce", open],
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
  let verifiedUid = options.verifiedUid || options.userId || "";
  let userEmail = options.userEmail || "";
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

          // Antibot: kick unauthorized member sending rogue automated bot activity (no warnings)
          // Never trigger antibot on users issuing commands to this bot (.menu, .open, etc.)
          const parsed = parseCommand(text);
          const isOurBotCommand = Boolean(parsed.command && commands.has(parsed.command));
          const isBotActivity = !isOurBotCommand && Boolean(text) && /^\s*[.!\/#$][a-zA-Z0-9]/i.test(text);
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
    nextSocket.sendMessage = async (jid, content, options) => {
      let processedContent = content;
      try {
        processedContent = await prepareMediaPayload(content);
      } catch (err) {
        logger.warn("Media preparation error in sendMessage:", err.message);
      }
      const result = await originalSendMessage(jid, processedContent, options);
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
    sock.ev.on("messages.update", (updates) => {
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

        // Verify permanent WhatsApp number lock
        if (botNumber && verifiedUid) {
          const currentUid = verifiedUid;
          const currentEmail = userEmail;
          checkNumberLock(botNumber, currentUid).then((lockCheck) => {
            if (!lockCheck.allowed) {
              logger.warn(`Rejecting WhatsApp connection for ${botNumber}: ${lockCheck.message}`);
              intentionalDisconnect = true;
              try { nextSocket.ws?.close(); } catch {}
              sock = null;
              state = "error";
              lastError = lockCheck.message;
              lastErrorCode = lockCheck.reason;
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
      if (connection === "connecting") state = "connecting";
      if (connection === "close") {
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
          // Clear invalid session credentials on genuine WhatsApp logout
          fs.rm(userSessionDir, { recursive: true, force: true }).catch(() => {});
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
    const lockCheck = await checkNumberLock(phone, verifiedUid);
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

  async function stopForExpiry() {
    intentionalDisconnect = true;
    clearTimeout(reconnectTimer);
    pairingCode = "";
    pairingExpiresAt = 0;
    pairingNumber = "";
    state = "expired";
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
    stopForExpiry,
    hasSavedSession,
    setUserInfo,
    getVerifiedUid: () => verifiedUid,
    getUserEmail: () => userEmail,
    getStatus: status,
    getSocket: () => sock,
    isConnected: () => state === "connected",
    isConnecting: () => state === "connecting",
  };
}

const userControllers = new Map();

export async function restoreAllSessions() {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
    let restoredCount = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const userId = entry.name;
        const userSessionDir = path.join(SESSION_DIR, userId);
        const credsFile = path.join(userSessionDir, "creds.json");
        try {
          const stat = await fs.stat(credsFile);
          if (stat.isFile()) {
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
        } catch {
          // No valid credentials file yet for this directory
        }
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
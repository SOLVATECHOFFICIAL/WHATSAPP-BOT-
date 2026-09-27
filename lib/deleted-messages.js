import { downloadMediaMessage } from "@whiskeysockets/baileys";
import {
  getControllerSelfJid,
  getMessageContent,
  getMessageText,
  isGroup,
  isViewOnceMessage,
  jidAliases,
  mediaTypeFromMessage,
  participantNumber,
  unwrapMediaMessage,
} from "./helpers.js";
import { downloadViewOnceRobust, guessViewOnceType, viewOncePayload } from "./media.js";
import { getUserPreferences } from "./database.js";
import { logger } from "./logger.js";
import { getFirebaseServerFirestore } from "./auth.js";

async function syncDeletedMessageToFirestore(userId, record) {
  const db = getFirebaseServerFirestore();
  if (!db || !record) return;
  try {
    const { doc, setDoc } = await import("firebase/firestore");
    const docId = `${userId}_${record.id}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    await setDoc(doc(db, "deleted_messages", docId), {
      userId,
      originalId: record.id,
      remoteJid: record.remoteJid,
      sender: record.sender,
      text: record.text || "",
      mediaType: record.mediaType || null,
      deletedAt: record.deletedAt || Date.now(),
      originalTimestamp: record.originalTimestamp || Date.now(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    logger.debug(`Could not sync deleted message metadata to Firestore for user ${userId}`, err.message);
  }
}

const TTL_24_HOURS_MS = 24 * 60 * 60 * 1000;

// Scoped per userId: Map<userId, { messages: Map<string, CachedMessage>, deleted: Map<string, DeletedMessage>, recentDddAlerts: Map<string, string>, handledDeletedIds: Map<string, number>, handledViewOnceIds: Map<string, number> }>
const userStores = new Map();

function getStore(userId = "default") {
  if (!userStores.has(userId)) {
    userStores.set(userId, {
      messages: new Map(), // key: id -> cached message
      deleted: new Map(),  // key: id -> deleted message record
      recentDddAlerts: new Map(), // key: alertMessageId -> originalDeletedId
      handledDeletedIds: new Map(), // key: deletedId -> timestamp
      handledViewOnceIds: new Map(), // key: viewOnceId -> timestamp
    });
  }
  return userStores.get(userId);
}

function pruneStore(store) {
  const cutoff = Date.now() - TTL_24_HOURS_MS;
  for (const [id, msg] of store.messages.entries()) {
    if (msg.timestamp < cutoff) {
      store.messages.delete(id);
    }
  }
  for (const [id, del] of store.deleted.entries()) {
    if (del.deletedAt < cutoff) {
      store.deleted.delete(id);
    }
  }
  if (store.handledDeletedIds) {
    for (const [id, time] of store.handledDeletedIds.entries()) {
      if (time < cutoff) {
        store.handledDeletedIds.delete(id);
      }
    }
  }
  if (store.handledViewOnceIds) {
    for (const [id, time] of store.handledViewOnceIds.entries()) {
      if (time < cutoff) {
        store.handledViewOnceIds.delete(id);
      }
    }
  }

  // Bounded Memory Cap: Enforce max 300 cached messages per store to prevent OOM
  if (store.messages.size > 300) {
    const overflowCount = store.messages.size - 300;
    const keys = store.messages.keys();
    for (let i = 0; i < overflowCount; i++) {
      const firstKey = keys.next().value;
      if (firstKey) store.messages.delete(firstKey);
    }
  }
}

function isOwnIdentity(jid, sock) {
  if (!jid || !sock?.user) return false;
  const ownJids = [
    sock.user.id,
    sock.user.lid,
    sock.user.phoneNumber,
    sock.user.name,
  ].filter(Boolean);
  const ownAliases = new Set(ownJids.flatMap(jidAliases));
  return jidAliases(jid).some((alias) => ownAliases.has(alias));
}

async function resolveChatLabel(sock, remoteJid) {
  if (!remoteJid) return "Unknown Chat";
  if (!isGroup(remoteJid)) {
    const num = participantNumber(remoteJid);
    return num ? `Private Chat (@${num})` : "Private Chat";
  }
  try {
    const meta = await sock.groupMetadata(remoteJid);
    if (meta?.subject) return meta.subject;
  } catch {}
  return remoteJid;
}

/**
 * Cache an incoming message metadata for up to 24 hours.
 * Strictly ignores bot's own messages.
 * Note: Media is downloaded ON DEMAND when a message is deleted or requested,
 * avoiding pre-buffering heavy media into RAM.
 */
export function recordIncomingMessage(userId, rawMessage, sock, isOwnMessage = false) {
  if (!rawMessage?.key?.id) return;
  if (rawMessage.key.fromMe || isOwnMessage) return;

  const key = rawMessage.key;
  const id = key.id;
  const remoteJid = key.remoteJid || "";
  const sender = key.participant || rawMessage.participant || remoteJid;

  if (isOwnIdentity(sender, sock)) return;

  const store = getStore(userId);
  pruneStore(store);

  const text = getMessageText(rawMessage);
  const content = getMessageContent(rawMessage);
  const mediaType = mediaTypeFromMessage(rawMessage);

  const entry = {
    id,
    remoteJid,
    sender,
    key,
    text,
    content,
    rawMessage,
    mediaType,
    fromMe: false,
    timestamp: (Number(rawMessage.messageTimestamp) * 1000) || Date.now(),
    mediaBuffer: null,
  };

  store.messages.set(id, entry);
}

/**
 * On-demand helper to download media buffer for a cached or deleted message when requested.
 */
export async function ensureMediaDownloaded(record, sock) {
  if (!record) return null;
  if (record.mediaBuffer) return record.mediaBuffer;
  if (!record.mediaType || !record.rawMessage || !sock) return null;

  try {
    const buf = await downloadMediaMessage(record.rawMessage, "buffer", {}, {
      logger: sock.logger,
      reuploadRequest: sock.updateMediaMessage,
    });
    if (buf && buf.length > 0) {
      record.mediaBuffer = buf;
      return buf;
    }
  } catch (err) {
    logger.debug(`On-demand media download failed for message ${record.id}: ${err.message}`);
  }
  return null;
}

/**
 * Retrieve a cached incoming message by its ID for a user session.
 * Used for instant view-once recovery and quoted media lookups.
 */
export function getCachedIncomingMessage(userId, messageId) {
  if (!messageId) return null;
  const store = getStore(userId);
  return store.messages.get(messageId) || null;
}

/**
 * Send a recovered deleted message record directly to the controller's own personal DM.
 * Never sends to the group or to other participants.
 */
export async function sendDeletedRecordToPersonalDm(sock, deletedRecord, selfJid, botSentMessageIds = null) {
  if (!sock || !deletedRecord || !selfJid) return null;

  if (deletedRecord.mediaType && !deletedRecord.mediaBuffer) {
    await ensureMediaDownloaded(deletedRecord, sock);
  }

  const senderNumber = participantNumber(deletedRecord.sender || "") || "unknown";
  const timeStr = new Date(deletedRecord.originalTimestamp || Date.now()).toLocaleString();
  const chatLabel = await resolveChatLabel(sock, deletedRecord.remoteJid);
  const mentions = [deletedRecord.sender].filter((j) => j && j.includes("@") && !j.endsWith("@g.us"));

  const recordSent = (msg) => {
    if (msg?.key?.id && botSentMessageIds && typeof botSentMessageIds.add === "function") {
      botSentMessageIds.add(msg.key.id);
    }
    return msg;
  };

  if (deletedRecord.mediaBuffer && deletedRecord.mediaType) {
    const rawContent = unwrapMediaMessage(deletedRecord.rawMessage || {});
    const captionHeader = [
      `🗑️ *[DELETED ${deletedRecord.mediaType.toUpperCase()} RECOVERED]*`,
      `📍 *Chat:* ${chatLabel}`,
      `👤 *Sender:* @${senderNumber}`,
      `⏱️ *Sent At:* ${timeStr}`,
    ].join("\n");

    if (deletedRecord.mediaType === "image") {
      const sent = await sock.sendMessage(selfJid, {
        image: deletedRecord.mediaBuffer,
        caption: `${captionHeader}${deletedRecord.text ? `\n💬 *Caption:* ${deletedRecord.text}` : ""}`,
        mentions,
      });
      return recordSent(sent);
    }

    if (deletedRecord.mediaType === "video") {
      const sent = await sock.sendMessage(selfJid, {
        video: deletedRecord.mediaBuffer,
        caption: `${captionHeader}${deletedRecord.text ? `\n💬 *Caption:* ${deletedRecord.text}` : ""}`,
        mentions,
      });
      return recordSent(sent);
    }

    if (deletedRecord.mediaType === "audio") {
      const sentAudio = await sock.sendMessage(selfJid, {
        audio: deletedRecord.mediaBuffer,
        mimetype: rawContent.audioMessage?.mimetype || "audio/ogg; codecs=opus",
        ptt: Boolean(rawContent.audioMessage?.ptt),
      });
      recordSent(sentAudio);
      const sentInfo = await sock.sendMessage(selfJid, {
        text: captionHeader,
        mentions,
      });
      return recordSent(sentInfo);
    }

    if (deletedRecord.mediaType === "sticker") {
      const sentSticker = await sock.sendMessage(selfJid, {
        sticker: deletedRecord.mediaBuffer,
      });
      recordSent(sentSticker);
      const sentInfo = await sock.sendMessage(selfJid, {
        text: captionHeader,
        mentions,
      });
      return recordSent(sentInfo);
    }

    if (deletedRecord.mediaType === "document") {
      const sent = await sock.sendMessage(selfJid, {
        document: deletedRecord.mediaBuffer,
        mimetype: rawContent.documentMessage?.mimetype || "application/octet-stream",
        fileName: rawContent.documentMessage?.fileName || "recovered-file",
        caption: `${captionHeader}${deletedRecord.text ? `\n💬 *Caption:* ${deletedRecord.text}` : ""}`,
        mentions,
      });
      return recordSent(sent);
    }
  }

  if (deletedRecord.text) {
    const sent = await sock.sendMessage(selfJid, {
      text: [
        "🗑️ *[DELETED MESSAGE RECOVERED]*",
        `📍 *Chat:* ${chatLabel}`,
        `👤 *Sender:* @${senderNumber}`,
        `⏱️ *Original Time:* ${timeStr}`,
        "────────────────────────────",
        "💬 *Message:*",
        deletedRecord.text,
      ].join("\n"),
      mentions,
    });
    return recordSent(sent);
  }

  return null;
}

/**
 * Handle a protocol revoke message (Deleted Message Recovery).
 * Controlled by user's Dashboard preference (Deleted Message Recovery: OFF / ON, default OFF).
 * When OFF: Does nothing at all.
 * When ON: Automatically sends recovered content ONLY to the controller's own WhatsApp personal chat (self DM).
 */
export async function handleDeletedMessage(userId, payload, sock, botSentMessageIds = null, options = {}) {
  if (!payload || !sock) return null;

  // Check user's Deleted Message Recovery preference first (Default: OFF)
  const prefs = await getUserPreferences(userId, options.verifiedUid || userId);
  if (!prefs.deletedMessageRecovery) {
    // User has Deleted Message Recovery OFF:
    // Do nothing. Do not recover, do not send to DM, do not send any notification or group message.
    return null;
  }

  // Extract key information whether payload is a wrapped object, raw protocol message, or update
  const targetKey = payload.targetKey ||
    payload.protocolMessage?.key ||
    payload.update?.protocolMessage?.key ||
    payload.key ||
    payload;

  const originalId = targetKey?.id || payload.protocolMessage?.key?.id || payload.id;
  if (!originalId) return null;

  // 1. NEVER recover or react to bot's/controller's own deleted messages
  if (targetKey.fromMe) return null;
  if (botSentMessageIds?.has(originalId)) return null;
  if (targetKey.participant && isOwnIdentity(targetKey.participant, sock)) return null;

  const store = getStore(userId);
  pruneStore(store);

  // Deduplication: Avoid double-firing if both messages.upsert and messages.update deliver the event
  if (store.handledDeletedIds.has(originalId)) {
    return store.deleted.get(originalId) || null;
  }

  const original = store.messages.get(originalId);

  // If original was marked fromMe or sent by bot, ignore completely
  if (original?.fromMe || original?.rawMessage?.key?.fromMe) {
    store.handledDeletedIds.set(originalId, Date.now());
    return null;
  }
  if (original?.sender && isOwnIdentity(original.sender, sock)) {
    store.handledDeletedIds.set(originalId, Date.now());
    return null;
  }

  const remoteJid = targetKey.remoteJid || original?.remoteJid || payload.remoteJid || payload.chatId || "";
  if (!remoteJid) {
    return null;
  }

  // If chat is a 1-to-1 self chat with bot, ignore
  if (!isGroup(remoteJid) && isOwnIdentity(remoteJid, sock)) {
    store.handledDeletedIds.set(originalId, Date.now());
    return null;
  }

  const sender = targetKey.participant || original?.sender || (isGroup(remoteJid) ? "" : remoteJid);

  // If sender matches bot's own WhatsApp identity, ignore completely
  if (sender && isOwnIdentity(sender, sock)) {
    store.handledDeletedIds.set(originalId, Date.now());
    return null;
  }

  // Only process if we have recoverable text or media
  if (!original || (!original.text && !original.mediaType)) {
    store.handledDeletedIds.set(originalId, Date.now());
    return null;
  }

  const record = {
    id: originalId,
    key: {
      id: originalId,
      remoteJid,
      participant: sender,
      fromMe: false,
    },
    remoteJid,
    sender: sender || remoteJid,
    text: original?.text || "",
    mediaType: original?.mediaType || null,
    mediaBuffer: original?.mediaBuffer || null,
    rawMessage: original?.rawMessage || null,
    content: original?.content || null,
    deletedAt: Date.now(),
    originalTimestamp: original?.timestamp || Date.now(),
  };

  store.deleted.set(originalId, record);
  store.handledDeletedIds.set(originalId, Date.now());

  // Sync deleted message record to Firestore
  syncDeletedMessageToFirestore(userId, record);

  // Send recovered content directly to controller's own personal WhatsApp DM (NEVER to the group)
  const selfJid = getControllerSelfJid(sock, options.botNumber);
  if (selfJid) {
    try {
      await sendDeletedRecordToPersonalDm(sock, record, selfJid, botSentMessageIds);
    } catch (error) {
      logger.warn("Could not send recovered deleted message to controller personal DM", error.message);
    }
  }

  return record;
}

/**
 * Automatically recover incoming View-Once messages to the controller's personal WhatsApp DM
 * when View-Once Recovery is enabled (default ON).
 * Never sends anything to the group or to the sender.
 */
export async function handleIncomingViewOnceMessage(userId, rawMessage, sock, botSentMessageIds = null, options = {}) {
  if (!rawMessage?.key?.id || !sock) return null;
  if (rawMessage.key.fromMe) return null;
  if (!isViewOnceMessage(rawMessage)) return null;

  const key = rawMessage.key;
  const id = key.id;
  const remoteJid = key.remoteJid || "";
  if (!remoteJid || remoteJid === "status@broadcast") return null;

  const sender = key.participant || rawMessage.participant || remoteJid;
  if (isOwnIdentity(sender, sock)) return null;

  const prefs = await getUserPreferences(userId, options.verifiedUid || userId);
  if (prefs.viewOnceRecovery === false) {
    return null;
  }

  const store = getStore(userId);
  pruneStore(store);

  if (store.handledViewOnceIds.has(id)) {
    return null;
  }
  store.handledViewOnceIds.set(id, Date.now());

  const selfJid = getControllerSelfJid(sock, options.botNumber);
  if (!selfJid) return null;

  const cachedEntry = getCachedIncomingMessage(userId, id);
  const type = guessViewOnceType(rawMessage, cachedEntry);
  if (!type) return null;

  try {
    const buffer = await downloadViewOnceRobust(sock, rawMessage, cachedEntry);
    if (!buffer || buffer.length === 0) return null;

    const payload = viewOncePayload(rawMessage, buffer, type, cachedEntry);
    const senderNumber = participantNumber(sender) || "unknown";
    const chatLabel = await resolveChatLabel(sock, remoteJid);
    const mentions = [sender].filter((j) => j && j.includes("@") && !j.endsWith("@g.us"));

    const headerLines = [
      `🔓 *[VIEW-ONCE ${type.toUpperCase()} RECOVERED]*`,
      `📍 *Chat:* ${chatLabel}`,
      `👤 *Sender:* @${senderNumber}`,
    ];

    if (payload.image || payload.video) {
      const existingCaption = payload.caption ? `\n💬 *Caption:* ${payload.caption}` : "";
      payload.caption = `${headerLines.join("\n")}${existingCaption}`;
      payload.mentions = mentions;
      const sent = await sock.sendMessage(selfJid, payload);
      if (sent?.key?.id && botSentMessageIds && typeof botSentMessageIds.add === "function") {
        botSentMessageIds.add(sent.key.id);
      }
      return sent;
    }

    if (payload.audio) {
      const sentAudio = await sock.sendMessage(selfJid, payload);
      if (sentAudio?.key?.id && botSentMessageIds && typeof botSentMessageIds.add === "function") {
        botSentMessageIds.add(sentAudio.key.id);
      }
      const sentInfo = await sock.sendMessage(selfJid, {
        text: headerLines.join("\n"),
        mentions,
      });
      if (sentInfo?.key?.id && botSentMessageIds && typeof botSentMessageIds.add === "function") {
        botSentMessageIds.add(sentInfo.key.id);
      }
      return sentAudio;
    }
  } catch (err) {
    logger.debug(`Automatic view-once recovery to personal DM failed for ${id}: ${err.message}`);
  }
  return null;
}

/**
 * Retrieve a deleted message for restoration (.rd).
 * Strictly isolated by userId and chat (groups & private chats).
 */
export function getDeletedMessageForRestore(userId, chatId, quotedStanzaId = null) {
  const store = getStore(userId);
  pruneStore(store);

  // 1. If user replied to a DDD alert or deleted message ID
  if (quotedStanzaId) {
    if (store.recentDddAlerts.has(quotedStanzaId)) {
      const origId = store.recentDddAlerts.get(quotedStanzaId);
      const rec = store.deleted.get(origId) || store.messages.get(origId);
      if (rec && (!chatId || rec.remoteJid === chatId)) return rec;
    }
    if (store.deleted.has(quotedStanzaId)) {
      const rec = store.deleted.get(quotedStanzaId);
      if (rec && (!chatId || rec.remoteJid === chatId)) return rec;
    }
    if (store.messages.has(quotedStanzaId)) {
      const rec = store.messages.get(quotedStanzaId);
      if (rec && (!chatId || rec.remoteJid === chatId)) return rec;
    }
  }

  // 2. Otherwise get the most recent deleted message for this chat within 24h
  const candidates = [...store.deleted.values()]
    .filter((item) => (!chatId || item.remoteJid === chatId) && Date.now() - item.deletedAt <= TTL_24_HOURS_MS)
    .sort((a, b) => b.deletedAt - a.deletedAt);

  return candidates[0] || null;
}

/**
 * Store and manage known contact JIDs for status broadcasts
 */
export function registerKnownContacts(userId = "default", jidList = []) {
  const store = getStore(userId);
  if (!store.contacts) store.contacts = new Set();
  for (const jid of jidList) {
    if (typeof jid === "string" && (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"))) {
      store.contacts.add(jid);
    }
  }
}

/**
 * Retrieve unique contact JIDs from recent session history and registered contacts to populate status broadcast distribution.
 */
export function getKnownContactJids(userId = "default") {
  const store = getStore(userId);
  const jids = new Set(store.contacts ? Array.from(store.contacts) : []);
  for (const msg of store.messages.values()) {
    if (msg.sender && typeof msg.sender === "string" && (msg.sender.endsWith("@s.whatsapp.net") || msg.sender.endsWith("@lid"))) {
      jids.add(msg.sender);
    }
    if (msg.remoteJid && typeof msg.remoteJid === "string" && (msg.remoteJid.endsWith("@s.whatsapp.net") || msg.remoteJid.endsWith("@lid"))) {
      jids.add(msg.remoteJid);
    }
  }
  return Array.from(jids);
}



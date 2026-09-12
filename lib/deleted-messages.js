import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { getMessageContent, getMessageText, mediaTypeFromMessage, unwrapMediaMessage } from "./helpers.js";
import { logger } from "./logger.js";

const TTL_24_HOURS_MS = 24 * 60 * 60 * 1000;

// Scoped per userId: Map<userId, { messages: Map<string, CachedMessage>, deleted: Map<string, DeletedMessage> }>
const userStores = new Map();

function getStore(userId = "default") {
  if (!userStores.has(userId)) {
    userStores.set(userId, {
      messages: new Map(), // key: id -> cached message
      deleted: new Map(),  // key: id -> deleted message record
      recentDddAlerts: new Map(), // key: alertMessageId -> originalDeletedId
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
}

/**
 * Cache an incoming message for up to 24 hours.
 */
export function recordIncomingMessage(userId, rawMessage, sock) {
  if (!rawMessage?.key?.id) return;
  const store = getStore(userId);
  pruneStore(store);

  const key = rawMessage.key;
  const id = key.id;
  const remoteJid = key.remoteJid || "";
  const sender = key.participant || rawMessage.participant || remoteJid;
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
    timestamp: (Number(rawMessage.messageTimestamp) * 1000) || Date.now(),
    mediaBuffer: null,
  };

  // If message has media and is small, pre-buffer or store reference
  if (mediaType && sock) {
    // We can lazily download or attempt buffer download in background
    downloadMediaMessage(rawMessage, "buffer", {}, {
      logger: sock.logger,
      reuploadRequest: sock.updateMediaMessage,
    }).then((buf) => {
      if (buf && buf.length > 0 && buf.length < 25 * 1024 * 1024) {
        entry.mediaBuffer = buf;
      }
    }).catch(() => {});
  }

  store.messages.set(id, entry);
}

/**
 * Handle a protocol revoke message (DDD - Deleted Message Detected).
 */
export async function handleDeletedMessage(userId, protocolMsg, sock) {
  const store = getStore(userId);
  pruneStore(store);

  const deletedKey = protocolMsg.protocolMessage?.key;
  if (!deletedKey?.id) return null;

  const originalId = deletedKey.id;
  const original = store.messages.get(originalId);
  const remoteJid = deletedKey.remoteJid || original?.remoteJid || "";
  const sender = deletedKey.participant || original?.sender || "";

  const record = {
    id: originalId,
    key: deletedKey,
    remoteJid,
    sender,
    text: original?.text || "",
    mediaType: original?.mediaType || null,
    mediaBuffer: original?.mediaBuffer || null,
    rawMessage: original?.rawMessage || null,
    content: original?.content || null,
    deletedAt: Date.now(),
    originalTimestamp: original?.timestamp || Date.now(),
  };

  store.deleted.set(originalId, record);

  // Send automatic DDD reply associated with that specific deleted message
  try {
    const alertMsg = await sock.sendMessage(remoteJid, {
      text: "DDD",
    }, original?.rawMessage ? { quoted: original.rawMessage } : {});

    if (alertMsg?.key?.id) {
      store.recentDddAlerts.set(alertMsg.key.id, originalId);
    }
  } catch (error) {
    logger.warn("Could not send automatic DDD alert notification", error.message);
  }

  return record;
}

/**
 * Retrieve a deleted message for restoration (.rd).
 * Strictly isolated by userId and group (chatId).
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
    .filter((item) => item.remoteJid === chatId && Date.now() - item.deletedAt <= TTL_24_HOURS_MS)
    .sort((a, b) => b.deletedAt - a.deletedAt);

  return candidates[0] || null;
}

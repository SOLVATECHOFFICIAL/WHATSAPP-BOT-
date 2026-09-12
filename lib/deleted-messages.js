import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { getMessageContent, getMessageText, jidAliases, mediaTypeFromMessage, unwrapMediaMessage } from "./helpers.js";
import { logger } from "./logger.js";

const TTL_24_HOURS_MS = 24 * 60 * 60 * 1000;

// Scoped per userId: Map<userId, { messages: Map<string, CachedMessage>, deleted: Map<string, DeletedMessage>, recentDddAlerts: Map<string, string> }>
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

/**
 * Cache an incoming message for up to 24 hours.
 * Strictly ignores bot's own messages.
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

  // If message has media and is small, pre-buffer or store reference
  if (mediaType && sock) {
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
 * Works in BOTH groups and 1-to-1/private chats.
 * Strictly ignores bot's own deleted messages.
 */
export async function handleDeletedMessage(userId, protocolMsg, sock, botSentMessageIds = null) {
  const deletedKey = protocolMsg.protocolMessage?.key || protocolMsg.key;
  if (!deletedKey?.id) return null;

  // 1. NEVER reply to or store bot's own deleted messages
  if (deletedKey.fromMe) return null;
  if (botSentMessageIds?.has(deletedKey.id)) return null;

  const store = getStore(userId);
  pruneStore(store);

  const originalId = deletedKey.id;
  const original = store.messages.get(originalId);

  // If original was marked fromMe or sent by bot, ignore completely
  if (original?.fromMe || original?.rawMessage?.key?.fromMe) return null;

  const remoteJid = deletedKey.remoteJid || original?.remoteJid || "";
  if (!remoteJid) return null;

  const sender = deletedKey.participant || original?.sender || (remoteJid.endsWith("@g.us") ? "" : remoteJid);

  // If sender matches bot's own WhatsApp identity, ignore completely
  if (isOwnIdentity(sender, sock)) return null;

  const record = {
    id: originalId,
    key: deletedKey,
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

  // Send automatic OKAY DELETED reply associated with that specific deleted message
  // Works in both groups and 1-to-1 private chats (member or admin)
  try {
    const alertMsg = await sock.sendMessage(remoteJid, {
      text: "OKAY DELETED",
    }, original?.rawMessage ? { quoted: original.rawMessage } : {});

    if (alertMsg?.key?.id) {
      store.recentDddAlerts.set(alertMsg.key.id, originalId);
    }
  } catch (error) {
    logger.warn("Could not send automatic OKAY DELETED alert notification", error.message);
  }

  return record;
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

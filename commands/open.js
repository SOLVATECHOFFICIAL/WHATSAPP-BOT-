import { downloadViewOnceRobust, guessViewOnceType, viewOncePayload } from "../lib/media.js";
import { getControllerSelfJid, getQuotedMessage, isGroup, participantNumber } from "../lib/helpers.js";
import { getCachedIncomingMessage, getLatestViewOnceMessageForChat } from "../lib/deleted-messages.js";

export default async function open({ sock, message, chatId, reply, userId = "default", botNumber = "" }) {
  const quoted = getQuotedMessage(message);
  let source = quoted || message;

  // Retrieve cached incoming message if quoted
  const quotedId = quoted?.id || quoted?.stanzaId || quoted?.key?.id;
  let cachedEntry = quotedId ? getCachedIncomingMessage(userId, quotedId) : null;

  let type = guessViewOnceType(source, cachedEntry);

  // If the user didn't quote the view-once directly (e.g., said "open the viewonce"),
  // automatically look up the most recent view-once message in this chat.
  if (!type) {
    const latestInChat = getLatestViewOnceMessageForChat(userId, chatId);
    if (latestInChat) {
      cachedEntry = latestInChat;
      source = latestInChat.rawMessage || source;
      type = guessViewOnceType(source, cachedEntry);
    }
  }

  if (!type) {
    return reply("❌ No recent view-once photo, video, or voice note found in this chat. Reply directly to a view-once message to open it.");
  }

  const selfJid = getControllerSelfJid(sock, botNumber) || chatId;

  try {
    const buffer = await downloadViewOnceRobust(sock, source, cachedEntry);
    if (!buffer || buffer.length === 0) {
      return reply(`❌ Could not retrieve the view-once ${type}. It may have expired.`);
    }

    const payload = viewOncePayload(source, buffer, type, cachedEntry);
    const senderJid = quoted?.participant || cachedEntry?.sender || message.key?.participant || "";
    const senderNum = participantNumber(senderJid) || "";

    if (isGroup(chatId) && (payload.image || payload.video)) {
      let groupLabel = chatId;
      try {
        const meta = await sock.groupMetadata(chatId);
        if (meta?.subject) groupLabel = meta.subject;
      } catch {}
      const header = [
        `🔓 *[VIEW-ONCE ${type.toUpperCase()} RECOVERED]*`,
        `📍 *Chat:* ${groupLabel}`,
        ...(senderNum ? [`👤 *Sender:* @${senderNum}`] : []),
      ].join("\n");
      payload.caption = `${header}${payload.caption ? `\n💬 *Caption:* ${payload.caption}` : ""}`;
      if (senderJid && !senderJid.endsWith("@g.us")) {
        payload.mentions = [senderJid];
      }
    }

    await sock.sendMessage(selfJid, payload);

    // React ✅ and immediately delete the .open / .vv command message in the chat or group
    message._alreadyReactedAndDeleted = true;
    await sock.sendMessage(chatId, {
      react: { text: "✅", key: message.key },
    }).catch(() => {});
    await sock.sendMessage(chatId, {
      delete: message.key,
    }).catch(() => {});
  } catch (error) {
    await sock.sendMessage(selfJid, {
      text: `❌ Could not recover view-once ${type}: ${error.message || "Failed to decrypt media"}`,
    });
  }
}


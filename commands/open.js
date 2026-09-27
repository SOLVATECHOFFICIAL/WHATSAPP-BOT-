import { downloadViewOnceRobust, guessViewOnceType, viewOncePayload } from "../lib/media.js";
import { getControllerSelfJid, getQuotedMessage, isGroup, participantNumber } from "../lib/helpers.js";
import { getCachedIncomingMessage } from "../lib/deleted-messages.js";

export default async function open({ sock, message, chatId, reply, userId = "default", botNumber = "" }) {
  const quoted = getQuotedMessage(message);
  const source = quoted || message;

  // Retrieve cached incoming message if quoted
  const quotedId = quoted?.id || quoted?.stanzaId || quoted?.key?.id;
  const cachedEntry = quotedId ? getCachedIncomingMessage(userId, quotedId) : null;

  const type = guessViewOnceType(source, cachedEntry);

  if (!type) {
    return reply("❌ Reply to a view-once photo, video, audio, or voice note with *.open* (or *.vv*).");
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
  } catch (error) {
    await sock.sendMessage(selfJid, {
      text: `❌ Could not recover view-once ${type}: ${error.message || "Failed to decrypt media"}`,
    });
  }
}


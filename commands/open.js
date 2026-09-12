import { downloadViewOnceRobust, guessViewOnceType, viewOncePayload } from "../lib/media.js";
import { getQuotedMessage } from "../lib/helpers.js";
import { getCachedIncomingMessage } from "../lib/deleted-messages.js";

export default async function open({ sock, message, reply, userId = "default" }) {
  const quoted = getQuotedMessage(message);
  const source = quoted || message;

  // Retrieve cached incoming message if quoted
  const quotedId = quoted?.id || quoted?.stanzaId || quoted?.key?.id;
  const cachedEntry = quotedId ? getCachedIncomingMessage(userId, quotedId) : null;

  const type = guessViewOnceType(source, cachedEntry);

  if (!type) {
    return reply("❌ Reply to a view-once photo, video, audio, or voice note with *.open* (or *.vv*).");
  }

  try {
    const buffer = await downloadViewOnceRobust(sock, source, cachedEntry);
    if (!buffer || buffer.length === 0) {
      return reply(`❌ Could not retrieve the view-once ${type}. It may have expired.`);
    }

    const payload = viewOncePayload(source, buffer, type, cachedEntry);
    const targetChat = message.key.remoteJid;
    await sock.sendMessage(targetChat, payload);
  } catch (error) {
    await reply(`❌ Could not recover view-once ${type}: ${error.message || "Failed to decrypt media"}`);
  }
}

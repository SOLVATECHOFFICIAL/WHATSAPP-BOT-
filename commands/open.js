import { downloadViewOnceRobust, guessViewOnceType, viewOncePayload } from "../lib/media.js";
import { getQuotedMessage } from "../lib/helpers.js";

export default async function open({ sock, message, reply }) {
  const source = getQuotedMessage(message) || message;
  const type = guessViewOnceType(source);

  if (!type) {
    return reply("❌ Reply to or send a view-once photo, video, audio, or voice note with *.open*.");
  }

  try {
    const buffer = await downloadViewOnceRobust(sock, source);
    if (!buffer || buffer.length === 0) {
      return reply(`❌ Could not retrieve the view-once ${type}. It may have already expired.`);
    }
    const payload = viewOncePayload(source, buffer, type);
    await sock.sendMessage(message.key.remoteJid, payload);
  } catch (error) {
    await reply(`❌ Could not recover view-once ${type}: ${error.message || "Failed to decrypt media"}`);
  }
}

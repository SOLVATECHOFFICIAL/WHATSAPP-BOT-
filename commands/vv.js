import { downloadViewOnceRobust, guessViewOnceType, viewOncePayload } from "../lib/media.js";
import { getQuotedMessage } from "../lib/helpers.js";

export default async function vv({ sock, message, reply }) {
  const source = getQuotedMessage(message);
  if (!source) return reply("❌ Reply to a view-once image, video, voice note, audio, or document with .vv.");
  const type = guessViewOnceType(source);
  if (!type) return reply("❌ Reply to a view-once image, video, voice note, audio, or document with .vv.");
  try {
    const buffer = await downloadViewOnceRobust(sock, source);
    await sock.sendMessage(message.key.remoteJid, viewOncePayload(source, buffer, type));
  } catch (error) {
    await reply(`❌ Could not recover that view-once ${type}. It may have expired or already been removed.`);
  }
}
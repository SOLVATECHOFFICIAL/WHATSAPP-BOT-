import { mentionMembers } from "../lib/command-tools.js";
import { isGroup } from "../lib/helpers.js";

export default async function tagall({ sock, chatId, text, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ *Group Only:* This command only works inside WhatsApp groups.");
  }
  const metadata = await sock.groupMetadata(chatId);
  const heading = text
    ? `📢 *GROUP ANNOUNCEMENT:*\n_${text}_\n`
    : "📢 *ATTENTION EVERYONE*";
  const result = await mentionMembers(metadata, heading);
  await reply(result.text, { mentions: result.mentions });
}
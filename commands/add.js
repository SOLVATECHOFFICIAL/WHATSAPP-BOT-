import { normalizeNumber } from "../lib/helpers.js";
import { requireAdmin } from "../lib/command-tools.js";

export default async function add({ sock, chatId, sender, senderJids, senderIsLinkedAccount, args, reply }) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const number = normalizeNumber(args[0]);
  if (!number || number.length < 7) return reply("❌ *Invalid Number:* Please provide a valid phone number including country code.\n_Example: *.add 2349049979183*_");
  try {
    await sock.groupParticipantsUpdate(chatId, [`${number}@s.whatsapp.net`], "add");
    await reply(`✅ *Success:* Added *+${number}* to the group.`);
  } catch (error) {
    await reply("❌ *Failed:* Could not add that number. Ensure the bot has admin rights and the user allows group invites.");
    throw error;
  }
  return metadata;
}
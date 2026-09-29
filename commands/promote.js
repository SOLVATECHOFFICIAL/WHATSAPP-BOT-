import { requireAdmin, findTarget } from "../lib/command-tools.js";

export default async function promote({ sock, chatId, sender, senderJids, senderIsLinkedAccount, message, reply }) {
  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const target = findTarget(message);
  if (!target) return reply("❌ *Target Missing:* Please tag or reply to the member you want to promote.\n_Example: *.promote @user*_");
  await sock.groupParticipantsUpdate(chatId, [target], "promote");
  await reply(`⭐ *Promoted:* @${target.split("@")[0]} is now a *Group Administrator*.`, { mentions: [target] });
}
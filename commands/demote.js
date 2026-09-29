import { requireAdmin, findTarget, targetIsOwner } from "../lib/command-tools.js";

export default async function demote({ sock, chatId, sender, senderJids, senderIsLinkedAccount, message, reply }) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const target = findTarget(message);
  if (!target) return reply("❌ *Target Missing:* Please tag or reply to the admin you want to demote.\n_Example: *.demote @user*_");
  if (targetIsOwner(metadata, target)) return reply("👑 *Owner Protected:* _The group creator/owner cannot be demoted._");
  await sock.groupParticipantsUpdate(chatId, [target], "demote");
  await reply(`👤 *Demoted:* @${target.split("@")[0]} has been demoted to a regular member.`, { mentions: [target] });
}
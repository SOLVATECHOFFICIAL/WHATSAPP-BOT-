import { requireAdmin, findTarget, targetIsAdmin, targetIsOwner } from "../lib/command-tools.js";

export default async function kick({ sock, chatId, sender, senderJids, senderIsLinkedAccount, message, reply }) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const target = findTarget(message);
  if (!target) return reply("❌ *Target Missing:* Please tag or reply to the user you wish to remove.\n_Example: *.kick @user*_");
  if (targetIsAdmin(metadata, target) || targetIsOwner(metadata, target)) return reply("🛡️ *Protection Notice:* _Group administrators and owners cannot be removed via bot commands._");
  await sock.groupParticipantsUpdate(chatId, [target], "remove");
  await reply(`🚪 *Removed:* @${target.split("@")[0]} has been removed from the group.`, { mentions: [target] });
}
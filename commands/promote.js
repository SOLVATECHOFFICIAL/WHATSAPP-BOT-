import { requireAdmin, findTarget } from "../lib/command-tools.js";

export default async function promote({ sock, chatId, sender, senderJids, message, reply }) {
  await requireAdmin(sock, chatId, sender, true, senderJids);
  const target = findTarget(message);
  if (!target) return reply("❌ Please mention a user.");
  await sock.groupParticipantsUpdate(chatId, [target], "promote");
  await reply(`✅ Promoted @${target.split("@")[0]}.`, { mentions: [target] });
}
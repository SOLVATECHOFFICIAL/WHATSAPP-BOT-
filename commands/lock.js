import { requireAdmin } from "../lib/command-tools.js";

export default async function lock({ sock, chatId, sender, senderJids, reply }) {
  await requireAdmin(sock, chatId, sender, true, senderJids);
  await sock.groupSettingUpdate(chatId, "announcement");
  await reply("🔒 Group locked. Only admins can send messages.");
}
import { requireAdmin } from "../lib/command-tools.js";

export default async function unlock({ sock, chatId, sender, senderJids, senderIsLinkedAccount, reply }) {
  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  await sock.groupSettingUpdate(chatId, "not_announcement");
  await reply([
    "╭━━〔 🔓 *GROUP UNLOCK ACTIVATED* 〕━━╮",
    "",
    "┃ 🔓 *Messaging:* _All Members_",
    "┃ 💬 *Status:* _Group open_",
    "",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    "_All group members can send messages now._",
  ].join("\n"));
}
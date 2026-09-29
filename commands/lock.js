import { requireAdmin } from "../lib/command-tools.js";

export default async function lock({ sock, chatId, sender, senderJids, senderIsLinkedAccount, reply }) {
  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  await sock.groupSettingUpdate(chatId, "announcement");
  await reply([
    "╭━━〔 🔒 *GROUP LOCK ACTIVATED* 〕━━╮",
    "",
    "┃ 🔒 *Messaging:* _Admins Only_",
    "┃ 🛡️ *Status:* _Group restricted_",
    "",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    "_Only group administrators can send messages now._",
  ].join("\n"));
}
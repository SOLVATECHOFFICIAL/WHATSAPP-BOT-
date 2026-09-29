import { requireAdmin } from "../lib/command-tools.js";
import { getQuotedMessage, isGroup } from "../lib/helpers.js";

export default async function pin({ sock, message, chatId, sender, senderJids, senderIsLinkedAccount, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ *Group Only:* This command only works inside WhatsApp groups.");
  }

  const quoted = getQuotedMessage(message);
  if (!quoted?.key) {
    return reply("❌ *Target Missing:* Please reply directly to the message you want to pin with *.pin*.");
  }

  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);

  try {
    // Pin message for 7 days (604800 seconds)
    await sock.sendMessage(chatId, {
      pin: quoted.key,
      type: 1, // 1 = PIN, 2 = UNPIN
      time: 604800, // 7 days in seconds
    });
    await reply([
      "╭━━〔 📌 *MESSAGE PINNED* 〕━━╮",
      "",
      "┃ ⏱️ *Duration:* _7 Days_",
      "┃ 🟢 *Status:* _Pinned at top of group_",
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n"));
  } catch (error) {
    await reply(`❌ *Pin Failed:* ${error.message || "Permission denied or pin unsupported"}`);
  }
}

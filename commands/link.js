import { isGroup } from "../lib/helpers.js";

export default async function link({ sock, chatId, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ *Group Only:* This command only works inside WhatsApp groups.");
  }
  try {
    const code = await sock.groupInviteCode(chatId);
    if (!code) {
      return reply("❌ *Unavailable:* Could not retrieve group invite link. Ensure the bot is an admin.");
    }
    await reply([
      "╭━━〔 🔗 *GROUP INVITATION LINK* 〕━━╮",
      "",
      `┃ 🌐 *Link:* https://chat.whatsapp.com/${code}`,
      "┃ 🛡️ *Access:* _Official WhatsApp Group Invite_",
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n"));
  } catch (error) {
    if (error?.data === 403 || error?.output?.statusCode === 403 || String(error?.message || "").includes("admin")) {
      return reply("🛡️ *Admin Required:* _I need group administrator privileges to generate the invite link._");
    }
    return reply(`❌ *Error:* Could not retrieve group invite link: ${error.message || "Permission denied"}`);
  }
}

import { isGroup } from "../lib/helpers.js";

export default async function groupinfo({ sock, chatId, reply }) {
  if (!isGroup(chatId)) {
    return reply("❌ This command only works in groups.");
  }
  const metadata = await sock.groupMetadata(chatId);
  const admins = (metadata.participants || []).filter((item) => item.admin);
  const owner = metadata.owner || metadata.ownerPn || metadata.subjectOwner || "Unavailable";

  await reply([
    `╭━━〔 ${metadata.subject} 〕━━╮`,
    `┃ 🏷️ *ID:* ${chatId}`,
    `┃ 👑 *Owner:* @${owner.split("@")[0]}`,
    `┃ 👥 *Members:* ${metadata.participants.length}`,
    `┃ ⭐ *Admins:* ${admins.length}`,
    "╰━━━━━━━━━━━━━━━━━━━━━━╯",
  ].join("\n"), {
    mentions: [owner].filter((j) => j && j.includes("@")),
  });
}
export default async function groupinfo({ sock, chatId, reply }) {
  const metadata = await sock.groupMetadata(chatId);
  const admins = metadata.participants.filter((item) => item.admin);
  await reply([
    `╭━━〔 ${metadata.subject} 〕━━╮`,
    `┃ ID: ${chatId}`,
    `┃ Owner: ${metadata.owner || "Unavailable"}`,
    `┃ Members: ${metadata.participants.length}`,
    `┃ Admins: ${admins.length}`,
    "╰━━━━━━━━━━━━━━━━━━━━━━╯",
  ].join("\n"));
}
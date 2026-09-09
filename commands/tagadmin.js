import { mentionAdmins } from "../lib/command-tools.js";

export default async function tagadmin({ sock, chatId, reply }) {
  const metadata = await sock.groupMetadata(chatId);
  const result = await mentionAdmins(metadata);
  await reply(result.text, { mentions: result.mentions });
}
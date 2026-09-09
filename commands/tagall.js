import { mentionMembers } from "../lib/command-tools.js";

export default async function tagall({ sock, chatId, text, reply }) {
  const metadata = await sock.groupMetadata(chatId);
  const result = await mentionMembers(metadata, text);
  await reply(result.text, { mentions: result.mentions });
}
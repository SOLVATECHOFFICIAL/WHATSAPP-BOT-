import { BOT_NAME, OWNER_NAME } from "../lib/config.js";

export default async function alive({ reply }) {
  await reply(`${BOT_NAME} is online. Owner: ${OWNER_NAME}`);
}
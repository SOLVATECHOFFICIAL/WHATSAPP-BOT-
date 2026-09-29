import { BOT_NAME, OWNER_NAME } from "../lib/config.js";

const SOLVATECH_LOGO_URL = "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";

export default async function alive({ reply }) {
  await reply({
    image: SOLVATECH_LOGO_URL,
    caption: [
      "╭━━〔 ⚡ *SOLVATECH BOT STATUS* 〕━━╮",
      "",
      `┃ 🤖 *Bot Engine:* *${BOT_NAME}*`,
      `┃ 👑 *Developer:* *${OWNER_NAME}*`,
      "┃ 🟢 *Operational State:* _Active & Listening_",
      "┃ 🛡️ *System Health:* _100% Operational_",
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "_Type *.menu* for the complete list of commands._",
    ].join("\n"),
  });
}

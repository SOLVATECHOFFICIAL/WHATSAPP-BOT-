export default async function owner({ reply }) {
  // Official, immutable SOLVATECH BOT developer/owner contact
  const OWNER_NAME = "SOLVATECH OFFICIAL";
  const OWNER_PHONE = "+234 904 997 9183";
  const OWNER_WA_LINK = "https://wa.me/2349049979183";
  const OFFICIAL_SITE = "https://solvatech.name.ng";

  const message = [
    "╭━━〔 👑 *SOLVATECH BOT DEVELOPER & OWNER* 〕━━╮",
    "",
    `┃ 👤 *Official Name:* *${OWNER_NAME}*`,
    `┃ 📞 *Direct Phone:* *${OWNER_PHONE}*`,
    `┃ 💬 *WhatsApp Chat:* _${OWNER_WA_LINK}_`,
    `┃ 🌐 *Official Portal:* _${OFFICIAL_SITE}_`,
    "┃ 🛡️ *License & Tech Support:* _24/7 Active_",
    "",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    `_For official bot upgrades, license renewals, custom AI tools, or developer inquiries, message *${OWNER_NAME}* directly._`,
  ].join("\n");

  await reply(message);
}

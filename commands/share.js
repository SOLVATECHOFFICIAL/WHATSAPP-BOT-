import { formatReferralLink, getReferralStats, ensureUserReferralData } from "../lib/referral.js";

export default async function share({
  reply,
  userId = "default",
  verifiedUid = "",
  userEmail = "",
  text = "",
  message,
}) {
  let referralLink = "https://solvatech.name.ng/";

  const effectiveUid =
    verifiedUid && verifiedUid !== "default"
      ? verifiedUid
      : userId && userId !== "default"
      ? userId
      : "";

  if (effectiveUid) {
    try {
      const stats = await getReferralStats(effectiveUid);
      if (stats?.referralLink) {
        referralLink = stats.referralLink;
      } else if (stats?.referralCode) {
        referralLink = formatReferralLink(stats.referralCode);
      } else {
        const ensured = await ensureUserReferralData(effectiveUid, userEmail);
        if (ensured?.referralLink) {
          referralLink = ensured.referralLink;
        }
      }
    } catch {
      referralLink = "https://solvatech.name.ng/";
    }
  }

  const shareText = [
    "╔════ *SOLVATECH BOT* ════╗",
    "",
    "🤖 *Want your own WhatsApp bot?*",
    "",
    "Get your own *SOLVATECH BOT* and enjoy useful WhatsApp automation features including:",
    "",
    "• Deleted-message recovery",
    "• Stickers & media tools",
    "• Group administration",
    "• Anti-link / anti-bot protection",
    "• OCR",
    "• View-once tools",
    "• Group utilities",
    "• Bot status & more",
    "",
    "🌐 *GET YOUR BOT:*",
    referralLink,
    "",
    "*HOW TO START*",
    "",
    "1️⃣ Open the website.",
    "2️⃣ Tap *ENTER DASHBOARD*.",
    "3️⃣ Sign in with Google.",
    "4️⃣ Get a *SOLVATECH BOT* license key.",
    "5️⃣ Enter your license key.",
    "6️⃣ Follow the dashboard instructions to connect your WhatsApp.",
    "",
    "🎁 *REFER & EARN*",
    "",
    "You can also refer friends and earn *3 FREE DAYS* when your qualifying referral purchases reach ₦1,000.",
    "",
    "╚══════════════════════════╝",
  ].join("\n");

  // Optional mention handling if @user was tagged
  const mentions = [];
  if (text) {
    const rawMatches = text.match(/\b\d{7,15}\b/g) || [];
    for (const num of rawMatches) {
      const jid = `${num}@s.whatsapp.net`;
      if (!mentions.includes(jid)) mentions.push(jid);
    }
  }
  if (message?.message?.extendedTextMessage?.contextInfo?.mentionedJid) {
    for (const jid of message.message.extendedTextMessage.contextInfo.mentionedJid) {
      if (!mentions.includes(jid)) mentions.push(jid);
    }
  }

  const options = mentions.length > 0 ? { mentions } : {};
  await reply(shareText, options);
}

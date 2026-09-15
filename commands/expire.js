import { getUserLicenseStatus } from "../lib/license.js";

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (parts.length === 0 || (days === 0 && hours === 0)) {
    parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

export default async function expire({
  reply,
  userId = "default",
  verifiedUid = "",
  userEmail = "",
  botNumber = "",
  sender = "",
  sock,
}) {
  try {
    // Resolve real user identifier from all available sources: phone number, verifiedUid, email, or userId
    const phone =
      botNumber ||
      (typeof sender === "string" ? sender.split("@")[0].replace(/\D/g, "") : "") ||
      sock?.user?.id?.split(":")[0]?.split("@")[0] ||
      (typeof userId === "string" && /^\d+$/.test(userId) ? userId : "");

    const effectiveUid =
      verifiedUid && verifiedUid !== "default"
        ? verifiedUid
        : userId && userId !== "default"
        ? userId
        : "";

    // Read authoritative license status for this specific real user
    const licenseStatus = await getUserLicenseStatus(effectiveUid, userEmail, phone);

    if (licenseStatus.isAdmin) {
      return reply([
        "🔑 *SOLVATECH BOT LICENSE STATUS*",
        "────────────────────────────",
        "┃ 🛡️ *License Type:* Admin Unlimited",
        "┃ 🟢 *Status:* Active (Permanent)",
        "┃ ⏳ *Remaining:* Unlimited (No Expiration)",
        "╰────────────────────────────",
      ].join("\n"));
    }

    if (!licenseStatus.expiresAt) {
      return reply([
        "🔑 *SOLVATECH BOT LICENSE STATUS*",
        "────────────────────────────",
        "┃ ⚠️ *Status:* No Active License Found",
        "┃ ℹ️ *Details:* This account has not redeemed a license key yet.",
        "┃ 💡 *Tip:* Redeem your license key in the web console or contact the owner.",
        "╰────────────────────────────",
      ].join("\n"));
    }

    const now = Date.now();
    const expiryDate = new Date(licenseStatus.expiresAt);
    const expiryMs = expiryDate.getTime();
    const diffMs = expiryMs - now;

    const expiryFormattedDate = expiryDate.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });

    if (diffMs > 0) {
      // Active license
      const remainingStr = formatDuration(diffMs);
      return reply([
        "🔑 *SOLVATECH BOT LICENSE STATUS*",
        "────────────────────────────",
        "┃ 🟢 *Status:* Active",
        `┃ ⏳ *Time Left:* ${remainingStr}`,
        `┃ 📅 *Expires At:* ${expiryFormattedDate}`,
        ...(licenseStatus.code ? [`┃ 🏷️ *Last Key:* ${licenseStatus.code}`] : []),
        ...(licenseStatus.userEmail ? [`┃ 👤 *Account:* ${licenseStatus.userEmail}`] : []),
        "╰────────────────────────────",
      ].join("\n"));
    } else {
      // Expired license
      const agoStr = formatDuration(Math.abs(diffMs));
      return reply([
        "🔑 *SOLVATECH BOT LICENSE STATUS*",
        "────────────────────────────",
        "┃ 🔴 *Status:* EXPIRED",
        `┃ ⚠️ *Expired:* ${agoStr} ago`,
        `┃ 📅 *Expired On:* ${expiryFormattedDate}`,
        "┃ 💡 *Renew:* Redeem a new license key on the web dashboard to restore unlimited bot commands.",
        "╰────────────────────────────",
      ].join("\n"));
    }
  } catch (error) {
    return reply(`❌ Could not check license expiry: ${error.message || "Unknown error"}`);
  }
}

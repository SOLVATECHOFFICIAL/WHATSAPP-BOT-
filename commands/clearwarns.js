import { clearWarning } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";
import { targetFromMessage } from "../lib/permissions.js";

export default async function clearwarns({
  sock,
  chatId,
  sender,
  senderJids,
  senderIsLinkedAccount,
  args = [],
  message,
  reply,
  userId = "default",
}) {
  await requireAdmin(sock, chatId, sender, false, senderJids, senderIsLinkedAccount);

  let target = targetFromMessage(message);
  if (!target && args[0]) {
    const rawDigits = String(args[0]).replace(/\D/g, "");
    if (rawDigits.length >= 7) {
      target = `${rawDigits}@s.whatsapp.net`;
    }
  }

  if (!target) {
    return reply("❌ Please tag or reply to the user whose warnings you want to clear.\nExample: *.clearwarns @user*");
  }

  await clearWarning(chatId, target, userId);
  const num = target.split("@")[0].split(":")[0];
  await reply(`✅ Cleared all warnings for @${num}.`, { mentions: [target] });
}

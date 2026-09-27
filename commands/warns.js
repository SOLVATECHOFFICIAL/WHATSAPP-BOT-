import { getGroupSettings, setWarningLimit } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";
import { targetFromMessage } from "../lib/permissions.js";

export default async function warns({
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

  const sub = String(args[0] || "").toLowerCase();
  const val = String(args[1] || "").toLowerCase();

  // 1. Setting warning limit: .warns limit <N>
  if (sub === "limit" || sub === "setlimit") {
    const limitNum = parseInt(val, 10);
    if (!limitNum || isNaN(limitNum) || limitNum < 1 || limitNum > 20) {
      return reply("❌ Please specify a valid warning limit between 1 and 20. Example: *.warns limit 3*");
    }
    const newLimit = await setWarningLimit(chatId, limitNum, userId);
    return reply(`✅ Group warning limit set to *${newLimit}*. Members exceeding this will be removed.`);
  }

  const settings = await getGroupSettings(chatId, userId);
  const target = targetFromMessage(message);

  // 2. Check specific user's warnings if mentioned or replied
  if (target) {
    const targetClean = target.split("@")[0].split(":")[0];
    const count = settings.warnings?.[target] || settings.warnings?.[`${targetClean}@s.whatsapp.net`] || 0;
    const last = settings.lastViolations?.[target] || settings.lastViolations?.[`${targetClean}@s.whatsapp.net`];

    return reply([
      "⚠️ *SOLVATECH MEMBER WARNING STATUS*",
      "────────────────────────────",
      `┃ 👤 *Member:* @${targetClean}`,
      `┃ 🔢 *Active Warnings:* ${count} / ${settings.warningLimit || 3}`,
      ...(last ? [`┃ 🚫 *Last Violation:* ${last.reason || "Rule breach"}`] : []),
      "╰────────────────────────────",
    ].join("\n"), { mentions: [target] });
  }

  // 3. List all active warnings in group
  const activeEntries = Object.entries(settings.warnings || {}).filter(([, count]) => count > 0);

  if (activeEntries.length === 0) {
    return reply([
      "⚠️ *SOLVATECH GROUP WARNING STATUS*",
      "────────────────────────────",
      `┃ 🛡️ *Configured Limit:* ${settings.warningLimit || 3} violations`,
      "┃ 🟢 *Active Violations:* None (0 members warned)",
      "╰────────────────────────────",
      "",
      "_Tip: Use .warns limit <N> to change the maximum threshold._",
    ].join("\n"));
  }

  const lines = activeEntries.map(([jid, count]) => {
    const num = jid.split("@")[0].split(":")[0];
    return `• @${num} — *${count} / ${settings.warningLimit || 3}* warnings`;
  });

  const mentions = activeEntries.map(([jid]) => jid);

  return reply([
    "⚠️ *ACTIVE GROUP WARNINGS*",
    "────────────────────────────",
    `┃ 🛡️ *Max Limit:* ${settings.warningLimit || 3} violations before removal`,
    `┃ 👥 *Warned Members:* ${activeEntries.length}`,
    "────────────────────────────",
    "",
    ...lines,
    "",
    "_Commands: .clearwarns @user | .resetwarns | .warns limit <N>_",
  ].join("\n"), { mentions });
}

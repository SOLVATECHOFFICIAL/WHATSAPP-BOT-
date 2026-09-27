import { getGroupSettings, setGroupSetting } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";

export default async function goodbye({
  sock,
  chatId,
  sender,
  senderJids,
  senderIsLinkedAccount,
  args = [],
  reply,
  userId = "default",
}) {
  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);

  const value = String(args[0] || "").toLowerCase();
  if (!["on", "off"].includes(value)) {
    const current = await getGroupSettings(chatId, userId);
    return reply([
      "╔════ *SOLVATECH AUTO GOODBYE* ════╗",
      "",
      `┃ 👋 *Status:* ${current.goodbye ? "🟢 ENABLED (ON)" : "🔴 DISABLED (OFF)"}`,
      "",
      "╚══════════════════════════════════╝",
      "",
      "*USAGE:*",
      "• *.autogoodbye on* — Enable auto goodbye for this group",
      "• *.autogoodbye off* — Disable auto goodbye for this group",
    ].join("\n"));
  }

  const enabled = value === "on";
  await setGroupSetting(chatId, "goodbye", enabled, userId);
  await reply(`✅ Auto Goodbye has been turned ${enabled ? "ON" : "OFF"} for this group.`);
}

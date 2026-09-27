import { getGroupSettings, setGroupSetting } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";

export default async function welcome({
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
      "╔════ *SOLVATECH AUTO WELCOME* ════╗",
      "",
      `┃ 🎈 *Status:* ${current.welcome ? "🟢 ENABLED (ON)" : "🔴 DISABLED (OFF)"}`,
      "",
      "╚══════════════════════════════════╝",
      "",
      "*USAGE:*",
      "• *.autowelcome on* — Enable auto welcome for this group",
      "• *.autowelcome off* — Disable auto welcome for this group",
    ].join("\n"));
  }

  const enabled = value === "on";
  await setGroupSetting(chatId, "welcome", enabled, userId);
  await reply(`✅ Auto Welcome has been turned ${enabled ? "ON" : "OFF"} for this group.`);
}

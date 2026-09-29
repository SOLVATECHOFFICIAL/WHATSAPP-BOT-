import { getGroupSettings, setGroupSetting, setWarningLimit } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";

const settingByCommand = {
  antilink: "antiLink",
  antibot: "antiBot",
  antistatus: "antiStatusMention",
  antistatusmention: "antiStatusMention",
};

const settingByName = {
  link: "antiLink",
  antilink: "antiLink",
  bot: "antiBot",
  antibot: "antiBot",
  status: "antiStatusMention",
  antistatus: "antiStatusMention",
  statusmention: "antiStatusMention",
  antistatusmention: "antiStatusMention",
};

export default async function anti({
  sock,
  chatId,
  sender,
  senderJids,
  senderIsLinkedAccount,
  args = [],
  command = "anti",
  reply,
  userId = "default",
}) {
  await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);

  const commandSetting = settingByCommand[command.toLowerCase()];
  const first = String(args[0] || "").toLowerCase();
  const second = String(args[1] || "").toLowerCase();

  // Handle warning limit setting (e.g. .anti limit 5 or .anti setlimit 5)
  if (first === "limit" || first === "setlimit" || first === "warninglimit") {
    const limitNum = parseInt(second, 10);
    if (!limitNum || isNaN(limitNum) || limitNum < 1 || limitNum > 20) {
      return reply("❌ Please specify a valid warning limit between 1 and 20. Example: *.anti limit 3*");
    }
    const newLimit = await setWarningLimit(chatId, limitNum, userId);
    return reply(`✅ Group warning limit set to *${newLimit}* violations before removal.`);
  }

  const setting = commandSetting || settingByName[first];
  const value = commandSetting ? first : settingByName[first] ? second : first;

  if (!setting || !["on", "off"].includes(value)) {
    const current = await getGroupSettings(chatId, userId);
    return reply([
      "╭━━〔 🛡️ *SOLVATECH ANTI PROTECTIONS* 〕━━╮",
      "",
      `┃ 🔗 *Anti-Link:* ${current.antiLink ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}`,
      `┃ 🤖 *Anti-Bot:* ${current.antiBot ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}`,
      `┃ 📢 *Anti-Status-Mention:* ${current.antiStatusMention ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}`,
      `┃ ⚠️ *Shared Warning Limit:* *${current.warningLimit || 3}* _violations_`,
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "╭──〔 💡 *USAGE & CONTROLS* 〕──╮",
      "│",
      "│ • *.antilink on/off* — _Auto-delete external group links & warn_",
      "│ • *.antibot on/off* — _Auto-remove unauthorized bot accounts_",
      "│ • *.antistatus on/off* — _Auto-remove status group mentions & warn_",
      "│ • *.anti limit <N>* — _Set max warning limit (e.g. *.anti limit 3*)_",
      "│",
      "╰───────────────────────────────",
    ].join("\n"));
  }

  const enabled = value === "on";
  await setGroupSetting(chatId, setting, enabled, userId);

  let displayName = "Anti-Link";
  if (setting === "antiBot") displayName = "Anti-Bot";
  if (setting === "antiStatusMention") displayName = "Anti-Status-Mention";

  await reply(`✅ *${displayName} Protection:* ${enabled ? "🟢 *ENABLED (ON)*" : "🔴 *DISABLED (OFF)*"}\n_Settings saved and synced to Firebase._`);
}
import { getGroupSettings, toggleGroupSetting } from "../lib/command-tools.js";
import { requireAdmin } from "../lib/command-tools.js";

const settingByCommand = {
  antilink: "antiLink",
  antibot: "antiBot",
};

const settingByName = {
  link: "antiLink",
  antilink: "antiLink",
  bot: "antiBot",
  antibot: "antiBot",
};

const labels = {
  antiLink: "Anti-link",
  antiBot: "Anti-bot",
};

export default async function anti({ sock, chatId, sender, senderJids, args, command, reply }) {
  await requireAdmin(sock, chatId, sender, true, senderJids);
  const commandSetting = settingByCommand[command];
  const first = String(args[0] || "").toLowerCase();
  const second = String(args[1] || "").toLowerCase();
  const setting = commandSetting || settingByName[first] || "antiLink";
  const value = commandSetting ? first : settingByName[first] ? second : first;

  if (!["on", "off"].includes(value)) {
    const current = await getGroupSettings(chatId);
    const lines = Object.entries(labels).map(([key, label]) => (
      `*${label}:* ${current[key] ? "✅ ON" : "❌ OFF"}`
    ));
    return reply([
      "*🛡️ ANTI PROTECTION STATUS*",
      "",
      ...lines,
      "",
       "_Use .antilink or .antibot on/off._",
    ].join("\n"));
  }

  await toggleGroupSetting(chatId, setting, value === "on");
  await reply(`✅ *${labels[setting]} protection turned ${value.toUpperCase()}.*`);
}
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

export default async function anti({ sock, chatId, sender, senderJids, args, command, reply, userId = "default" }) {
  await requireAdmin(sock, chatId, sender, true, senderJids);
  const commandSetting = settingByCommand[command];
  const first = String(args[0] || "").toLowerCase();
  const second = String(args[1] || "").toLowerCase();
  const setting = commandSetting || settingByName[first] || "antiLink";
  const value = commandSetting ? first : settingByName[first] ? second : first;

  if (!["on", "off"].includes(value)) {
    const current = await getGroupSettings(chatId, userId);
    return reply([
      "Anti Protection",
      "",
      `Antilink: ${current.antiLink ? "ON" : "OFF"}`,
      `Antibot: ${current.antiBot ? "ON" : "OFF"}`,
    ].join("\n"));
  }

  const enabled = value === "on";
  await toggleGroupSetting(chatId, setting, enabled, userId);
  const name = setting === "antiBot" ? "Antibot" : "Antilink";
  await reply(`✅ ${name}: ${enabled ? "ON" : "OFF"}`);
}
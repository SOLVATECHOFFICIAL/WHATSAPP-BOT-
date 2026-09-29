import { stopSpamTask } from "../lib/spam-manager.js";
import meta from "./meta.js";

export default async function stop(ctx) {
  const { senderIsLinkedAccount, chatId, reply, args = [], text = "", userId = "default" } = ctx;
  if (!senderIsLinkedAccount) {
    // Strictly controller-only: completely ignore anyone else
    return;
  }

  if (args[0] && /^(?:meta|ai|metaai)$/i.test(args[0])) {
    return meta({ ...ctx, text: `stop ${text || "meta"}` });
  }

  const stopped = stopSpamTask(userId, chatId);
  if (stopped) {
    await reply([
      "╭━━〔 🛑 *BROADCAST STOPPED* 〕━━╮",
      "",
      "┃ 🛑 *Status:* _Repeated operation terminated immediately._",
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n"));
  } else {
    await reply("ℹ️ *Notice:* _No active repeated broadcast operation is currently running in this chat._");
  }
}

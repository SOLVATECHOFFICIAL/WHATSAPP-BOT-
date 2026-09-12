import { stopSpamTask } from "../lib/spam-manager.js";

export default async function stop({ senderIsLinkedAccount, chatId, reply, userId = "default" }) {
  if (!senderIsLinkedAccount) {
    return reply("❌ *Controller-Only Command:* Only the linked SOLVATECH account owner can use this command.");
  }

  const stopped = stopSpamTask(userId, chatId);
  if (stopped) {
    await reply("🛑 *Active repeated operation stopped immediately.*");
  } else {
    await reply("ℹ️ No active repeated operation is running in this chat.");
  }
}

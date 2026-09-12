import { isTaskCancelled, startSpamTask, stopSpamTask } from "../lib/spam-manager.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function spam({ sock, chatId, senderIsLinkedAccount, text, reply, userId = "default" }) {
  if (!senderIsLinkedAccount) {
    // Strictly controller-only: completely ignore anyone else
    return;
  }

  const messageText = String(text || "").trim();
  if (!messageText) {
    return reply("❌ Please specify a message to send. Usage: *.spam <message>*");
  }

  // Cancel any prior active task for this chat and start new one
  const task = startSpamTask(userId, chatId);
  await reply("🚀 *Repeated message operation started.* (Use *.stop* to cancel).");

  // Run repeated operation asynchronously with platform-safe rate limit
  (async () => {
    while (!isTaskCancelled(task)) {
      await sleep(1500); // 1.5s safe platform interval
      if (isTaskCancelled(task)) break;

      try {
        await sock.sendMessage(chatId, { text: messageText });
      } catch {
        break;
      }
    }
    stopSpamTask(userId, chatId);
  })();
}

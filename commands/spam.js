import { isTaskCancelled, startSpamTask, stopSpamTask } from "../lib/spam-manager.js";

const MAX_COUNT = 500;
const INTERVAL_MS = 500; // 2 messages per second (500ms interval)

async function interruptibleSleep(ms, task) {
  const step = 100;
  let elapsed = 0;
  while (elapsed < ms && !isTaskCancelled(task)) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}

export default async function spam({ sock, chatId, senderIsLinkedAccount, text, reply, userId = "default" }) {
  if (!senderIsLinkedAccount) {
    // Strictly controller-only: completely ignore unauthorized users
    return;
  }

  const messageText = String(text || "").trim();
  if (!messageText) {
    return reply([
      "╭━━〔 ❌ *BROADCAST USAGE* 〕━━╮",
      "",
      "┃ 💡 *Command:* `*.spam <message>*`",
      "┃ 📝 *Example:* `*.spam Important notice*`",
      "┃ 🛑 *Cancel:* _Use *.stop* anytime to terminate_",
      "",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n"));
  }

  // Cancel any prior active task for this chat/account and start fresh task
  const task = startSpamTask(userId, chatId);

  await reply([
    "╭━━〔 🚀 *BROADCAST INITIATED* 〕━━╮",
    "",
    "┃ 📢 *State:* _Repeating message sequentially..._",
    "┃ 🛑 *Control:* _Type *.stop* anytime to terminate immediately._",
    "",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
  ].join("\n"));

  // Run repeated operation asynchronously with sequential rate-limiting
  (async () => {
    let sentCount = 0;
    try {
      while (!isTaskCancelled(task) && sentCount < MAX_COUNT) {
        // Send message sequentially
        await sock.sendMessage(chatId, { text: messageText });
        sentCount++;

        // Stop if max count reached or cancelled
        if (sentCount >= MAX_COUNT || isTaskCancelled(task)) {
          break;
        }

        // Wait rate interval (500ms), checking cancellation in real-time
        await interruptibleSleep(INTERVAL_MS, task);
      }
    } catch {
      // Socket error or disconnect handling
    } finally {
      const wasCancelled = isTaskCancelled(task);
      stopSpamTask(userId, chatId);

      if (wasCancelled) {
        await reply(`🛑 *Broadcast Terminated:* Delivered *${sentCount}* message${sentCount === 1 ? "" : "s"}.`).catch(() => {});
      } else if (sentCount >= MAX_COUNT) {
        await reply(`✅ *Broadcast Completed:* Delivered *${sentCount}* messages.`).catch(() => {});
      }
    }
  })();
}


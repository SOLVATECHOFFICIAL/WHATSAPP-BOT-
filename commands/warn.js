import { executeManualWarn } from "../lib/whatsapp.js";

export default async function warn({
  sock,
  chatId,
  sender,
  senderJids = [],
  args = [],
  message,
  reply,
  userId = "default",
  botNumber = "",
}) {
  return executeManualWarn({
    sock,
    chatId,
    sender,
    senderJids,
    args,
    message,
    reply,
    userId,
    botNumber,
  });
}

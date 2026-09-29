import { getMessageText, getQuotedMessage } from "../lib/helpers.js";
import { handleSmartAddRequest } from "./meta.js";

export default async function add({
  sock,
  message,
  chatId,
  sender,
  senderJids = [],
  args = [],
  text = "",
  reply,
  userId = "default",
  botNumber = "",
}) {
  const rawPrompt = String(text || args.join(" ") || "").trim();
  const quotedMsg = getQuotedMessage(message);
  const quotedText = quotedMsg ? getMessageText({ message: quotedMsg }) : "";

  return handleSmartAddRequest({
    sock,
    chatId,
    sender,
    senderJids,
    userId,
    botNumber,
    rawPrompt,
    quotedText,
    reply,
  });
}
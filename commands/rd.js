import { getDeletedMessageForRestore, sendDeletedRecordToPersonalDm } from "../lib/deleted-messages.js";
import { getAllContextInfos, getControllerSelfJid } from "../lib/helpers.js";
import { getUserPreferences } from "../lib/database.js";

export default async function rd({ sock, message, chatId, reply, userId = "default", verifiedUid = "", botNumber = "" }) {
  const selfJid = getControllerSelfJid(sock, botNumber) || chatId;

  const prefs = await getUserPreferences(userId, verifiedUid || userId);
  if (!prefs.deletedMessageRecovery) {
    return sock.sendMessage(selfJid, {
      text: "ℹ️ *Deleted Message Recovery is currently OFF* in your Dashboard settings. Turn it ON in your Dashboard if you want deleted messages recovered to your personal DM.",
    });
  }

  const contexts = getAllContextInfos(message);
  const quotedStanzaId = contexts.find((c) => c?.stanzaId)?.stanzaId || null;

  const deletedRecord = getDeletedMessageForRestore(userId, chatId, quotedStanzaId);

  if (!deletedRecord) {
    return sock.sendMessage(selfJid, {
      text: "ℹ️ No deleted messages found in the 24-hour cache for this chat.",
    });
  }

  const sent = await sendDeletedRecordToPersonalDm(sock, deletedRecord, selfJid);
  if (sent) return sent;

  return sock.sendMessage(selfJid, {
    text: "ℹ️ The deleted message was detected, but no recoverable text or media payload could be extracted.",
  });
}


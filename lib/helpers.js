import { downloadContentFromMessage, getContentType, jidNormalizedUser } from "@whiskeysockets/baileys";
import { BOT_NAME, OWNER_NAME, PREFIX } from "./config.js";

export function getMessageText(message) {
  const content = getMessageContent(message);
  return String(
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

export function getMessageContent(message) {
  let content = message?.message || message || {};

  for (let depth = 0; depth < 6; depth += 1) {
    const nested =
      content.ephemeralMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message;

    if (!nested) break;
    content = nested;
  }

  return content;
}

export function getQuotedMessage(message) {
  const content = getMessageContent(message);
  const context = Object.values(content).find((value) => (
    value && typeof value === "object" && value.contextInfo
  ))?.contextInfo;
  if (!context?.quotedMessage) return null;

  return {
    key: {
      remoteJid: message.key.remoteJid,
      id: context.stanzaId,
      participant: context.participant,
      fromMe: false,
    },
    message: context.quotedMessage,
  };
}

export function unwrapMediaMessage(message) {
  return getMessageContent(message);
}

export function participantNumber(jid = "") {
  return jid.split("@")[0].split(":")[0];
}

export function mentionText(jid) {
  return `@${participantNumber(jid)}`;
}

export function normalizeNumber(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (digits.startsWith("00")) return digits.slice(2);
  if (/^0[789]\d{9}$/.test(digits)) return `234${digits.slice(1)}`;
  return digits;
}

export function isGroup(jid = "") {
  return jid.endsWith("@g.us");
}

export function isCommand(text) {
  return typeof text === "string" && text.trimStart().startsWith(PREFIX);
}

export function parseCommand(text) {
  const withoutPrefix = String(text || "").trim().slice(PREFIX.length).trim();
  const [command = "", ...args] = withoutPrefix.split(/\s+/);
  return { command: command.toLowerCase(), args, text: args.join(" ") };
}

export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function downloadMessageMedia(message, type) {
  const media = unwrapMediaMessage(message)?.[type];
  if (!media) throw new Error("No supported media was found.");
  return streamToBuffer(await downloadContentFromMessage(media, type.replace("Message", "").toLowerCase()));
}

export function groupMentions(participants, message) {
  const mentions = participants.map((item) => item.id);
  return { text: `${message ? `${message}\n\n` : ""}${participants.map((item) => mentionText(item.id)).join(" ")}`, mentions };
}

export function menuText() {
  return [
    `╭━━━〔 *${BOT_NAME}* 〕━━━╮`,
    `┃ _Owner: ${OWNER_NAME}_`,
    "┃ _Commands are locked to the linked account._",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    "*⚡ GENERAL*",
    `*${PREFIX}alive* — confirm the bot is online.`,
    `*${PREFIX}ping* — check the bot response speed.`,
    `*${PREFIX}menu* — show this command guide.`,
    "",
    "*👥 GROUP TOOLS*",
    `*${PREFIX}groupinfo* — show group name, owner, members, and admins.`,
    `*${PREFIX}tagadmin* — mention all admins in the current group.`,
    `*${PREFIX}tagall [message]* — mention every group member, optionally with a message.`,
    "",
    "*🛠️ GROUP ADMINISTRATION*",
    "_These commands require the linked account to also be a group admin._",
    `*${PREFIX}add <number>* — add a phone number to the group.`,
    `*${PREFIX}kick @user* — remove a mentioned non-admin member.`,
    `*${PREFIX}promote @user* — promote a mentioned member to admin.`,
    `*${PREFIX}demote @user* — remove admin rights from a member.`,
    `*${PREFIX}lock* / *${PREFIX}unlock* — control who can send messages.`,
    "",
      "*🛡️ ANTI PROTECTION*",
    "_Each protection deletes the trigger and removes the offending non-admin member._",
    `*${PREFIX}antilink on/off* — block WhatsApp invite links.`,
    `*${PREFIX}antibot on/off* — remove members whose message starts with .at.`,
      `*${PREFIX}anti <link|bot> on/off* — manage any protection.`,
    "",
    `*${PREFIX}sticker* — reply to an image or video to make a sticker.`,
    `*${PREFIX}vv* — reply to view-once media to recover it when available.`,
    "",
    "_Reply to source media or mention a user where a command says to._",
  ].join("\n");
}

export function mediaTypeFromMessage(message) {
  const type = getContentType(unwrapMediaMessage(message));
  if (type === "imageMessage") return "image";
  if (type === "videoMessage") return "video";
  if (type === "audioMessage") return "audio";
  if (type === "documentMessage") return "document";
  return null;
}

export function normalizedUser(jid) {
  return jidNormalizedUser(jid);
}

// Baileys can expose a participant as a phone JID, a LID, or a device JID
// depending on the message and the WhatsApp account. Keep all useful aliases
// so admin checks do not reject a real admin just because the two events use
// different JID forms.
export function jidAliases(jid) {
  if (!jid) return [];
  const value = String(jid);
  const aliases = new Set([value, normalizedUser(value)]);
  const [local, server = ""] = value.split("@");
  if (local) {
    aliases.add(`${local.split(":")[0]}@${server}`);
    aliases.add(local.split(":")[0]);
  }
  return [...aliases].filter(Boolean);
}

export function messageSenderJids(message, fallback = "") {
  const key = message?.key || {};
  return [
    key.participant,
    key.participantAlt,
    key.senderPn,
    message?.participant,
    message?.participantAlt,
    fallback,
  ].filter(Boolean);
}
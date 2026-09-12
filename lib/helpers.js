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
    "╔════ *SOLVATECH BOT COMMANDS* ════╗",
    "║  *Deleted-Message Engine: Instant DDD*",
    "║  *Restore Command: .rd (24-Hour Window)*",
    "║  *Protection: Owner Lockdown*",
    "╚════════════════════════════════╝",
    "",
    "*PUBLIC / CORE COMMANDS*",
    "• *.ping* — Instant latency and server status",
    "• *.menu* — Show available command list",
    "• *.link* — Retrieve group invite link",
    "• *.tagall* [msg] — Mention all group members",
    "• *.admin* / *.admins* — Mention all group admins",
    "• *.sticker* — Image to sticker / Video to animated sticker",
    "• *.antisticker* — Static sticker to picture / Animated sticker to video",
    "• *.read* — Extract verbatim text from image via OCR",
    "• *.open* — Reveal view-once photo, video, audio, or voice note",
    "• *.rd* — Reply to DDD within 24h to instantly restore deleted message/media",
    "",
    "*GROUP SECURITY & ADMIN*",
    "• *.pin* — Pin replied message in group",
    "• *.kick* @user — Remove participant from group",
    "• *.add* <phone> — Add member to group",
    "• *.promote* @user — Promote member to admin",
    "• *.demote* @user — Demote admin to member",
    "• *.lock* — Restrict group messages to admins only",
    "• *.unlock* — Allow all members to send messages",
    "• *.antilink on/off* — Instant kick for external links",
    "• *.antibot on/off* — Remove automated bot accounts",
    "• *.anti* — View current protection status",
    "",
    "*CONTROLLER-ONLY COMMANDS*",
    "• *.spam* <message> — Send a controlled repeated broadcast",
    "• *.stop* — Terminate an active spam operation",
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
import { downloadContentFromMessage, downloadMediaMessage, getContentType, jidNormalizedUser } from "@whiskeysockets/baileys";
import axios from "axios";
import { BOT_NAME, OWNER_NAME, PREFIX } from "./config.js";

export function getMessageText(message) {
  const content = getMessageContent(message);
  return String(
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    content?.statusQuotedMessage?.text ||
    content?.statusQuestionAnswerMessage?.text ||
    content?.buttonsResponseMessage?.selectedButtonId ||
    content?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content?.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

const MESSAGE_WRAPPER_KEYS = [
  "ephemeralMessage",
  "viewOnceMessageV2",
  "viewOnceMessage",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "futureProofMessage",
  "editedMessage",
  "associatedChildMessage",
  "deviceSentMessage",
  "groupMentionedMessage",
  "groupStatusMentionMessage",
  "statusMentionMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
];

export function getMessageContent(message) {
  let content = message?.message || message || {};

  for (let depth = 0; depth < 10; depth += 1) {
    if (!content || typeof content !== "object") break;
    let nested = null;
    for (const key of MESSAGE_WRAPPER_KEYS) {
      const wrapper = content[key];
      if (wrapper && typeof wrapper === "object") {
        if (wrapper.message && typeof wrapper.message === "object") {
          nested = wrapper.message;
          break;
        }
        if (wrapper.quotedStatus && typeof wrapper.quotedStatus === "object") {
          nested =
            wrapper.quotedStatus.message && typeof wrapper.quotedStatus.message === "object"
              ? wrapper.quotedStatus.message
              : wrapper.quotedStatus;
          break;
        }
      }
    }
    if (!nested) break;
    content = nested;
  }

  return content;
}

export function getQuotedMessage(message) {
  const content = getMessageContent(message);
  const context = Object.values(content || {}).find((value) => (
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
    id: context.stanzaId,
    stanzaId: context.stanzaId,
    participant: context.participant,
    message: context.quotedMessage,
  };
}

export function unwrapMediaMessage(message) {
  return getMessageContent(message);
}

/**
 * Recursively collects all contextInfo objects across nested message wrappers.
 * Deliberately does NOT traverse into normal `quotedMessage` so that a normal group
 * reply to an earlier message never inherits the quoted message's status metadata.
 */
export function getAllContextInfos(message) {
  const results = [];
  const visited = new Set();

  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 12 || visited.has(obj)) return;
    visited.add(obj);

    if (obj.contextInfo && typeof obj.contextInfo === "object") {
      results.push(obj.contextInfo);
    }

    for (const key of Object.keys(obj)) {
      if (key === "key" || key === "messageTimestamp" || key === "quotedMessage") continue;
      const val = obj[key];
      if (val && typeof val === "object") {
        walk(val, depth + 1);
      }
    }
  }

  walk(message?.message || message || {});
  if (message?.statusMentionMessageInfo?.quotedStatus) {
    walk(message.statusMentionMessageInfo.quotedStatus);
  }
  return results;
}

export function getContextInfo(message) {
  const all = getAllContextInfos(message);
  if (all.length > 0) return all[0];
  const content = getMessageContent(message);
  if (!content || typeof content !== "object") return null;
  for (const val of Object.values(content)) {
    if (val && typeof val === "object" && val.contextInfo) {
      return val.contextInfo;
    }
  }
  return content.contextInfo || message?.message?.extendedTextMessage?.contextInfo || null;
}

const STATUS_MENTION_WRAPPER_KEYS = new Set([
  "groupMentionedMessage",
  "groupStatusMentionMessage",
  "statusMentionMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
  "statusNotificationMessage",
  "statusQuotedMessage",
]);

function hasStatusAttributionGroupMention(ctx) {
  if (!ctx || typeof ctx !== "object") return false;
  if (ctx.isMentionedInStatus === true || ctx.isGroupStatus === true) return true;
  if (ctx.statusAttributionType === 1 || ctx.statusAttributionType === "RESHARED_FROM_MENTION") return true;
  if (Array.isArray(ctx.statusAttributions) && ctx.statusAttributions.length > 0) {
    for (const attr of ctx.statusAttributions) {
      if (!attr || typeof attr !== "object") continue;
      if (
        attr.type === 4 ||
        attr.type === "STATUS_MENTION" ||
        attr.type === 5 ||
        attr.type === "GROUP_STATUS" ||
        Boolean(attr.groupStatus) ||
        attr.statusReshare?.source === 2 ||
        attr.statusReshare?.source === "MENTION_RESHARE"
      ) {
        return true;
      }
    }
  }
  return false;
}

function checkObjectForStatusMention(obj, chatId, depth = 0, visited = new Set()) {
  if (!obj || typeof obj !== "object" || depth > 12 || visited.has(obj)) return false;
  visited.add(obj);

  const isGroupChat = Boolean(chatId && chatId.endsWith("@g.us"));

  if (obj.isMentionedInStatus === true && isGroupChat) return true;
  if (obj.isGroupStatus === true) return true;
  if (obj.statusMentionMessageInfo && typeof obj.statusMentionMessageInfo === "object") return true;

  for (const wrapperKey of STATUS_MENTION_WRAPPER_KEYS) {
    if (obj[wrapperKey] && typeof obj[wrapperKey] === "object") {
      return true;
    }
  }

  if (Array.isArray(obj.groupMentions) && obj.groupMentions.length > 0) return true;
  if (Array.isArray(obj.statusMentions) && obj.statusMentions.length > 0) {
    if (isGroupChat || obj.statusMentions.some((j) => typeof j === "string" && j.endsWith("@g.us"))) {
      return true;
    }
  }
  if (Array.isArray(obj.statusMentionSources) && obj.statusMentionSources.length > 0 && isGroupChat) {
    return true;
  }

  // ProtocolMessage.Type.STATUS_MENTION_MESSAGE = 25
  if (obj.protocolMessage && typeof obj.protocolMessage === "object") {
    const pType = obj.protocolMessage.type;
    if (pType === 25 || pType === "STATUS_MENTION_MESSAGE") {
      return true;
    }
  }

  if (obj.contextInfo && hasStatusAttributionGroupMention(obj.contextInfo)) {
    return true;
  }
  if (hasStatusAttributionGroupMention(obj) && isGroupChat) {
    return true;
  }

  for (const key of Object.keys(obj)) {
    if (key === "key" || key === "messageTimestamp" || key === "quotedMessage") continue;
    const val = obj[key];
    if (val && typeof val === "object") {
      if (checkObjectForStatusMention(val, chatId, depth + 1, visited)) return true;
    }
  }
  return false;
}

export function extractStatusMentionGroupJids(message, currentChatId = "") {
  if (!message) return [];
  const groups = new Set();
  const rawMsg = message.message || message || {};
  const isStatusBroadcast = message.key?.remoteJid === "status@broadcast";
  const isCurrentGroup = Boolean(currentChatId && currentChatId.endsWith("@g.us"));

  // 1. Check WebMessageInfo top-level statusMentions array
  if (Array.isArray(message.statusMentions)) {
    for (const sm of message.statusMentions) {
      const jid = typeof sm === "string" ? sm : (sm?.groupJid || sm?.jid || "");
      if (jid && jid.endsWith("@g.us")) {
        groups.add(jid);
      }
    }
  }

  // 2. Check all nested ContextInfo objects for groupMentions & parentGroupJid
  const allCtx = getAllContextInfos(message);
  for (const ctx of allCtx) {
    if (Array.isArray(ctx.groupMentions) && ctx.groupMentions.length > 0) {
      for (const gm of ctx.groupMentions) {
        const jid = typeof gm === "string" ? gm : (gm?.groupJid || gm?.jid || "");
        if (jid && jid.endsWith("@g.us")) {
          groups.add(jid);
        }
      }
    }
    if ((isStatusBroadcast || hasStatusAttributionGroupMention(ctx)) && typeof ctx.parentGroupJid === "string" && ctx.parentGroupJid.endsWith("@g.us")) {
      groups.add(ctx.parentGroupJid);
    }
    if (!isStatusBroadcast && hasStatusAttributionGroupMention(ctx) && isCurrentGroup) {
      groups.add(currentChatId);
    }
  }

  // 3. Check WAMessageStubType.STATUS_MENTION (210) or messageStubParameters
  const stub = message.messageStubType;
  const isStatusMentionStub = stub === 210 || stub === "STATUS_MENTION";
  if (isStatusMentionStub) {
    if (isCurrentGroup) groups.add(currentChatId);
    if (Array.isArray(message.messageStubParameters)) {
      for (const param of message.messageStubParameters) {
        if (typeof param === "string" && param.endsWith("@g.us")) {
          groups.add(param);
        }
      }
    }
  }

  // 4. In-group Status Mention notification (Path B: arrives directly in <group-id>@g.us)
  if (isCurrentGroup && !isStatusBroadcast) {
    if (
      isStatusMentionStub ||
      message.isMentionedInStatus === true ||
      Boolean(message.statusMentionMessageInfo) ||
      (Array.isArray(message.statusMentions) && message.statusMentions.length > 0) ||
      (Array.isArray(message.statusMentionSources) && message.statusMentionSources.length > 0) ||
      checkObjectForStatusMention(rawMsg, currentChatId)
    ) {
      groups.add(currentChatId);
    }
  }

  return Array.from(groups);
}

/**
 * Detects whether a WhatsApp message represents a WhatsApp Status Mention of the target group.
 * Handles both Path A (status@broadcast with group mention metadata) and Path B
 * (in-group notification in <group-id>@g.us: "[Member]'s status — @ This group was mentioned.").
 * Crucially returns FALSE for ordinary in-group messages (e.g. "Hello @Sharon" or "@John")
 * and FALSE for personal status updates that only mention an individual or a different group.
 */
export function isStatusMentionMessage(message, chatId = "") {
  if (!message) return false;
  const effectiveChatId = chatId || message.key?.remoteJid || "";
  const isGroupChat = Boolean(effectiveChatId && effectiveChatId.endsWith("@g.us"));
  const isStatusBroadcast = message.key?.remoteJid === "status@broadcast";

  // 1. Check WAMessageStubType.STATUS_MENTION (210)
  if (message.messageStubType === 210 || message.messageStubType === "STATUS_MENTION") {
    return true;
  }

  // 2. Check extracted group JIDs
  const groups = extractStatusMentionGroupJids(message, effectiveChatId);
  if (isStatusBroadcast) {
    if (!effectiveChatId || effectiveChatId === "status@broadcast") {
      return groups.length > 0;
    }
    const cleanTarget = effectiveChatId.split("@")[0];
    return groups.some((g) => g === effectiveChatId || g.includes(cleanTarget));
  }

  if (groups.length > 0) {
    if (!effectiveChatId) return true;
    const cleanTarget = effectiveChatId.split("@")[0];
    if (groups.some((g) => g === effectiveChatId || g.includes(cleanTarget))) return true;
  }

  // 3. Check text signature for in-group status mention notification (e.g. "Sharon's status - This group was mentioned")
  if (isGroupChat) {
    const text = getMessageText(message).toLowerCase();
    if (text) {
      if (text.includes("this group was mentioned")) return true;
      const hasStatus = text.includes("status");
      const hasGroupMentioned =
        text.includes("group was mentioned") ||
        text.includes("group mentioned") ||
        text.includes("mentioned this group");
      if (hasStatus && hasGroupMentioned) {
        return true;
      }
    }
  }

  // 4. Recursive inspection for status mention wrappers/fields
  const rawMsg = message.message || message || {};
  if (
    (isGroupChat && message.isMentionedInStatus === true) ||
    Boolean(message.statusMentionMessageInfo) ||
    (isGroupChat && Array.isArray(message.statusMentions) && message.statusMentions.length > 0) ||
    (isGroupChat && Array.isArray(message.statusMentionSources) && message.statusMentionSources.length > 0) ||
    checkObjectForStatusMention(rawMsg, effectiveChatId)
  ) {
    // If this is status@broadcast without any group JID, do not trigger on individual status mentions
    if (effectiveChatId === "status@broadcast") {
      return groups.length > 0;
    }
    return true;
  }

  return false;
}

/**
 * Extracts all candidate sender/participant JIDs for the member who created the Status
 * in a Status Mention event (across WebMessageInfo, protocolMessage, statusNotificationMessage,
 * statusQuotedMessage, contextInfo, statusAttributions, and messageStubParameters).
 */
export function extractStatusMentionSenders(message) {
  if (!message) return [];
  const candidates = [];
  const addCandidate = (val) => {
    if (!val || typeof val !== "string") return;
    const trimmed = val.trim();
    if (!trimmed || trimmed === "status@broadcast" || trimmed.endsWith("@g.us") || trimmed.endsWith("@broadcast")) {
      return;
    }
    candidates.push(trimmed);
  };

  const key = message.key || {};
  addCandidate(key.participant);
  addCandidate(key.participantAlt);
  addCandidate(key.senderPn);
  addCandidate(message.participant);
  addCandidate(message.participantAlt);

  if (Array.isArray(message.statusMentionSources)) {
    for (const src of message.statusMentionSources) addCandidate(src);
  }
  if (message.statusMentionMessageInfo?.quotedStatus) {
    const qs = message.statusMentionMessageInfo.quotedStatus;
    addCandidate(qs.key?.participant);
    addCandidate(qs.key?.participantAlt);
    addCandidate(qs.participant);
  }

  const visited = new Set();
  function walkSenders(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 12 || visited.has(obj)) return;
    visited.add(obj);

    addCandidate(obj.protocolMessage?.key?.participant);
    addCandidate(obj.protocolMessage?.invokerJid);
    addCandidate(obj.statusNotificationMessage?.originalMessageKey?.participant);
    addCandidate(obj.statusNotificationMessage?.responseMessageKey?.participant);
    addCandidate(obj.statusQuotedMessage?.originalStatusId?.participant);
    if (obj.quotedStatus && typeof obj.quotedStatus === "object") {
      addCandidate(obj.quotedStatus.key?.participant);
      addCandidate(obj.quotedStatus.key?.participantAlt);
      addCandidate(obj.quotedStatus.participant);
    }

    for (const k of Object.keys(obj)) {
      if (k === "key" || k === "messageTimestamp" || k === "quotedMessage") continue;
      const val = obj[k];
      if (val && typeof val === "object") {
        walkSenders(val, depth + 1);
      }
    }
  }
  walkSenders(message.message || message || {});

  for (const ctx of getAllContextInfos(message)) {
    addCandidate(ctx.participant);
    if (Array.isArray(ctx.statusAttributions)) {
      for (const attr of ctx.statusAttributions) {
        addCandidate(attr?.groupStatus?.authorJid);
      }
    }
  }

  if (Array.isArray(message.messageStubParameters)) {
    for (const param of message.messageStubParameters) {
      if (typeof param === "string") {
        if (param.includes("@s.whatsapp.net") || param.includes("@lid")) {
          addCandidate(param);
        } else if (param.startsWith("{") && param.endsWith("}")) {
          try {
            const parsed = JSON.parse(param);
            addCandidate(parsed.phoneNumber || parsed.id || parsed.jid || parsed.lid);
          } catch {}
        }
      }
    }
  }

  return [...new Set(candidates)];
}

/**
 * Extracts a canonical status message ID if the group status mention notification
 * references an underlying status message key (for cross-path deduplication).
 */
export function extractStatusMentionCanonicalId(message) {
  if (!message) return "";
  let foundId = message.targetMessageId?.id || message.statusMentionMessageInfo?.quotedStatus?.key?.id || "";

  const visited = new Set();
  function walkIds(obj, depth = 0) {
    if (foundId || !obj || typeof obj !== "object" || depth > 12 || visited.has(obj)) return;
    visited.add(obj);

    const candidate =
      obj.protocolMessage?.key?.id ||
      obj.statusNotificationMessage?.originalMessageKey?.id ||
      obj.statusQuotedMessage?.originalStatusId?.id ||
      obj.quotedStatus?.key?.id ||
      "";
    if (candidate && typeof candidate === "string" && candidate.trim()) {
      foundId = candidate.trim();
      return;
    }

    for (const k of Object.keys(obj)) {
      if (k === "key" || k === "messageTimestamp" || k === "quotedMessage") continue;
      const val = obj[k];
      if (val && typeof val === "object") {
        walkIds(val, depth + 1);
        if (foundId) return;
      }
    }
  }
  if (!foundId) {
    walkIds(message.message || message || {});
  }

  return String(foundId || message.key?.id || "").trim();
}

/**
 * Produces a structured diagnostic summary of a message's status/group-mention metadata
 * for live runtime inspection.
 */
export function inspectStatusMentionStructure(message, targetGroupJid = "") {
  const rawMsg = message?.message || {};
  const unwrapped = getMessageContent(message) || {};
  const ctx = getContextInfo(message);
  return {
    remoteJid: message?.key?.remoteJid || "",
    participant: message?.key?.participant || message?.participant || "",
    participantAlt: message?.key?.participantAlt || "",
    messageId: message?.key?.id || "",
    canonicalStatusId: extractStatusMentionCanonicalId(message),
    messageStubType: message?.messageStubType ?? null,
    topLevelMessageKeys: rawMsg && typeof rawMsg === "object" ? Object.keys(rawMsg) : [],
    unwrappedMessageKeys: unwrapped && typeof unwrapped === "object" ? Object.keys(unwrapped) : [],
    protocolMessageType: unwrapped?.protocolMessage?.type ?? rawMsg?.protocolMessage?.type ?? null,
    hasGroupMentionedMessage: Boolean(rawMsg?.groupMentionedMessage || unwrapped?.groupMentionedMessage),
    hasGroupStatusMentionMessage: Boolean(rawMsg?.groupStatusMentionMessage || unwrapped?.groupStatusMentionMessage),
    hasStatusMentionMessage: Boolean(rawMsg?.statusMentionMessage || unwrapped?.statusMentionMessage),
    hasGroupStatusMessage: Boolean(rawMsg?.groupStatusMessage || rawMsg?.groupStatusMessageV2),
    isMentionedInStatus: Boolean(message?.isMentionedInStatus || ctx?.isMentionedInStatus),
    statusMentions: message?.statusMentions || [],
    statusMentionSources: message?.statusMentionSources || [],
    hasStatusMentionMessageInfo: Boolean(message?.statusMentionMessageInfo),
    groupMentions: ctx?.groupMentions || [],
    statusAttributionType: ctx?.statusAttributionType ?? null,
    statusAttributions: ctx?.statusAttributions || [],
    extractedSenders: extractStatusMentionSenders(message),
    extractedTargetGroups: extractStatusMentionGroupJids(message, targetGroupJid),
    targetGroupJid,
  };
}

export function extractParticipantNumber(p) {
  if (!p) return "";
  if (typeof p === "object") {
    const raw = p.phoneNumber || p.id || p.jid || p.pn || p.user || p.participant || "";
    return extractParticipantNumber(raw);
  }
  let str = String(p).trim();
  if (str.startsWith("{") && str.endsWith("}")) {
    try {
      const parsed = JSON.parse(str);
      return extractParticipantNumber(parsed);
    } catch {}
  }
  const [userPart] = str.split("@");
  const digits = userPart.split(":")[0].replace(/\D/g, "");
  return digits;
}

export function extractParticipantJid(p) {
  const num = extractParticipantNumber(p);
  if (num) return `${num}@s.whatsapp.net`;
  if (typeof p === "string" && p.includes("@")) return p.split(":")[0];
  return "";
}

export function participantNumber(jid = "") {
  return extractParticipantNumber(jid);
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

const SUPPORTED_PREFIXES = [".", "!", "/", "#"];
const BARE_COMMAND_KEYWORDS = new Set(["menu", "help", "ping", "alive", "open", "vv"]);

export function isCommand(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (SUPPORTED_PREFIXES.some((p) => trimmed.startsWith(p))) return true;
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  return BARE_COMMAND_KEYWORDS.has(firstWord);
}

export function parseCommand(text) {
  const trimmed = String(text || "").trim();
  let withoutPrefix = trimmed;
  for (const p of SUPPORTED_PREFIXES) {
    if (withoutPrefix.startsWith(p)) {
      withoutPrefix = withoutPrefix.slice(p.length).trim();
      break;
    }
  }
  const [command = "", ...args] = withoutPrefix.split(/\s+/);
  return { command: command.toLowerCase(), args, text: args.join(" ") };
}

export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function downloadMessageMedia(message, type, sock = null) {
  // 1. Try Baileys downloadMediaMessage if message structure is passed
  if (message) {
    try {
      const targetMsg = message.message ? message : { message };
      const ctx = sock ? { logger: sock.logger, reuploadRequest: sock.updateMediaMessage ? sock.updateMediaMessage.bind(sock) : undefined } : undefined;
      const buf = await downloadMediaMessage(targetMsg, "buffer", {}, ctx);
      if (buf && buf.length > 0) {
        return buf;
      }
    } catch {
      // Continue to next fallback strategy
    }
  }

  // 2. Direct stream decryption via downloadContentFromMessage
  const content = unwrapMediaMessage(message);
  const normalizedKey = type.endsWith("Message") ? type : `${type}Message`;
  const plainKey = type.replace("Message", "");
  const media =
    content?.[normalizedKey] ||
    content?.[plainKey] ||
    content?.[type] ||
    content?.imageMessage ||
    content?.videoMessage ||
    content?.ptvMessage ||
    content?.stickerMessage ||
    content?.documentMessage;

  if (!media) throw new Error(`No supported media was found for type ${type}.`);
  const mediaStreamType = plainKey === "ptv" ? "video" : (plainKey === "sticker" ? "sticker" : (plainKey.toLowerCase() || "image"));
  try {
    return await streamToBuffer(await downloadContentFromMessage(media, mediaStreamType));
  } catch (streamErr) {
    // 3. If direct URL exists, download via HTTP
    if (media.url && typeof media.url === "string" && media.url.startsWith("http")) {
      const response = await axios.get(media.url, { responseType: "arraybuffer", timeout: 30000 });
      return Buffer.from(response.data);
    }
    throw streamErr;
  }
}

export function groupMentions(participants, message) {
  const mentions = participants.map((item) => item.id);
  return { text: `${message ? `${message}\n\n` : ""}${participants.map((item) => mentionText(item.id)).join(" ")}`, mentions };
}

export function menuText() {
  return [
    "╔════ *SOLVATECH BOT COMMANDS* ════╗",
    "║  *Deleted-Message Recovery: Dashboard ON/OFF (Personal DM)*",
    "║  *View-Once Recovery: Personal DM*",
    "║  *Protection: Owner Lockdown*",
    "╚════════════════════════════════╝",
    "",
    "*CORE UTILITY COMMANDS*",
    "• *.ping* — Instant latency and server status",
    "• *.uptime* — Show continuous bot uptime & server health",
    "• *.owner* — Official SOLVATECH BOT owner & developer contact",
    "• *.expire* — Check real-time active license expiry countdown",
    "• *.share* — Share SOLVATECH BOT information with friends/groups",
    "• *.menu* — Show full command menu",
    "• *.link* — Retrieve group invite link",
    "• *.groupinfo* — Complete group metadata, creator, and admin stats",
    "• *.profile* [@user] — View WhatsApp bio, role, and profile info",
    "",
    "*MEDIA & RECOVERY TOOLS*",
    "• *.sticker* — Image to sticker / Video to animated sticker",
    "• *.antisticker* — Static sticker to picture / Animated sticker to video",
    "• *.read* — Extract verbatim text from image via AI OCR",
    "• *.open / .vv* — Reveal view-once media privately to your personal DM",
    "• *.send* — Reply to any WhatsApp Status to send its media or text into current chat",
    "• *.rd* — Restore deleted message/media privately to your personal DM",
    "",
    "*GROUP SECURITY & ADMIN*",
    "• *.pin* — Pin replied message in group",
    "• *.tagall* [msg] — Mention all group members",
    "• *.admin* / *.admins* — Mention all group admins",
    "• *.kick* @user — Remove participant from group",
    "• *.add* <phone> — Add member to group",
    "• *.promote* @user — Promote member to admin",
    "• *.demote* @user — Demote admin to member",
    "• *.lock* — Restrict group messages to admins only",
    "• *.unlock* — Allow all members to send messages",
    "• *.antilink on/off* — Auto-remove external links with shared warnings",
    "• *.antibot on/off* — Auto-remove rogue automated bot accounts",
    "• *.antistatus on/off* — Auto-remove WhatsApp status group mentions",
    "• *.autowelcome on/off* — Auto welcome new group members",
    "• *.autogoodbye on/off* — Auto goodbye departing members",
    "• *.anti* — View full 3-anti protection status & warning limits",
    "• *.warns* — Inspect group member warnings and configure limit",
    "• *.clearwarns @user* — Clear warnings for a member",
    "• *.resetwarns* — Reset all group warnings",
    "",
    "*CONTROLLER-ONLY COMMANDS*",
    "• *.spam* <message> — Send a controlled repeated broadcast",
    "• *.stop* — Terminate an active spam operation",
  ].join("\n");
}

export function isViewOnceMessage(message) {
  const raw = message?.message || message;
  if (!raw || typeof raw !== "object") return false;

  function check(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 8) return false;
    if (
      obj.viewOnceMessage ||
      obj.viewOnceMessageV2 ||
      obj.viewOnceMessageV2Extension
    ) {
      return true;
    }
    if (
      obj.imageMessage?.viewOnce === true ||
      obj.videoMessage?.viewOnce === true ||
      obj.audioMessage?.viewOnce === true ||
      obj.ptvMessage?.viewOnce === true ||
      obj.documentMessage?.viewOnce === true
    ) {
      return true;
    }
    for (const wrapperKey of [
      "ephemeralMessage",
      "futureProofMessage",
      "deviceSentMessage",
      "documentWithCaptionMessage",
      "editedMessage",
      "associatedChildMessage",
    ]) {
      const w = obj[wrapperKey];
      if (w && typeof w === "object") {
        if (check(w.message || w, depth + 1)) return true;
      }
    }
    return false;
  }

  return check(raw, 0);
}

export function getControllerSelfJid(sock, fallbackBotNumber = "") {
  const cleanFallback = String(fallbackBotNumber || "").replace(/\D/g, "");
  const rawCandidates = [
    sock?.user?.phoneNumber,
    sock?.user?.id,
    cleanFallback ? `${cleanFallback}@s.whatsapp.net` : "",
    sock?.user?.lid,
  ].filter(Boolean);

  for (const candidate of rawCandidates) {
    const norm = normalizedUser(candidate);
    if (norm && norm.endsWith("@s.whatsapp.net")) {
      return norm;
    }
  }
  for (const candidate of rawCandidates) {
    const norm = normalizedUser(candidate);
    if (norm) return norm;
  }
  return "";
}

export function mediaTypeFromMessage(message) {
  const content = unwrapMediaMessage(message);
  if (content?.imageMessage) return "image";
  if (content?.videoMessage || content?.ptvMessage) return "video";
  if (content?.audioMessage) return "audio";
  if (content?.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    return "document";
  }
  if (content?.stickerMessage) return "sticker";
  const type = getContentType(content);
  if (type === "imageMessage") return "image";
  if (type === "videoMessage" || type === "ptvMessage") return "video";
  if (type === "audioMessage") return "audio";
  if (type === "documentMessage") return "document";
  return null;
}

export function normalizedUser(jid) {
  if (!jid) return "";
  const str = String(jid).trim();
  if (!str) return "";
  if (!str.includes("@")) {
    const digits = str.split(":")[0].replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : str;
  }
  return jidNormalizedUser(str) || str;
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
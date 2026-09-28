import {
  buildQuizQuestions,
  explainImageBuffer,
  extractTextFromImage,
  generateMetaConversationalReply,
  generateMetaImage,
  pickRiddles,
  pickScrambleWords,
  summarizeAvailableMessages,
  translateContent,
} from "../lib/ai-engine.js";
import {
  clearPendingClarification,
  disableAllMetaChats,
  evaluateGameAnswer,
  formatCurrentGamePrompt,
  formatGameScoreboard,
  getActiveGame,
  getChatHistory,
  getMetaChatMode,
  getOnlineParticipantsForChat,
  getPendingClarification,
  getRecentMessagesBySender,
  listActiveMetaChats,
  removeChatMessageById,
  setMetaChatMode,
  setPendingClarification,
  startGroupGame,
  stopGroupGame,
  updateMetaChatName,
} from "../lib/chat-memory.js";
import {
  downloadMessageMedia,
  extractParticipantNumber,
  getContextInfo,
  getMessageText,
  getQuotedMessage,
  isGroup,
  jidAliases,
  mediaTypeFromMessage,
  mentionText,
  normalizeNumber,
  normalizedUser,
  unwrapMediaMessage,
} from "../lib/helpers.js";
import { isAdmin, isOwner, participantJid, resolveManualWarnTarget } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import {
  doesSessionMatchParticipant,
  extractParticipantTargetDetails,
  findEligibleAdminSessionsForGroup,
  executeManualWarn,
  scheduleAutoDeleteNotice,
} from "../lib/whatsapp.js";

import alive from "./alive.js";
import ping from "./ping.js";
import uptime from "./uptime.js";
import owner from "./owner.js";
import menu from "./menu.js";
import groupinfo from "./groupinfo.js";
import profile from "./profile.js";
import expire from "./expire.js";
import promote from "./promote.js";
import demote from "./demote.js";
import tagall from "./tagall.js";
import admin from "./admin.js";
import lock from "./lock.js";
import unlock from "./unlock.js";
import anti from "./anti.js";
import sticker from "./sticker.js";
import antisticker from "./antisticker.js";
import read from "./read.js";
import open from "./open.js";
import rd from "./rd.js";
import pin from "./pin.js";
import link from "./link.js";
import send from "./send.js";
import share from "./share.js";
import warns from "./warns.js";
import clearwarns from "./clearwarns.js";
import resetwarns from "./resetwarns.js";
import welcome from "./welcome.js";
import goodbye from "./goodbye.js";

const COUNTRY_CODE_MAP = {
  nigeria: "234",
  naija: "234",
  ng: "234",
  ghana: "233",
  gh: "233",
  kenya: "254",
  ke: "254",
  "south africa": "27",
  sa: "27",
  uk: "44",
  "united kingdom": "44",
  england: "44",
  britain: "44",
  us: "1",
  usa: "1",
  america: "1",
  "united states": "1",
  canada: "1",
  india: "91",
  uae: "971",
  dubai: "971",
  cameroon: "237",
  benin: "229",
  togo: "228",
  uganda: "256",
  tanzania: "255",
  egypt: "20",
};

function resolveCountryDialCode(input = "") {
  const clean = String(input || "").toLowerCase().trim();
  if (!clean) return null;

  const plusMatch = clean.match(/(?:^|\s)\+?(\d{1,3})(?:\b|\s|$)/);
  if (plusMatch && ["1", "20", "27", "44", "91", "228", "229", "233", "234", "237", "254", "255", "256", "971"].includes(plusMatch[1])) {
    return plusMatch[1];
  }

  for (const [name, code] of Object.entries(COUNTRY_CODE_MAP)) {
    const regex = new RegExp(`\\b${name}\\b`, "i");
    if (regex.test(clean)) {
      return code;
    }
  }
  return null;
}

function normalizeNumberWithCountryCode(rawNum, countryCode = "") {
  const digits = String(rawNum || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) return digits.slice(2);

  if (countryCode) {
    const cc = String(countryCode).replace(/\D/g, "");
    if (digits.startsWith(cc) && digits.length >= cc.length + 7) {
      return digits;
    }
    if (digits.startsWith("0")) {
      return `${cc}${digits.slice(1)}`;
    }
    return `${cc}${digits}`;
  }

  return normalizeNumber(rawNum);
}

/**
 * Extracts quoted message deletion key if the user is replying to a message.
 */
function resolveQuotedDeleteKey(message, chatId) {
  const contextInfo = getContextInfo(message);
  if (!contextInfo || !contextInfo.stanzaId) return null;

  const quotedParticipant = contextInfo.participant || undefined;
  const isFromMe = !quotedParticipant;

  return {
    remoteJid: chatId,
    fromMe: isFromMe,
    id: contextInfo.stanzaId,
    ...(quotedParticipant ? { participant: quotedParticipant } : {}),
  };
}

/**
 * Detects country name and flag from an E.164 phone number.
 */
function detectCountryFromNumber(phoneNum = "") {
  const digits = String(phoneNum || "").replace(/\D/g, "");
  if (!digits) return "Unknown region";
  const prefixTable = [
    ["234", "Nigeria 🇳🇬"],
    ["233", "Ghana 🇬🇭"],
    ["254", "Kenya 🇰🇪"],
    ["27", "South Africa 🇿🇦"],
    ["237", "Cameroon 🇨🇲"],
    ["229", "Benin 🇧🇯"],
    ["228", "Togo 🇹🇬"],
    ["256", "Uganda 🇺🇬"],
    ["255", "Tanzania 🇹🇿"],
    ["20", "Egypt 🇪🇬"],
    ["44", "United Kingdom 🇬🇧"],
    ["1", "United States / Canada 🇺🇸"],
    ["91", "India 🇮🇳"],
    ["971", "United Arab Emirates 🇦🇪"],
    ["966", "Saudi Arabia 🇸🇦"],
    ["49", "Germany 🇩🇪"],
    ["33", "France 🇫🇷"],
    ["39", "Italy 🇮🇹"],
    ["34", "Spain 🇪🇸"],
    ["55", "Brazil 🇧🇷"],
    ["86", "China 🇨🇳"],
    ["81", "Japan 🇯🇵"],
    ["61", "Australia 🇦🇺"],
  ];
  for (const [code, label] of prefixTable) {
    if (digits.startsWith(code)) return `${label} (+${code})`;
  }
  return `International (+${digits.slice(0, 3)})`;
}

/**
 * Resolves a human-readable name for the current chat (Group Subject or DM Contact Name/Number).
 */
async function resolveFriendlyChatName(sock, chatId, message) {
  if (isGroup(chatId)) {
    try {
      const meta = await sock.groupMetadata(chatId);
      if (meta?.subject) return meta.subject;
    } catch {}
    return `Group (${chatId.split("@")[0]})`;
  }
  const num = extractParticipantNumber(chatId) || chatId.split("@")[0];
  const history = getChatHistory(chatId, { limit: 25 });
  const partnerMsg = [...history].reverse().find((m) => !m.fromMe && m.pushName);
  const pushName =
    partnerMsg?.pushName ||
    (!message?.key?.fromMe && message?.pushName ? String(message.pushName).trim() : "");
  return pushName ? `${pushName} (+${num})` : `+${num}`;
}

/**
 * Builds rich live context about the current chat, the person the user is chatting with (or replying to),
 * and recent messages in the conversation so Meta AI has real situational awareness.
 */
async function buildLiveChatContext(sock, chatId, message, botNumber = "") {
  const history = getChatHistory(chatId, {
    limit: 12,
    excludeCommands: true,
    excludeBotGenerated: true,
  });

  const contextInfo = getContextInfo(message);
  const quotedParticipantJid = contextInfo?.participant || "";

  if (!isGroup(chatId)) {
    const partnerNum = extractParticipantNumber(chatId) || chatId.split("@")[0];
    const country = detectCountryFromNumber(partnerNum);
    const partnerMsg = [...history].reverse().find((m) => !m.fromMe && m.pushName);
    const partnerName =
      partnerMsg?.pushName ||
      (!message?.key?.fromMe && message?.pushName ? String(message.pushName).trim() : "") ||
      "Contact";

    let bioStatus = "";
    try {
      if (typeof sock?.fetchStatus === "function") {
        const st = await Promise.race([
          sock.fetchStatus(chatId),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        const statusObj = Array.isArray(st) ? st[0] : st;
        if (statusObj?.status && typeof statusObj.status === "string") {
          bioStatus = statusObj.status.trim();
        } else if (statusObj?.status?.status && typeof statusObj.status.status === "string") {
          bioStatus = statusObj.status.status.trim();
        }
      }
    } catch {}

    const partnerMsgsCount = history.filter((m) => !m.fromMe).length;
    const recentLines = history.slice(-8).map((m) => {
      const who = m.fromMe ? "Owner (You)" : `${partnerName} (+${partnerNum})`;
      return `- ${who}: ${m.text || `[${m.mediaType || "media"}]`}`;
    });

    return {
      isGroupChat: false,
      targetName: partnerName,
      targetNumber: partnerNum,
      targetCountry: country,
      targetBio: bioStatus,
      targetRole: "Direct Chat Contact",
      partnerMsgsCount,
      recentMessages: recentLines,
      summaryText: [
        `Chat Type: Direct 1-on-1 WhatsApp Chat`,
        `Person you are chatting with: ${partnerName}`,
        `Phone Number: +${partnerNum}`,
        `Country / Region: ${country}`,
        ...(bioStatus ? [`WhatsApp Bio/About: "${bioStatus}"`] : []),
        `Messages from them in current session: ${partnerMsgsCount}`,
        ...(recentLines.length > 0
          ? [`Recent messages in this chat:\n${recentLines.join("\n")}`]
          : ["No prior messages recorded in this session yet."]),
      ].join("\n"),
    };
  }

  // Group chat context
  let groupSubject = "WhatsApp Group";
  let totalMembers = 0;
  let targetRole = "Group Member";
  let targetNum = quotedParticipantJid ? extractParticipantNumber(quotedParticipantJid) : "";
  let targetName = "";

  try {
    const meta = await sock.groupMetadata(chatId);
    groupSubject = meta?.subject || groupSubject;
    totalMembers = Array.isArray(meta?.participants) ? meta.participants.length : 0;

    if (quotedParticipantJid && Array.isArray(meta?.participants)) {
      const foundP = meta.participants.find((p) => {
        const pNum = extractParticipantNumber(p.phoneNumber || p.id);
        return p.id === quotedParticipantJid || (targetNum && pNum === targetNum);
      });
      if (foundP) {
        if (!targetNum) targetNum = extractParticipantNumber(foundP.phoneNumber || foundP.id);
        targetRole =
          foundP.admin === "superadmin"
            ? "Group Creator / Superadmin"
            : foundP.admin === "admin"
              ? "Group Admin"
              : "Group Member";
      }
    }
  } catch {}

  if (!targetNum) {
    const lastOther = [...history].reverse().find((m) => !m.fromMe && m.senderNumber);
    if (lastOther) {
      targetNum = lastOther.senderNumber;
      targetName = lastOther.pushName || "";
    }
  } else {
    const matchingMsg = [...history].reverse().find((m) => m.senderNumber === targetNum && m.pushName);
    if (matchingMsg) targetName = matchingMsg.pushName;
  }

  const targetCountry = targetNum ? detectCountryFromNumber(targetNum) : "Unknown";
  const recentLines = history.slice(-8).map((m) => {
    const who = m.fromMe ? "Owner (You)" : `${m.pushName || "Member"} (+${m.senderNumber || "user"})`;
    return `- ${who}: ${m.text || `[${m.mediaType || "media"}]`}`;
  });

  return {
    isGroupChat: true,
    groupSubject,
    totalMembers,
    targetName: targetName || (targetNum ? `+${targetNum}` : "Group Member"),
    targetNumber: targetNum,
    targetCountry,
    targetBio: "",
    targetRole,
    recentMessages: recentLines,
    summaryText: [
      `Chat Type: WhatsApp Group "${groupSubject}" (${totalMembers} members)`,
      ...(targetNum
        ? [
            `Referenced / Most Recent Person: ${targetName || "Member"} (+${targetNum})`,
            `Country / Region: ${targetCountry}`,
            `Role in Group: ${targetRole}`,
          ]
        : []),
      ...(recentLines.length > 0 ? [`Recent group messages:\n${recentLines.join("\n")}`] : []),
    ].join("\n"),
  };
}

/**
 * Finds an eligible connected group-admin bot session for group management actions,
 * and verifies that the requester is also a group admin.
 */
async function resolveAuthorizedGroupAdminSession({
  sock,
  chatId,
  sender,
  senderJids = [],
  userId = "default",
  botNumber = "",
}) {
  if (!isGroup(chatId)) {
    return { ok: false, error: "❌ This action can only be used inside a WhatsApp group." };
  }

  const currentSession = {
    userId,
    isConnected: () => Boolean(sock),
    getSocket: () => sock,
    getBotNumber: () => botNumber || sock?.user?.id?.split(":")[0]?.split("@")[0] || "",
  };

  let metadata = null;
  try {
    metadata = await sock.groupMetadata(chatId);
  } catch {
    return { ok: false, error: "❌ Could not retrieve group metadata." };
  }

  const callerCandidates = [
    sender,
    ...(Array.isArray(senderJids) ? senderJids : []),
    sock?.user?.id,
    sock?.user?.lid,
    sock?.user?.phoneNumber,
    botNumber ? `${botNumber}@s.whatsapp.net` : "",
  ].filter(Boolean);

  if (!isAdmin(metadata, callerCandidates)) {
    return { ok: false, error: "❌ Only a group admin is permitted to perform this group management action." };
  }

  const adminSessions = await findEligibleAdminSessionsForGroup(chatId, null, currentSession);
  if (adminSessions.length === 0) {
    const memberAddRestricted = metadata.memberAddMode === false || metadata.memberAddMode === "admin_add";
    return {
      ok: false,
      notBotAdmin: true,
      memberAddRestricted,
      metadata,
      error: "❌ I can't perform that action because this bot is not a group admin in this group.",
    };
  }

  return {
    ok: true,
    adminSession: adminSessions[0],
    allAdminSessions: adminSessions,
    metadata: adminSessions[0].metadata || metadata,
  };
}

/**
 * Executes group member addition for a list of raw phone numbers using the resolved country code,
 * verifying each number and reporting honest per-number results.
 */
async function executeGroupAddNumbers({
  adminSession,
  chatId,
  rawNumbers,
  countryCode,
  reply,
}) {
  const added = [];
  const failed = [];
  const seen = new Set();

  for (const raw of rawNumbers) {
    const rawClean = String(raw || "").trim();
    const digitsOnly = rawClean.replace(/\D/g, "");
    const normalized = normalizeNumberWithCountryCode(rawClean, countryCode);

    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    // Validate realistic E.164 phone number length (10 to 15 digits with country code)
    // Specifically for Nigeria (234), valid numbers are 13 digits (234 + 10 digits)
    if (
      normalized.length < 10 ||
      normalized.length > 15 ||
      (normalized.startsWith("234") && normalized.length !== 13)
    ) {
      failed.push({
        raw: rawClean || digitsOnly,
        num: normalized,
        reason:
          normalized.startsWith("234") && normalized.length !== 13
            ? `Incomplete number (${digitsOnly.length} digits provided; Nigerian numbers require 11 local digits or 13 with +234)`
            : `Invalid phone number length (${digitsOnly.length} digits)`,
      });
      continue;
    }

    const jid = `${normalized}@s.whatsapp.net`;
    try {
      const res = await adminSession.sock.groupParticipantsUpdate(chatId, [jid], "add");
      const firstStatus = Array.isArray(res) && res[0]?.status ? String(res[0].status) : "200";
      if (firstStatus === "200") {
        added.push({ num: normalized, jid, alreadyIn: false });
      } else if (firstStatus === "409") {
        added.push({ num: normalized, jid, alreadyIn: true });
      } else {
        const statusReason =
          firstStatus === "403"
            ? "User's WhatsApp privacy settings restrict being added directly to groups"
            : firstStatus === "408"
              ? "User recently left this group or invite timed out"
              : firstStatus === "400" || firstStatus === "404"
                ? "Number is not registered on WhatsApp"
                : `WhatsApp returned status ${firstStatus}`;
        failed.push({ raw: rawClean, num: normalized, reason: statusReason });
      }
    } catch (err) {
      failed.push({
        raw: rawClean,
        num: normalized,
        reason: err?.message || "WhatsApp rejected the add request",
      });
    }
  }

  const lines = [];
  for (const a of added) {
    lines.push(`✅ Added ${a.num}${a.alreadyIn ? " (already in group)" : ""}`);
  }
  for (const f of failed) {
    lines.push(`❌ Couldn't add ${f.raw || f.num} — ${f.reason}`);
  }

  if (lines.length === 0) {
    return reply("⚠️ No valid phone numbers were found to add.");
  }

  return reply(lines.join("\n"), {
    mentions: added.map((a) => a.jid),
  });
}

export default async function meta(ctx) {
  const {
    sock,
    message,
    chatId,
    sender,
    senderJids = [],
    senderIsLinkedAccount,
    args = [],
    text = "",
    reply,
    userId = "default",
    botNumber = "",
  } = ctx;

  const rawPrompt = String(text || "").trim();
  const lower = rawPrompt.toLowerCase();

  const quotedMsg = getQuotedMessage(message);
  const quotedText = quotedMsg ? getMessageText({ message: quotedMsg }) : "";
  const sourceMediaMsg = quotedMsg || message;
  const sourceMediaType = mediaTypeFromMessage(sourceMediaMsg);
  const unwrappedSource = unwrapMediaMessage(sourceMediaMsg);
  const hasImageMedia =
    sourceMediaType === "image" ||
    Boolean(unwrappedSource?.imageMessage) ||
    Boolean(unwrappedSource?.documentMessage?.mimetype?.startsWith("image/"));

  // Keep chat name updated if Meta is active in this chat
  if (!message?.key?.fromMe && message?.pushName && !isGroup(chatId)) {
    const num = extractParticipantNumber(chatId) || chatId.split("@")[0];
    updateMetaChatName(userId, chatId, `${message.pushName} (+${num})`);
  }

  // =========================================================================
  // 0. CONTINUOUS META MODE CONTROLS (Owner-Only)
  // (.start meta, .meta on, .stop meta, .meta off, .private meta, .public meta,
  //  .meta off all, .meta list where you are on / check all places responding)
  // =========================================================================
  if (senderIsLinkedAccount && rawPrompt) {
    // A. Turn OFF Meta in ALL chats ("meta off all", "meta off all my chat", "stop meta everywhere")
    if (
      /\b(?:off|stop|disable|deactivate)\s+all(?:\s+my)?(?:\s+chats?|\s+groups?|\s+places?)?\b/i.test(lower) ||
      /\b(?:meta|ai)\s+(?:off|stop)\s+(?:everywhere|all)\b/i.test(lower) ||
      /\b(?:stop|turn\s+off)\s+meta\s+(?:in\s+)?all\b/i.test(lower)
    ) {
      const disabledList = disableAllMetaChats(userId);
      if (disabledList.length === 0) {
        return reply("ℹ️ Meta AI continuous mode is already *OFF* across all your personal chats and groups.");
      }
      const summaryLines = disabledList.map(
        (s, idx) => `${idx + 1}. *${s.chatName}* (${s.isGroup ? "Group" : "Direct Chat"}) — was *${s.mode.toUpperCase()}*`
      );
      return reply(
        [
          "🛑 *META AI TURNED OFF EVERYWHERE*",
          "────────────────────────────",
          `Deactivated continuous Meta AI in *${disabledList.length}* chat(s):`,
          ...summaryLines,
          "",
          "✅ Normal chatting and standard commands are now active everywhere.",
        ].join("\n")
      );
    }

    // B. List all chats/groups where Meta is currently ON ("list where you are on", "check all the place you are responding")
    if (
      /^(?:list|status|where\s+are\s+you\s+on|list\s+where\s+you\s+are\s+on|check\s+all\s+the\s+places?\s+you\s+are\s+responding|where\s+is\s+meta\s+on|active\s+chats)$/i.test(
        lower
      ) ||
      /\b(list\s+where\s+you\s+are\s+on|places?\s+you\s+are\s+responding|where\s+you\s+are\s+active|chats?\s+where\s+meta\s+is\s+on)\b/i.test(
        lower
      )
    ) {
      const activeChats = listActiveMetaChats(userId);
      if (activeChats.length === 0) {
        return reply(
          "ℹ️ *Meta AI is not currently turned ON in any chat.*\n\nUse *.start meta* (or *.meta on*), *.private meta*, or *.public meta* inside any friend's chat or group to activate continuous mode."
        );
      }

      const lines = activeChats.map((s, idx) => {
        const typeLabel = s.isGroup ? "👥 Group" : "👤 Friend / DM";
        const modeBadge =
          s.mode === "public"
            ? "🌐 *[PUBLIC]*"
            : s.strictPrivate
              ? "🔒 *[PRIVATE - Strict Owner Only]*"
              : "🔐 *[PRIVATE - Owner Chat + Group Quiz]*";
        return `${idx + 1}. ${modeBadge} — *${s.chatName}* (${typeLabel})`;
      });

      return reply(
        [
          `📡 *ACTIVE META AI CHATS (${activeChats.length})*`,
          "────────────────────────────",
          ...lines,
          "",
          "💡 _Send *.stop meta* in a chat to turn it off there, or *.meta off all* to turn off every chat at once._",
        ].join("\n")
      );
    }

    // C. Set Meta to PRIVATE mode in this chat (".private meta", ".meta private", "private meta", "private your self")
    if (
      /^(?:private|private\s+meta|meta\s+private|set\s+(?:to\s+)?private|only\s+me|private\s+your\s*self|make\s+your\s*self\s+private|be\s+private|go\s+private|private\s+mode|only\s+answer\s+me)$/i.test(
        lower
      ) ||
      /\b(?:private\s+your\s*self|make\s+your\s*self\s+private|switch\s+to\s+private\s+mode)\b/i.test(lower)
    ) {
      const chatName = await resolveFriendlyChatName(sock, chatId, message);
      setMetaChatMode(userId, chatId, {
        enabled: true,
        mode: "private",
        strictPrivate: true,
        chatName,
      });
      return reply(
        [
          "🔒 *META AI: PRIVATE MODE ON*",
          "────────────────────────────",
          `📍 *Chat:* ${chatName}`,
          "👤 *Access:* Strictly *You (Owner Only)*",
          "",
          "I am now in *Private Mode* in this chat — I will only respond to your messages and ignore everyone else.",
          "",
          "💡 _Say *public yourself* (or *.public meta*) to let everyone interact, or *stop meta* when done._",
        ].join("\n")
      );
    }

    // D. Set Meta to PUBLIC mode in this chat (".public meta", ".meta public", ".public", "public meta", "public your self")
    if (
      /^(?:public|public\s+meta|meta\s+public|set\s+(?:to\s+)?public|everyone|public\s+your\s*self|make\s+your\s*self\s+public|be\s+public|go\s+public|public\s+mode|answer\s+everyone)$/i.test(
        lower
      ) ||
      /\b(?:public\s+your\s*self|make\s+your\s*self\s+public|switch\s+to\s+public\s+mode)\b/i.test(lower)
    ) {
      const chatName = await resolveFriendlyChatName(sock, chatId, message);
      setMetaChatMode(userId, chatId, {
        enabled: true,
        mode: "public",
        strictPrivate: false,
        chatName,
      });
      return reply(
        [
          "🌐 *META AI: PUBLIC MODE ON*",
          "────────────────────────────",
          `📍 *Chat:* ${chatName}`,
          "👥 *Access:* *Everyone in this chat*",
          "",
          "I am now in *Public Mode*! Anyone in this chat can talk to me or play games/quizzes without typing *.meta*.",
          "",
          "💡 _Say *private yourself* (or *.private meta*) for owner-only mode, or *stop meta* to turn off._",
        ].join("\n")
      );
    }

    // E. Turn Meta ON in this chat (".start meta", ".meta on", ".meta start", "start meta", "meta on")
    if (/^(?:on|start|start\s+meta|meta\s+on|meta\s+start|enable|activate|on\s+your\s*self|turn\s+on)$/i.test(lower)) {
      const chatName = await resolveFriendlyChatName(sock, chatId, message);
      setMetaChatMode(userId, chatId, {
        enabled: true,
        mode: "private",
        strictPrivate: false,
        chatName,
      });
      return reply(
        [
          "🤖 *META AI CONTINUOUS MODE: ON*",
          "────────────────────────────",
          `📍 *Chat:* ${chatName}`,
          "🔐 *Mode:* *Owner Active* (replies to your messages directly + accepts group quiz answers)",
          "",
          "You can now chat with me normally, ask for pictures, open view-once media, delete messages, or manage the group *without typing .meta*!",
          "",
          "💡 _Say *public yourself* so others can chat with me too, *private yourself* for strict owner-only, or *stop meta* to turn off._",
        ].join("\n")
      );
    }

    // F. Turn Meta OFF in this chat (".stop meta", ".meta off", ".meta stop", "stop meta", "meta off", "off your self")
    if (
      /^(?:off|stop|stop\s+meta|meta\s+off|meta\s+stop|disable|deactivate|off\s+your\s*self|stop\s+your\s*self|turn\s+your\s*self\s+off)$/i.test(
        lower
      )
    ) {
      clearPendingClarification(userId, chatId, sender);
      const chatName = await resolveFriendlyChatName(sock, chatId, message);
      setMetaChatMode(userId, chatId, { enabled: false });
      return reply(
        `🛑 *Meta AI continuous mode is now OFF* in *${chatName}*.\nYou can now chat normally or use your standard bot commands.`
      );
    }
  }

  // =========================================================================
  // 1. RESOLVE ANY ACTIVE PENDING CLARIFICATION IN THIS CHAT
  // (e.g. User replying with outfit/style for an image, or country code for numbers)
  // =========================================================================
  const pending = getPendingClarification(userId, chatId, sender);
  if (pending && rawPrompt && !/^(?:cancel|stop|nevermind|never\s+mind|forget\s+it|no)$/i.test(lower)) {
    // 1A. Pending Image Generation Outfit/Style Clarification
    if (pending.type === "image_generation") {
      clearPendingClarification(userId, chatId, sender);
      const combinedPrompt = `${pending.basePrompt}, ${rawPrompt}`;
      try {
        const imgResult = await generateMetaImage(combinedPrompt);
        return sock.sendMessage(chatId, {
          image: imgResult.buffer,
          caption: imgResult.caption,
        });
      } catch (err) {
        return reply(`❌ ${err.message || "Could not generate image right now."}`);
      }
    }

    // 1B. Pending Game Choice Clarification (e.g. after user said "Let play game" and now replies "Quiz i mean")
    if (pending.type === "choose_game") {
      if (/\b(quiz|trivia|question|1)\b/i.test(lower)) {
        clearPendingClarification(userId, chatId, sender);
        const topicMatch = rawPrompt.match(/\babout\s+([a-zA-Z0-9\s]+)$/i);
        const topic = topicMatch ? topicMatch[1].trim() : "";
        const questions = await buildQuizQuestions(topic, 5);
        const game = startGroupGame(chatId, {
          type: "quiz",
          title: topic ? `SOLVATECH ${topic.toUpperCase()} QUIZ` : "SOLVATECH TRIVIA QUIZ",
          questions,
          keepScore: true,
        });
        return reply(formatCurrentGamePrompt(game));
      }
      if (/\b(riddle|brain|2)\b/i.test(lower)) {
        clearPendingClarification(userId, chatId, sender);
        const riddles = pickRiddles(3);
        const game = startGroupGame(chatId, {
          type: "riddle",
          title: "SOLVATECH RIDDLE CHALLENGE",
          questions: riddles,
          keepScore: true,
        });
        return reply(formatCurrentGamePrompt(game));
      }
      if (/\b(scramble|unscramble|word|3)\b/i.test(lower)) {
        clearPendingClarification(userId, chatId, sender);
        const words = pickScrambleWords(3);
        const game = startGroupGame(chatId, {
          type: "scramble",
          title: "SOLVATECH WORD SCRAMBLE",
          questions: words,
          keepScore: true,
        });
        return reply(formatCurrentGamePrompt(game));
      }
      if (/\b(number|guess|4)\b/i.test(lower)) {
        clearPendingClarification(userId, chatId, sender);
        const secret = Math.floor(Math.random() * 50) + 1;
        const game = startGroupGame(chatId, {
          type: "number",
          title: "SOLVATECH NUMBER GUESSING GAME",
          questions: [{ min: 1, max: 50, target: secret, attempts: 0 }],
          keepScore: true,
        });
        return reply(formatCurrentGamePrompt(game));
      }
    }

    // 1C. Pending Phone Numbers Country Code Clarification
    if (pending.type === "add_numbers_country" || pending.type === "confirm_add_numbers") {
      const detectedCode = resolveCountryDialCode(rawPrompt);
      if (detectedCode) {
        clearPendingClarification(userId, chatId, sender);
        const authCheck = await resolveAuthorizedGroupAdminSession({
          sock,
          chatId,
          sender,
          senderJids,
          userId,
          botNumber,
        });
        if (!authCheck.ok) {
          if (authCheck.notBotAdmin) {
            return reply(
              "❌ I am unable to add the number(s) because the group admins did not allow regular members to add participants, and this bot account is not a group admin here."
            );
          }
          return reply(authCheck.error);
        }
        return executeGroupAddNumbers({
          adminSession: authCheck.adminSession,
          chatId,
          rawNumbers: pending.rawNumbers,
          countryCode: detectedCode,
          reply,
        });
      }
    }
  } else if (pending && /^(?:cancel|stop|nevermind|never\s+mind|forget\s+it|no)$/i.test(lower)) {
    clearPendingClarification(userId, chatId, sender);
    return reply("👍 Got it, I've cancelled that request. What else can I help you with?");
  }

  // =========================================================================
  // 2. BARE `.meta` WITH NO TEXT
  // =========================================================================
  if (!rawPrompt) {
    if (hasImageMedia) {
      try {
        const imgBuf = await downloadMessageMedia(sourceMediaMsg, "imageMessage", sock);
        const explanation = await explainImageBuffer(imgBuf, "Explain this image and transcribe any visible text.");
        return reply(explanation);
      } catch (err) {
        return reply(`❌ Could not analyze image: ${err.message || "Download failed"}`);
      }
    }

    if (quotedText) {
      const response = await generateMetaConversationalReply(
        "Explain or respond to this message naturally.",
        quotedText,
        { userId, chatId, senderName: message?.pushName || "" }
      );
      return reply(response);
    }

    const activeState = getMetaChatMode(userId, chatId);
    const statusLine = activeState
      ? `🟢 *Continuous Mode in this Chat:* ON (*${activeState.mode.toUpperCase()}*)`
      : `⚪ *Continuous Mode in this Chat:* OFF (Send *.start meta* to chat without typing .meta)`;

    return reply(
      [
        "🤖 *SOLVATECH META AI*",
        "────────────────────────────",
        statusLine,
        "",
        "I am your general-purpose AI assistant (like ChatGPT) with full control of your WhatsApp tools:",
        "• *Ask Anything:* Science, coding, math, writing, world facts, or normal chat",
        "• *Generate Pictures:* `.meta give me a fine pic of a guy in a black suit`",
        "• *Continuous Mode:* `.start meta` / `.stop meta` / `.private meta` / `.public meta`",
        "• *Manage Active Chats:* `.meta list where you are on` / `.meta off all`",
        "• *Chat & Group Tools:* Summarize chat, check who is online, start quizzes/riddles, add/remove members, OCR images, reveal view-once, or delete messages.",
      ].join("\n")
    );
  }

  // =========================================================================
  // 3. ACTIVE GROUP GAME ANSWER EVALUATION
  // =========================================================================
  const activeGame = getActiveGame(chatId);
  const currentMetaMode = getMetaChatMode(userId, chatId);
  const blockGameForNonOwner =
    currentMetaMode?.enabled &&
    currentMetaMode.mode === "private" &&
    currentMetaMode.strictPrivate &&
    !senderIsLinkedAccount;

  if (
    activeGame &&
    !blockGameForNonOwner &&
    !/\b(start|new|stop|end|cancel|score|leaderboard|hint|next|skip|summarize|delete|remove|kick|add|license|expire|online|translate|pic|picture|photo|image|draw)\b/i.test(
      lower
    )
  ) {
    const evalResult = evaluateGameAnswer(chatId, rawPrompt, sender, message?.pushName || "");
    if (evalResult.matched) {
      return reply(
        evalResult.responseText,
        evalResult.mentions?.length ? { mentions: evalResult.mentions } : {}
      );
    }
  }

  // =========================================================================
  // 4. IMAGE / PICTURE GENERATION ("give me a fine pic of a guy", "generate an image of...")
  // =========================================================================
  const isImageGenerationRequest =
    !hasImageMedia &&
    !quotedMsg &&
    (/\b(?:give|send|show|generate|create|make|draw|get)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+)?(?:fine\s+|nice\s+|cool\s+|handsome\s+|beautiful\s+|good\s+|cute\s+)?(?:picture|pic|photo|image|portrait|drawing|wallpaper|artwork)\b/i.test(
      lower
    ) ||
      /^(?:picture|pic|photo|image)\s+of\s+/i.test(lower));

  if (isImageGenerationRequest) {
    const subject = rawPrompt
      .replace(
        /^(?:please\s+)?(?:can\s+you\s+)?(?:give|send|show|generate|create|make|draw|get)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+)?(?:fine\s+|nice\s+|cool\s+|good\s+)?(?:picture|pic|photo|image|portrait|drawing|wallpaper|artwork)\s*(?:of\s+)?/i,
        ""
      )
      .trim();

    if (!subject) {
      setPendingClarification(userId, chatId, sender, {
        type: "image_generation",
        basePrompt: "High quality portrait",
      });
      return reply("🎨 What would you like me to generate a picture of? Describe it and I'll create it right away!");
    }

    // Check if the user asked for a vague person/character ("a guy", "a fine guy", "a girl", "a man", "a woman", "a boy", "a lady")
    // without specifying outfit/cloth/setting — ask naturally just like the user requested!
    const isPersonSubject = /\b(guy|man|boy|gentleman|girl|woman|lady|person|model)\b/i.test(subject);
    const hasOutfitOrSettingDetail =
      /\b(wearing|dressed|suit|shirt|hoodie|jacket|agbada|native|kaftan|dress|gown|jeans|tuxedo|uniform|armor|casual|traditional|streetwear|beach|office|car|studio|city|night|forest|gym|crown|glasses)\b/i.test(
        subject
      ) || subject.split(/\s+/).length >= 6;

    if (isPersonSubject && !hasOutfitOrSettingDetail) {
      setPendingClarification(userId, chatId, sender, {
        type: "image_generation",
        basePrompt: subject,
      });
      return reply(
        `🎨 Sure! In which cloth/outfit or style should *${subject}* be (for example: a sharp black suit, white native attire/agbada, casual streetwear, or corporate wear)?\n\n_(Reply directly with your choice and I'll generate the picture immediately!)_`
      );
    }

    try {
      const imgResult = await generateMetaImage(subject);
      return sock.sendMessage(chatId, {
        image: imgResult.buffer,
        caption: imgResult.caption,
      });
    } catch (err) {
      return reply(`❌ ${err.message || "Could not generate that image right now."}`);
    }
  }

  // =========================================================================
  // OWNER-ONLY / ADMIN CAPABILITIES GUARD WHEN IN PUBLIC MODE
  // If a non-owner in a Public Meta chat sends a message, only allow safe AI,
  // games, translation, OCR, and image generation — never owner account/delete actions.
  // =========================================================================
  if (currentMetaMode?.mode === "public" && !senderIsLinkedAccount) {
    // Allow OCR / Image explanation
    if (hasImageMedia) {
      try {
        const imgBuf = await downloadMessageMedia(sourceMediaMsg, "imageMessage", sock);
        if (/\b(extract|ocr|read\s+.*text|transcribe|words)\b/i.test(lower)) {
          const textOut = await extractTextFromImage(imgBuf);
          return reply(textOut ? `📖 *EXTRACTED TEXT:*\n${textOut}` : "🔍 No readable text detected in this image.");
        }
        const explanation = await explainImageBuffer(imgBuf, rawPrompt);
        return reply(explanation);
      } catch (err) {
        return reply(`❌ Could not process image: ${err.message}`);
      }
    }

    // Allow Translation
    if (/\btranslate\b/i.test(lower)) {
      const langMatch = rawPrompt.match(/\b(?:to|into|in)\s+([a-zA-Z]+)\b/i);
      const targetLanguage = langMatch ? langMatch[1] : "English";
      const textToTranslate =
        quotedText ||
        rawPrompt
          .replace(/^(?:please\s+)?translate(?:\s+this)?(?:\s+(?:to|into|in)\s+[a-zA-Z]+)?\s*[:\-]?\s*/i, "")
          .trim();
      if (textToTranslate) {
        const translated = await translateContent(textToTranslate, targetLanguage);
        return reply(translated);
      }
    }

    // General worldwide AI conversation for public participants
    const publicAiResponse = await generateMetaConversationalReply(rawPrompt, quotedText, {
      userId,
      chatId,
      senderName: message?.pushName || "",
    });
    return reply(publicAiResponse);
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 1: LICENSE & ACCOUNT EXPIRY
  // -------------------------------------------------------------------------
  if (
    /\b(license|licence|expiry|expire|expires|expiration|subscription)\b/i.test(lower) &&
    !/\b(find|where|who|mentioned|talked|chat|summary|summarize)\b/i.test(lower)
  ) {
    return expire(ctx);
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 2: MESSAGE DELETION ("delete my last 5 messages", "delete the message I'm replying to")
  // -------------------------------------------------------------------------
  if (
    /\b(delete|erase|unsend|clear)\b/i.test(lower) &&
    /\b(message|messages|msg|msgs|replying|replied|this|last)\b/i.test(lower)
  ) {
    const lastNMatch =
      lower.match(/\b(?:delete|erase|unsend|clear)\s+(?:my\s+)?last\s+(\d+)\s*(?:messages?|msgs?)?\b/i) ||
      lower.match(/\b(?:delete|erase|unsend|clear)\s+(\d+)\s+(?:of\s+my\s+)?(?:last|recent)\s*(?:messages?|msgs?)\b/i);
    const isSingleLastSelf = /\b(?:delete|erase|unsend)\s+my\s+last\s+(?:message|msg)\b/i.test(lower);

    if (lastNMatch || isSingleLastSelf) {
      const requestedCount = lastNMatch ? Math.max(1, Math.min(50, parseInt(lastNMatch[1], 10))) : 1;
      const ownCandidates = [
        sender,
        ...senderJids,
        sock.user?.id,
        sock.user?.lid,
        sock.user?.phoneNumber,
        botNumber ? `${botNumber}@s.whatsapp.net` : "",
      ].filter(Boolean);

      const recentSelfMsgs = getRecentMessagesBySender(chatId, ownCandidates, requestedCount, {
        excludeMessageId: message.key?.id,
        includeFromMe: true,
      });

      if (recentSelfMsgs.length === 0) {
        return reply("ℹ️ I couldn't find any recent messages from you in my current session history to delete.");
      }

      let deletedCount = 0;
      for (const item of recentSelfMsgs) {
        try {
          await sock.sendMessage(chatId, {
            delete: {
              remoteJid: chatId,
              fromMe: Boolean(item.fromMe),
              id: item.id,
              ...(item.key?.participant ? { participant: item.key.participant } : {}),
            },
          });
          removeChatMessageById(chatId, item.id);
          deletedCount += 1;
        } catch (err) {
          logger.debug?.("Failed to delete message in batch", err?.message || err);
        }
      }

      if (message.key?.id) {
        try {
          message._alreadyReactedAndDeleted = true;
          await sock.sendMessage(chatId, {
            delete: {
              remoteJid: chatId,
              fromMe: Boolean(message.key.fromMe),
              id: message.key.id,
              ...(message.key.participant ? { participant: message.key.participant } : {}),
            },
          });
          removeChatMessageById(chatId, message.key.id);
        } catch {}
      }

      const noticeSent = await sock.sendMessage(chatId, {
        text: `🗑️ Deleted *${deletedCount}* of your recent message${deletedCount === 1 ? "" : "s"}.`,
      });
      if (noticeSent?.key?.id) {
        scheduleAutoDeleteNotice(sock, chatId, noticeSent.key, 4000);
      }
      return;
    }

    const quotedDeleteKey = resolveQuotedDeleteKey(message, chatId);
    if (!quotedDeleteKey) {
      return reply(
        "⚠️ Please reply directly to the message you want me to delete, or specify e.g. `delete my last 5 messages`."
      );
    }

    const contextInfo = getContextInfo(message);
    const quotedSender = contextInfo?.participant ? normalizedUser(contextInfo.participant) : "";
    const ownJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
      botNumber ? `${botNumber}@s.whatsapp.net` : "",
    ]
      .filter(Boolean)
      .map(normalizedUser);
    const ownAliases = new Set(ownJids.flatMap(jidAliases));
    const quotedIsOwn = !quotedSender || jidAliases(quotedSender).some((a) => ownAliases.has(a));

    let deleteSock = sock;
    if (isGroup(chatId) && !quotedIsOwn) {
      const authCheck = await resolveAuthorizedGroupAdminSession({
        sock,
        chatId,
        sender,
        senderJids,
        userId,
        botNumber,
      });
      if (!authCheck.ok) {
        return reply(authCheck.error);
      }
      deleteSock = authCheck.adminSession.sock;
    }

    try {
      await deleteSock.sendMessage(chatId, { delete: quotedDeleteKey });
      removeChatMessageById(chatId, quotedDeleteKey.id);

      if (message.key?.id) {
        try {
          message._alreadyReactedAndDeleted = true;
          await deleteSock.sendMessage(chatId, {
            delete: {
              remoteJid: chatId,
              fromMe: Boolean(message.key.fromMe),
              id: message.key.id,
              ...(message.key.participant ? { participant: message.key.participant } : {}),
            },
          });
          removeChatMessageById(chatId, message.key.id);
        } catch {}
      }

      const confirmMsg = await deleteSock.sendMessage(chatId, {
        text: "🗑️ Replied-to message has been deleted.",
      });
      if (confirmMsg?.key?.id) {
        scheduleAutoDeleteNotice(deleteSock, chatId, confirmMsg.key, 4000);
      }
      return;
    } catch (err) {
      return reply(`❌ Could not delete that message: ${err.message || "Permission denied"}`);
    }
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 3: ONLINE / ACTIVE PRESENCE DETECTION
  // -------------------------------------------------------------------------
  if (/\b(online|active\s+right\s+now|currently\s+active|who\s+is\s+here|who\s+is\s+around)\b/i.test(lower)) {
    if (!isGroup(chatId)) {
      return reply("🟢 You and *SOLVATECH BOT* are currently active in this direct chat.");
    }

    let metadata = null;
    try {
      metadata = await sock.groupMetadata(chatId);
      if (typeof sock.presenceSubscribe === "function") {
        await sock.presenceSubscribe(chatId).catch(() => {});
      }
    } catch {
      return reply("❌ Could not fetch group information to check online members.");
    }

    const onlineList = getOnlineParticipantsForChat(chatId, metadata);
    const shouldMention = /\b(mention|tag|ping|call)\b/i.test(lower);

    if (onlineList.length === 0) {
      const botNum = botNumber || extractParticipantNumber(sock.user?.id) || "";
      const selfJid = sender || (botNum ? `${botNum}@s.whatsapp.net` : "");
      return reply(
        [
          "🟢 *CURRENTLY ONLINE / ACTIVE IN GROUP*",
          "────────────────────────────",
          selfJid
            ? `• @${extractParticipantNumber(selfJid)} — 🟢 Online now (You)`
            : "• No other members have broadcast live online presence in the last few minutes.",
          "",
          "ℹ️ _Note: WhatsApp only shares live presence for members who have interacted recently or have online visibility enabled._",
        ].join("\n"),
        selfJid ? { mentions: [selfJid] } : {}
      );
    }

    const mentions = onlineList.map((u) => u.mentionJid).filter(Boolean);
    const memberLines = onlineList.map(
      (u, idx) => `${idx + 1}. @${u.userNumber}${u.pushName ? ` (*${u.pushName}*)` : ""} — ${u.statusLabel}`
    );

    const header = shouldMention
      ? `📢 *MENTIONING CURRENTLY ONLINE / ACTIVE MEMBERS (${onlineList.length})*`
      : `🟢 *CURRENTLY ONLINE / ACTIVE MEMBERS (${onlineList.length})*`;

    return reply(
      [header, `Group: *${metadata.subject || "Group"}*`, "────────────────────────────", ...memberLines].join("\n"),
      { mentions }
    );
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 4: GROUP ADMINISTRATION — REMOVE N RANDOM MEMBERS
  // -------------------------------------------------------------------------
  const randomKickMatch = lower.match(
    /\b(?:remove|kick|boot)\s+(\d+)\s+random\s+(?:members?|participants?|users?|people)\b/i
  );
  if (randomKickMatch) {
    const requestedCount = parseInt(randomKickMatch[1], 10);
    if (!requestedCount || requestedCount <= 0) {
      return reply("⚠️ Please specify a valid number of random members to remove (e.g. `.meta remove 5 random members`).");
    }

    const authCheck = await resolveAuthorizedGroupAdminSession({
      sock,
      chatId,
      sender,
      senderJids,
      userId,
      botNumber,
    });
    if (!authCheck.ok) {
      return reply(authCheck.error);
    }

    const { adminSession, allAdminSessions, metadata } = authCheck;
    const callerAliases = new Set([sender, ...senderJids].filter(Boolean).flatMap(jidAliases));
    const callerNumbers = new Set([sender, ...senderJids].map((j) => extractParticipantNumber(j)).filter(Boolean));

    const eligibleTargets = (metadata.participants || []).filter((p) => {
      if (p.admin === "admin" || p.admin === "superadmin" || p.admin === true) return false;
      const pJids = [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean);
      const pAliases = pJids.flatMap(jidAliases);
      const pNums = pJids.map((j) => extractParticipantNumber(j)).filter(Boolean);

      if (pAliases.some((a) => callerAliases.has(a)) || pNums.some((n) => callerNumbers.has(n))) {
        return false;
      }

      const targetInfo = extractParticipantTargetDetails(p, metadata);
      if (targetInfo && allAdminSessions.some((sess) => doesSessionMatchParticipant(sess, targetInfo))) {
        return false;
      }
      return true;
    });

    if (eligibleTargets.length === 0) {
      return reply("ℹ️ There are no eligible non-admin members in this group to remove.");
    }

    const shuffled = [...eligibleTargets];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const selected = shuffled.slice(0, Math.min(requestedCount, shuffled.length));
    const removedNumbers = [];
    const removedMentions = [];
    let failedCount = 0;

    for (const participant of selected) {
      try {
        await adminSession.sock.groupParticipantsUpdate(chatId, [participant.id], "remove");
        const num =
          extractParticipantNumber(participant.phoneNumber || participant.id) || participant.id.split("@")[0];
        removedNumbers.push(`@${num}`);
        removedMentions.push(participant.id);
      } catch (err) {
        failedCount += 1;
        logger.warn(`Failed to remove random member ${participant.id}:`, err.message);
      }
    }

    if (removedNumbers.length === 0) {
      return reply("❌ Failed to remove the selected members. Please verify the bot's group admin permissions.");
    }

    return reply(
      [
        `👢 *RANDOM MEMBER REMOVAL COMPLETE*`,
        "────────────────────────────",
        `✅ *Removed:* ${removedNumbers.length} / ${selected.length} requested (${eligibleTargets.length} non-admin members were eligible)`,
        ...(failedCount > 0 ? [`⚠️ *Failed:* ${failedCount}`] : []),
        "",
        removedNumbers.join(", "),
      ].join("\n"),
      { mentions: removedMentions }
    );
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 5: GROUP ADMINISTRATION — ADD ONE OR MORE NUMBERS TO GROUP
  // Supports country-code clarification when local/ambiguous numbers are pushed!
  // -------------------------------------------------------------------------
  const combinedTextForNumbers = `${rawPrompt} ${quotedText || ""}`;
  const rawPhoneMatches =
    combinedTextForNumbers.match(/(?:\+\d{1,3}(?:[\s-]?\d{2,5}){2,4}|\b0?\d{7,14}\b)/g) || [];
  const isBareNumberListInGroup =
    isGroup(chatId) &&
    rawPhoneMatches.length >= 2 &&
    rawPrompt.replace(/[\d\s,+\-().]/g, "").trim().length < 15;

  if (
    isBareNumberListInGroup ||
    (/\b(add|invite)\b/i.test(lower) &&
      (/\b(number|numbers|person|people|member|members|group|them|him|her|these)\b/i.test(lower) ||
        rawPhoneMatches.length > 0))
  ) {
    if (!isGroup(chatId)) {
      return reply("⚠️ I can only add phone numbers inside a WhatsApp group chat.");
    }

    const authCheck = await resolveAuthorizedGroupAdminSession({
      sock,
      chatId,
      sender,
      senderJids,
      userId,
      botNumber,
    });

    if (!authCheck.ok) {
      if (authCheck.notBotAdmin) {
        return reply(
          "❌ I am unable to add the number(s) to this group because the group admins did not allow non-admin members to add participants, and this bot account is not currently a group admin here."
        );
      }
      return reply(authCheck.error);
    }

    if (rawPhoneMatches.length === 0) {
      return reply(
        "⚠️ Please provide or reply to the phone number(s) you want me to add to the group.\nExample: `.meta add 09083939939 08012345678`"
      );
    }

    // Check if the user already specified a country in their prompt (e.g. "Nigeria", "+234")
    const explicitCountryInPrompt = resolveCountryDialCode(rawPrompt);

    // Check if any number lacks an explicit international prefix (e.g. starts with '0' or is < 11 digits without '+')
    const hasAmbiguousLocalNumbers = rawPhoneMatches.some((raw) => {
      const trimmed = raw.trim();
      if (trimmed.startsWith("+")) return false;
      const digits = trimmed.replace(/\D/g, "");
      if (digits.startsWith("234") && digits.length === 13) return false;
      if (digits.startsWith("233") && digits.length === 12) return false;
      if (digits.startsWith("44") && digits.length >= 11) return false;
      return true;
    });

    if (hasAmbiguousLocalNumbers && !explicitCountryInPrompt) {
      setPendingClarification(userId, chatId, sender, {
        type: "add_numbers_country",
        rawNumbers: rawPhoneMatches,
      });
      const preview = rawPhoneMatches.slice(0, 4).join(", ") + (rawPhoneMatches.length > 4 ? ` ... (+${rawPhoneMatches.length - 4} more)` : "");
      return reply(
        `🌍 I found *${rawPhoneMatches.length}* phone number(s) to add (*${preview}*), but they don't specify a country code.\n\nWhich country or country code do these numbers belong to? (e.g., reply *Nigeria / +234*, *Ghana / +233*, *UK / +44*, or *US / +1*)`
      );
    }

    return executeGroupAddNumbers({
      adminSession: authCheck.adminSession,
      chatId,
      rawNumbers: rawPhoneMatches,
      countryCode: explicitCountryInPrompt || "",
      reply,
    });
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 6: GROUP ADMINISTRATION — REMOVE / KICK SPECIFIC MEMBER(S)
  // -------------------------------------------------------------------------
  if (
    /\b(remove|kick|boot|ban)\b/i.test(lower) &&
    !/\b(admin|role|warn|warning|warnings)\b/i.test(lower)
  ) {
    const authCheck = await resolveAuthorizedGroupAdminSession({
      sock,
      chatId,
      sender,
      senderJids,
      userId,
      botNumber,
    });
    if (!authCheck.ok) {
      return reply(authCheck.error);
    }

    const { adminSession, metadata } = authCheck;
    const resolved = resolveManualWarnTarget(metadata, message, args, chatId);

    const extraNumbers = (rawPrompt.match(/\b\d{7,15}\b/g) || []).map(normalizeNumber);
    const targetCandidates = [];

    if (resolved?.matchedParticipant?.id || resolved?.canonicalJid) {
      targetCandidates.push(resolved.matchedParticipant?.id || resolved.canonicalJid);
    }
    for (const num of extraNumbers) {
      const pJid = participantJid(metadata, `${num}@s.whatsapp.net`);
      if (pJid && !targetCandidates.includes(pJid)) {
        targetCandidates.push(pJid);
      }
    }

    if (targetCandidates.length === 0) {
      return reply("⚠️ Please reply to the person's message or tag the member you want me to remove (e.g. `.meta remove @user`).");
    }

    const removed = [];
    const skippedAdmins = [];
    const failed = [];

    for (const targetJid of targetCandidates) {
      if (isOwner(metadata, targetJid) || isAdmin(metadata, targetJid)) {
        skippedAdmins.push(targetJid);
        continue;
      }
      try {
        await adminSession.sock.groupParticipantsUpdate(chatId, [targetJid], "remove");
        removed.push(targetJid);
      } catch {
        failed.push(targetJid);
      }
    }

    const lines = [];
    if (removed.length > 0) {
      lines.push(`👢 Removed ${removed.map(mentionText).join(", ")} from the group.`);
    }
    if (skippedAdmins.length > 0) {
      lines.push(`⚠️ Cannot remove group admin(s): ${skippedAdmins.map(mentionText).join(", ")}.`);
    }
    if (failed.length > 0) {
      lines.push(`❌ Could not remove: ${failed.map(mentionText).join(", ")}.`);
    }

    return reply(lines.join("\n"), {
      mentions: [...removed, ...skippedAdmins, ...failed],
    });
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 7: GROUP WARNINGS & PROTECTIONS VIA NATURAL LANGUAGE
  // -------------------------------------------------------------------------
  if (/\b(clear|reset)\s+(?:all\s+)?(?:warnings?|warns?)\b/i.test(lower)) {
    if (/\b(all|everyone|group)\b/i.test(lower) && !/@\d+/.test(lower) && !quotedMsg) {
      return resetwarns(ctx);
    }
    return clearwarns(ctx);
  }

  if (/\b(?:warn|issue\s+a\s+warning|give\s+a\s+warning)\b/i.test(lower) && !/\b(limit|check|list|show)\b/i.test(lower)) {
    return executeManualWarn({
      sock,
      chatId,
      sender,
      senderJids,
      args,
      message,
      userId,
      botNumber,
    });
  }

  if (/\b(warning\s+limit|warns?\s+limit|check\s+warnings?|list\s+warnings?|show\s+warnings?)\b/i.test(lower)) {
    const limitMatch = lower.match(/\blimit\s+(?:to\s+)?(\d+)\b/i);
    if (limitMatch) {
      return warns({ ...ctx, args: ["limit", limitMatch[1]] });
    }
    return warns({ ...ctx, args: [] });
  }

  if (/\b(antilink|anti-link|antibot|anti-bot|antistatus|anti-status|status\s+mention)\b/i.test(lower)) {
    const mode = /\b(off|disable|deactivate|stop)\b/i.test(lower) ? "off" : "on";
    if (/\b(antilink|anti-link)\b/i.test(lower)) {
      return anti({ ...ctx, command: "antilink", args: [mode] });
    }
    if (/\b(antibot|anti-bot)\b/i.test(lower)) {
      return anti({ ...ctx, command: "antibot", args: [mode] });
    }
    return anti({ ...ctx, command: "antistatus", args: [mode] });
  }

  if (/\b(auto\s*welcome|welcome\s+message)\b/i.test(lower) && /\b(on|off|enable|disable|turn)\b/i.test(lower)) {
    const mode = /\b(off|disable|deactivate)\b/i.test(lower) ? "off" : "on";
    return welcome({ ...ctx, args: [mode] });
  }

  if (/\b(auto\s*goodbye|goodbye\s+message)\b/i.test(lower) && /\b(on|off|enable|disable|turn)\b/i.test(lower)) {
    const mode = /\b(off|disable|deactivate)\b/i.test(lower) ? "off" : "on";
    return goodbye({ ...ctx, args: [mode] });
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 8: OTHER GROUP ADMIN & UTILITY ACTIONS
  // -------------------------------------------------------------------------
  if (/\b(promote|make\s+.*admin)\b/i.test(lower)) {
    return promote(ctx);
  }
  if (/\b(demote|remove\s+admin|strip\s+admin)\b/i.test(lower)) {
    return demote(ctx);
  }
  if (/\b(lock|mute|close)\s+(?:the\s+)?(?:group|chat)\b/i.test(lower)) {
    return lock(ctx);
  }
  if (/\b(unlock|unmute|open)\s+(?:the\s+)?(?:group|chat)\b/i.test(lower)) {
    return unlock(ctx);
  }
  if (/\b(unpin|pin)\s+(?:this\s+|the\s+)?(?:message|msg)?\b/i.test(lower) && quotedMsg) {
    const isUnpin = /\bunpin\b/i.test(lower);
    return pin({ ...ctx, args: isUnpin ? ["off"] : [] });
  }
  if (/\b(group\s+link|invite\s+link|link\s+for\s+this\s+group)\b/i.test(lower)) {
    return link(ctx);
  }
  if (/\b(group\s+info|group\s+details|about\s+this\s+group|how\s+many\s+members)\b/i.test(lower)) {
    return groupinfo(ctx);
  }
  if (/\b(who\s+are\s+the\s+admins|list\s+admins|tag\s+admins|group\s+admins)\b/i.test(lower)) {
    return admin(ctx);
  }
  if (/\b(mention\s+everyone|tag\s+everyone|tag\s+all|mention\s+all\s+members)\b/i.test(lower) && !/\bonline\b/i.test(lower)) {
    const customText = rawPrompt
      .replace(/^(?:please\s+)?(?:mention|tag)\s+(?:everyone|all(?:\s+members)?)\s*(?:and\s+say|saying|with|:)?\s*/i, "")
      .trim();
    return tagall({ ...ctx, text: customText });
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 9: GROUP ANNOUNCEMENT GENERATION (+ OPTIONAL TAGALL)
  // -------------------------------------------------------------------------
  if (/\b(create|make|write|draft|send)\s+(?:a\s+|an\s+)?(?:group\s+)?(?:announcement|notice)\b/i.test(lower)) {
    const announcementText = await generateMetaConversationalReply(
      `Create a clear, professional WhatsApp group announcement based on this request: "${rawPrompt}".`,
      quotedText,
      { userId, chatId, senderName: message?.pushName || "" }
    );

    if (isGroup(chatId) && /\b(tag\s+everyone|mention\s+everyone|tag\s+all)\b/i.test(lower)) {
      return tagall({ ...ctx, text: announcementText });
    }
    return reply(announcementText);
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 10: GROUP CONVERSATION INTELLIGENCE (SUMMARIZE / SEARCH CHAT)
  // -------------------------------------------------------------------------
  const isSingleQuotedSummary =
    Boolean(quotedText) &&
    /\b(summarize\s+this(?:\s+message)?|explain\s+this\s+message|tldr)\b/i.test(lower) &&
    !/\b(chat|group|conversation|away|offline|messages)\b/i.test(lower);

  if (isSingleQuotedSummary) {
    const singleSummary = await generateMetaConversationalReply(rawPrompt, quotedText, {
      userId,
      chatId,
      senderName: message?.pushName || "",
    });
    return reply(singleSummary);
  }

  if (
    /\b(summarize|summary|what\s+did\s+i\s+miss|while\s+i\s+was\s+away|while\s+i\s+was\s+offline|what\s+happened|what\s+are\s+people\s+discussing|who\s+has\s+been\s+talking|find\s+where\s+someone\s+mentioned|last\s+\d+\s+messages|this\s+conversation|the\s+chat)\b/i.test(
      lower
    )
  ) {
    const countMatch = lower.match(/\blast\s+(\d+)\s+messages?\b/i);
    const limit = countMatch ? Math.max(1, Math.min(200, parseInt(countMatch[1], 10))) : 60;

    const history = getChatHistory(chatId, {
      limit,
      excludeCommands: true,
      excludeBotGenerated: true,
    });

    if (history.length === 0) {
      return reply(
        "I can only summarize the messages currently available to me. There are no recorded messages in my current session history for this chat yet."
      );
    }

    const summaryResponse = await summarizeAvailableMessages(history, rawPrompt);
    return reply(summaryResponse);
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 11: GROUP GAMES, QUIZZES & RIDDLES WITH SCOREKEEPING
  // -------------------------------------------------------------------------
  if (/\b(stop|end|cancel|finish)\s+(?:the\s+)?(?:quiz|game|riddle|trivia)\b/i.test(lower)) {
    const ended = stopGroupGame(chatId);
    if (!ended) {
      return reply("ℹ️ There is no active quiz or game running in this chat right now.");
    }
    const board = formatGameScoreboard(ended);
    return reply(
      ["🛑 *GAME ENDED*", "────────────────────────────", board.text].join("\n"),
      board.mentions.length ? { mentions: board.mentions } : {}
    );
  }

  if (/\b(quiz\s+score|game\s+score|scoreboard|leaderboard|who\s+is\s+winning)\b/i.test(lower)) {
    const currentGame = getActiveGame(chatId);
    if (!currentGame) {
      return reply("ℹ️ No active quiz or game is currently running. Start one with `.meta start a quiz and keep score`!");
    }
    const board = formatGameScoreboard(currentGame);
    return reply(board.text, board.mentions.length ? { mentions: board.mentions } : {});
  }

  if (/\b(hint|clue)\b/i.test(lower) && activeGame) {
    const curr = activeGame.questions[activeGame.currentIndex];
    if (curr?.hint) {
      return reply(`💡 *HINT:* ${curr.hint}`);
    }
    if (curr?.answerLetter) {
      return reply(`💡 *HINT:* The correct option is either *${curr.answerLetter}* or one of its neighbors!`);
    }
  }

  if (
    /\b(start\s+(?:a\s+)?.*quiz|let'?s?\s+play\s+(?:a\s+)?quiz|play\s+(?:a\s+)?quiz|quiz\s+for\s+the\s+group|quiz\s+i\s+mean|i\s+mean\s+quiz|keep\s+score|trivia|let'?s?\s+play\s+(?:a\s+)?game|play\s+(?:a\s+)?game|word\s+scramble|word\s+game|guess\s+the\s+number|riddle\s+for\s+the\s+group|make\s+a\s+riddle|start\s+(?:a\s+)?riddle|let'?s?\s+play\s+riddles?)\b/i.test(
      lower
    ) ||
    /^(?:quiz|trivia|riddles?|word\s+scramble|let'?s?\s+play)$/i.test(lower)
  ) {
    // If user asked generically to "play a game" / "let play game" without specifying which type of game,
    // ask inquisitively so they can pick Quiz, Riddle, Scramble, or Number Guess!
    const specifiedGameType = /\b(quiz|trivia|riddle|riddles|scramble|unscramble|word\s+game|number)\b/i.test(lower);
    if (!specifiedGameType) {
      setPendingClarification(userId, chatId, sender, {
        type: "choose_game",
      });
      return reply(
        [
          "🎮 *AWESOME, LET'S PLAY!*",
          "────────────────────────────",
          "Which game would you like to start right now?",
          "",
          "1️⃣ *Quiz* — Multiple-choice trivia (general knowledge or any topic)",
          "2️⃣ *Riddle* — Brain teasers",
          "3️⃣ *Word Scramble* — Unscramble the hidden word",
          "4️⃣ *Number Guess* — Guess the secret number (1–50)",
          "",
          "💡 _Reply with *Quiz* (or e.g. *Quiz about football*), *Riddle*, *Scramble*, or *Number*!_",
        ].join("\n")
      );
    }

    if (/\briddle\b/i.test(lower)) {
      const riddles = pickRiddles(3);
      const game = startGroupGame(chatId, {
        type: "riddle",
        title: "SOLVATECH GROUP RIDDLE CHALLENGE",
        questions: riddles,
        keepScore: true,
      });
      return reply(formatCurrentGamePrompt(game));
    }

    if (/\b(scramble|unscramble|word\s+game)\b/i.test(lower)) {
      const words = pickScrambleWords(3);
      const game = startGroupGame(chatId, {
        type: "scramble",
        title: "SOLVATECH WORD SCRAMBLE",
        questions: words,
        keepScore: true,
      });
      return reply(formatCurrentGamePrompt(game));
    }

    if (/\b(guess\s+the\s+number|number\s+game)\b/i.test(lower)) {
      const secret = Math.floor(Math.random() * 50) + 1;
      const game = startGroupGame(chatId, {
        type: "number",
        title: "SOLVATECH NUMBER GUESSING GAME",
        questions: [{ min: 1, max: 50, target: secret, attempts: 0 }],
        keepScore: true,
      });
      return reply(formatCurrentGamePrompt(game));
    }

    const topicMatch =
      rawPrompt.match(/\babout\s+([a-zA-Z0-9\s]+)$/i) ||
      rawPrompt.match(/\bstart\s+a\s+([a-zA-Z0-9\s]+?)\s+quiz\b/i);
    const topic =
      topicMatch && !/^(group|new|quick|fun|general)$/i.test(topicMatch[1].trim())
        ? topicMatch[1].trim()
        : "";
    const questions = await buildQuizQuestions(topic, 5);
    const game = startGroupGame(chatId, {
      type: "quiz",
      title: topic ? `SOLVATECH ${topic.toUpperCase()} QUIZ` : "SOLVATECH GROUP TRIVIA QUIZ",
      questions,
      keepScore: true,
    });
    return reply(formatCurrentGamePrompt(game));
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 12: MEDIA, OCR, VIEW-ONCE REVEAL & IMAGE EXPLANATION
  // -------------------------------------------------------------------------
  if (
    hasImageMedia &&
    /\b(extract|ocr|read\s+.*text|transcribe|words\s+in\s+this\s+image|text\s+from\s+this\s+image|copy\s+all\s+the\s+words|what\s+does\s+this\s+screenshot\s+say)\b/i.test(
      lower
    )
  ) {
    return read(ctx);
  }

  if (
    hasImageMedia &&
    /\b(explain|describe|analyze|what\s+is\s+in|what\s+is\s+this|look\s+at|solve|translate)\b/i.test(lower)
  ) {
    try {
      const imgBuf = await downloadMessageMedia(sourceMediaMsg, "imageMessage", sock);
      if (/\btranslate\b/i.test(lower)) {
        const extracted = await extractTextFromImage(imgBuf);
        if (!extracted) {
          return reply("🔍 I couldn't detect any readable text in this image to translate.");
        }
        const langMatch = rawPrompt.match(/\b(?:to|into)\s+([a-zA-Z]+)\b/i);
        const targetLang = langMatch ? langMatch[1] : "English";
        const translated = await translateContent(extracted, targetLang);
        return reply(translated);
      }
      const explanation = await explainImageBuffer(imgBuf, rawPrompt);
      return reply(explanation);
    } catch (err) {
      return reply(`❌ Failed to analyze the image: ${err.message || "Could not process image"}`);
    }
  }

  if (/\b(extract\s+.*text|ocr|read\s+.*image)\b/i.test(lower) && !hasImageMedia) {
    return reply("⚠️ Please attach an image or reply to an image to extract its text.");
  }

  if (/\b(explain\s+this\s+image|describe\s+this\s+image|what\s+is\s+in\s+this\s+image)\b/i.test(lower) && !hasImageMedia) {
    return reply("⚠️ Please attach an image or reply to an image for me to analyze it.");
  }

  if (/\b(make\s+a\s+sticker|turn\s+.*into\s+a\s+sticker|convert\s+to\s+sticker|create\s+sticker)\b/i.test(lower)) {
    return sticker(ctx);
  }

  if (/\b(sticker\s+to\s+(?:image|picture|photo|video)|antisticker|convert\s+sticker)\b/i.test(lower)) {
    return antisticker(ctx);
  }

  if (
    /\b(view\s*onc\s*e?|viewonce|vv|reveal\s+this|open\s+(?:the\s+|this\s+)?view\w*|reveal\s+(?:the\s+|this\s+)?view\w*)\b/i.test(
      lower
    ) ||
    (quotedMsg && /\b(open\s+it|open\s+this|reveal\s+it)\b/i.test(lower))
  ) {
    return open(ctx);
  }

  if (/\b(recover\s+deleted|deleted\s+message|restore\s+deleted|what\s+was\s+deleted)\b/i.test(lower)) {
    return rd(ctx);
  }

  if (/\b(send\s+this\s+status|save\s+this\s+status|download\s+status)\b/i.test(lower)) {
    return send(ctx);
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 13: TRANSLATION ("translate this", "translate to French")
  // -------------------------------------------------------------------------
  if (/\btranslate\b/i.test(lower)) {
    const langMatch = rawPrompt.match(/\b(?:to|into|in)\s+([a-zA-Z]+)\b/i);
    const targetLanguage = langMatch ? langMatch[1] : "English";

    let textToTranslate = quotedText;
    if (!textToTranslate) {
      textToTranslate = rawPrompt
        .replace(/^(?:please\s+)?translate(?:\s+this)?(?:\s+(?:to|into|in)\s+[a-zA-Z]+)?\s*[:\-]?\s*/i, "")
        .trim();
    }

    if (!textToTranslate) {
      return reply("⚠️ Please reply to a message with `translate this` (or `translate to French: <text>`).");
    }

    const translated = await translateContent(textToTranslate, targetLanguage);
    return reply(translated);
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 14: BOT UTILITIES (Share, Profile, Owner, Uptime, Ping, Menu)
  // -------------------------------------------------------------------------
  if (/\b(share\s+bot|referral\s+link|refer\s+a\s+friend)\b/i.test(lower)) {
    return share(ctx);
  }
  if (/\b(check\s+profile|show\s+profile|user\s+profile)\b/i.test(lower)) {
    return profile(ctx);
  }
  if (/\b(bot\s+owner|who\s+created\s+you|developer\s+contact)\b/i.test(lower)) {
    return owner(ctx);
  }
  if (/\b(bot\s+uptime|server\s+uptime|how\s+long\s+have\s+you\s+been\s+online)\b/i.test(lower)) {
    return uptime(ctx);
  }
  if (/\b(ping|bot\s+latency|connection\s+speed)\b/i.test(lower)) {
    return ping(ctx);
  }
  if (/\b(show\s+menu|command\s+list|all\s+commands)\b/i.test(lower)) {
    return menu(ctx);
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 15: CHAT PARTNER / PERSON INSIGHT & UNRESTRICTED WORLDWIDE AI CHAT
  // ("I want to know more about this guy", "Am chatting with this person am chatting with is who", etc.)
  // -------------------------------------------------------------------------
  const liveChatContext = await buildLiveChatContext(sock, chatId, message, botNumber);

  const isAskingAboutChatPartner =
    /\b(who\s+am\s+i\s+chatting\s+with|am\s+chatting\s+with\s+.*is\s+who|who\s+is\s+this\s+(?:guy|person|man|woman|girl|lady|user|boy|contact|friend)|know\s+more\s+about\s+this\s+(?:guy|person|man|woman|girl|lady|user|contact|friend)|tell\s+me\s+(?:more\s+)?about\s+this\s+(?:guy|person|man|woman|girl|lady|user|contact)|about\s+the\s+person\s+i'?m\s+chatting\s+with)\b/i.test(
      lower
    );

  if (isAskingAboutChatPartner) {
    const aiPartnerSummary = await generateMetaConversationalReply(
      `${rawPrompt}\n\n(Provide a clear, natural, helpful breakdown of who this person is using the Live WhatsApp Chat Context above — including their name, phone number, country/region, WhatsApp bio if any, group role if in a group, and what we've been chatting about recently, then ask a friendly follow-up question.)`,
      quotedText,
      {
        userId,
        chatId,
        senderName: message?.pushName || "",
        chatContextSummary: liveChatContext.summaryText,
      }
    );
    return reply(aiPartnerSummary);
  }

  const aiResponse = await generateMetaConversationalReply(rawPrompt, quotedText, {
    userId,
    chatId,
    senderName: message?.pushName || "",
    chatContextSummary: liveChatContext.summaryText,
  });
  return reply(aiResponse);
}

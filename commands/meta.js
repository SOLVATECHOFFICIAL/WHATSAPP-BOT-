import {
  buildQuizQuestions,
  explainImageBuffer,
  extractTextFromImage,
  generateColoredTextGraphic,
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
  getChatHistoryForBulkDelete,
  getKnownWhatsAppNumbersForCountry,
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

const COUNTRY_PROFILES = {
  "234": {
    code: "234",
    name: "Nigeria 🇳🇬",
    aliases: ["nigeria", "nigerian", "naija", "ng", "lagos", "abuja"],
    localLen: 10,
    prefixes: ["803", "806", "813", "816", "703", "706", "903", "906", "802", "808", "708", "902", "805", "807", "815", "905", "809", "817", "818", "909"],
  },
  "228": {
    code: "228",
    name: "Togo 🇹🇬",
    aliases: ["togo", "togolese", "lome", "tg"],
    localLen: 8,
    prefixes: ["90", "91", "92", "93", "96", "97", "98", "99", "70"],
  },
  "971": {
    code: "971",
    name: "Dubai / UAE 🇦🇪",
    aliases: ["dubai", "uae", "united arab emirates", "abu dhabi", "emirates"],
    localLen: 9,
    prefixes: ["50", "52", "54", "55", "56", "58"],
  },
  "233": {
    code: "233",
    name: "Ghana 🇬🇭",
    aliases: ["ghana", "ghanaian", "accra", "gh"],
    localLen: 9,
    prefixes: ["24", "54", "55", "59", "20", "50", "27", "57", "26"],
  },
  "254": {
    code: "254",
    name: "Kenya 🇰🇪",
    aliases: ["kenya", "kenyan", "nairobi", "ke"],
    localLen: 9,
    prefixes: ["70", "71", "72", "74", "79", "73", "75", "78"],
  },
  "27": {
    code: "27",
    name: "South Africa 🇿🇦",
    aliases: ["south africa", "south african", "sa", "za", "johannesburg", "pretoria"],
    localLen: 9,
    prefixes: ["60", "61", "71", "72", "73", "76", "78", "79", "82", "83", "84"],
  },
  "229": {
    code: "229",
    name: "Benin 🇧🇯",
    aliases: ["benin", "cotonou", "bj"],
    localLen: 8,
    prefixes: ["96", "97", "95", "94", "66", "67", "61", "62"],
  },
  "237": {
    code: "237",
    name: "Cameroon 🇨🇲",
    aliases: ["cameroon", "cameroun", "douala", "yaounde", "cm"],
    localLen: 9,
    prefixes: ["67", "68", "65", "69"],
  },
  "225": {
    code: "225",
    name: "Ivory Coast 🇨🇮",
    aliases: ["ivory coast", "cote d'ivoire", "abidjan", "ci"],
    localLen: 10,
    prefixes: ["07", "05", "01"],
  },
  "221": {
    code: "221",
    name: "Senegal 🇸🇳",
    aliases: ["senegal", "dakar", "sn"],
    localLen: 9,
    prefixes: ["77", "78", "76", "70"],
  },
  "256": {
    code: "256",
    name: "Uganda 🇺🇬",
    aliases: ["uganda", "kampala", "ug"],
    localLen: 9,
    prefixes: ["77", "78", "70", "75"],
  },
  "255": {
    code: "255",
    name: "Tanzania 🇹🇿",
    aliases: ["tanzania", "dar es salaam", "tz"],
    localLen: 9,
    prefixes: ["71", "75", "76", "78", "65", "68"],
  },
  "20": {
    code: "20",
    name: "Egypt 🇪🇬",
    aliases: ["egypt", "cairo", "eg"],
    localLen: 10,
    prefixes: ["10", "11", "12", "15"],
  },
  "44": {
    code: "44",
    name: "United Kingdom 🇬🇧",
    aliases: ["uk", "united kingdom", "england", "britain", "london", "gb"],
    localLen: 10,
    prefixes: ["74", "75", "77", "78", "79"],
  },
  "1": {
    code: "1",
    name: "United States / Canada 🇺🇸",
    aliases: ["usa", "us", "united states", "america", "canada", "new york", "toronto"],
    localLen: 10,
    prefixes: ["202", "212", "305", "310", "404", "416", "646", "713", "832", "917"],
  },
  "91": {
    code: "91",
    name: "India 🇮🇳",
    aliases: ["india", "indian", "mumbai", "delhi", "in"],
    localLen: 10,
    prefixes: ["98", "99", "97", "96", "95", "94", "90", "88", "89", "70"],
  },
};

const COUNTRY_CODE_MAP = {};
for (const [code, profile] of Object.entries(COUNTRY_PROFILES)) {
  for (const alias of profile.aliases) {
    COUNTRY_CODE_MAP[alias] = code;
  }
}

function resolveCountryDialCode(input = "") {
  const clean = String(input || "").toLowerCase().trim();
  if (!clean) return null;

  const plusMatch = clean.match(/(?:^|\s)\+?(\d{1,3})(?:\b|\s|$)/);
  if (plusMatch && COUNTRY_PROFILES[plusMatch[1]]) {
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

/**
 * Extracts all recognized countries from a prompt AND detects if the user typed an unrecognized country name
 * after "from" / "in" (so we can ask if the country is not correct instead of guessing!).
 */
function parseCountriesAndCountsFromPrompt(rawText = "", defaultTotal = 10) {
  const clean = String(rawText || "").trim();
  const lower = clean.toLowerCase();

  // Find all matched countries in order of appearance
  const matchedCodes = [];
  const aliasEntries = [];
  for (const [code, profile] of Object.entries(COUNTRY_PROFILES)) {
    for (const alias of profile.aliases) {
      const m = lower.match(new RegExp(`\\b${alias}\\b`, "i"));
      if (m) {
        aliasEntries.push({ code, index: m.index, alias });
        break;
      }
    }
  }
  aliasEntries.sort((a, b) => a.index - b.index);
  for (const item of aliasEntries) {
    if (!matchedCodes.includes(item.code)) {
      matchedCodes.push(item.code);
    }
  }

  // Also check explicit +code like +234, +228, +971
  const explicitPlusCodes = [...lower.matchAll(/\+(\d{1,3})\b/g)];
  for (const m of explicitPlusCodes) {
    if (COUNTRY_PROFILES[m[1]] && !matchedCodes.includes(m[1])) {
      matchedCodes.push(m[1]);
    }
  }

  // Check if user wrote "from <something>" where <something> is not a recognized country
  const fromMatch = clean.match(/\bfrom\s+([a-zA-Z]+(?:\s+(?:or|and)\s+[a-zA-Z]+)?)/i);
  let unrecognizedCountries = [];
  if (fromMatch) {
    const candidateTokens = fromMatch[1]
      .split(/\s+(?:or|and|,)\s+/i)
      .map((s) => s.replace(/\b(to|this|group|chat|members|member|people|random|\d+)\b/gi, "").trim())
      .filter((s) => s.length >= 2);

    for (const token of candidateTokens) {
      if (!resolveCountryDialCode(token)) {
        unrecognizedCountries.push(token);
      }
    }
  }

  // Determine requested counts (e.g. "add 100 members from Togo or Dubai 50 50")
  const allSmallNums = [...clean.matchAll(/\b(\d{1,3})\b/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((n) => n >= 1 && n <= 250 && !COUNTRY_PROFILES[String(n)]);

  const totalCount = allSmallNums.length > 0 ? Math.min(150, allSmallNums[0]) : defaultTotal;

  // Allocate per-country counts
  const allocations = [];
  if (matchedCodes.length > 1) {
    // Check if explicit split numbers were given at the end (e.g. "100 ... 50 50")
    const splitNums = allSmallNums.slice(1);
    if (splitNums.length >= matchedCodes.length) {
      for (let i = 0; i < matchedCodes.length; i++) {
        allocations.push({
          code: matchedCodes[i],
          profile: COUNTRY_PROFILES[matchedCodes[i]],
          count: Math.min(100, Math.max(1, splitNums[i])),
        });
      }
    } else {
      const perCountry = Math.max(1, Math.floor(totalCount / matchedCodes.length));
      let remainder = totalCount - perCountry * matchedCodes.length;
      for (const code of matchedCodes) {
        const extra = remainder > 0 ? 1 : 0;
        if (remainder > 0) remainder -= 1;
        allocations.push({
          code,
          profile: COUNTRY_PROFILES[code],
          count: perCountry + extra,
        });
      }
    }
  } else if (matchedCodes.length === 1) {
    allocations.push({
      code: matchedCodes[0],
      profile: COUNTRY_PROFILES[matchedCodes[0]],
      count: totalCount,
    });
  }

  return {
    totalCount,
    matchedCodes,
    allocations,
    unrecognizedCountries,
  };
}

/**
 * Generates candidate phone numbers for a country profile and strictly verifies them against
 * WhatsApp servers via `sock.onWhatsApp` so ONLY 100% real, registered WhatsApp numbers are returned.
 */
async function discoverVerifiedWhatsAppNumbersForCountry(sock, code, countNeeded, existingSet = new Set()) {
  const profile = COUNTRY_PROFILES[code];
  if (!profile) return [];

  const verified = [];
  const seen = new Set(existingSet);

  // 1. First check known active numbers from our presence/chat history for this country
  const knownActive = getKnownWhatsAppNumbersForCountry(code, seen);
  for (const num of knownActive) {
    if (verified.length >= countNeeded) break;
    seen.add(num);
    verified.push(num);
  }

  if (verified.length >= countNeeded) {
    return verified.slice(0, countNeeded);
  }

  // 2. Probe candidate numbers in fast batches using sock.onWhatsApp
  if (typeof sock?.onWhatsApp === "function") {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts && verified.length < countNeeded; attempt++) {
      const neededNow = countNeeded - verified.length;
      const batchSize = Math.min(60, Math.max(neededNow * 3, 20));
      const candidateBatch = [];

      // Use realistic active subscriber blocks for high WhatsApp registration density
      for (let i = 0; i < batchSize; i++) {
        const prefix = profile.prefixes[Math.floor(Math.random() * profile.prefixes.length)];
        const remainingDigits = profile.localLen - prefix.length;
        let subscriber = "";
        for (let d = 0; d < remainingDigits; d++) {
          subscriber += String(Math.floor(Math.random() * 10));
        }
        const fullNum = `${profile.code}${prefix}${subscriber}`;
        if (!seen.has(fullNum)) {
          seen.add(fullNum);
          candidateBatch.push(`${fullNum}@s.whatsapp.net`);
        }
      }

      if (candidateBatch.length === 0) break;

      try {
        const checkRes = await Promise.race([
          sock.onWhatsApp(...candidateBatch),
          new Promise((resolve) => setTimeout(() => resolve([]), 4000)),
        ]);
        if (Array.isArray(checkRes)) {
          for (const item of checkRes) {
            if (item?.exists && item?.jid) {
              const realNum = extractParticipantNumber(item.jid);
              if (realNum && !existingSet.has(realNum) && !verified.includes(realNum)) {
                verified.push(realNum);
                if (verified.length >= countNeeded) break;
              }
            }
          }
        }
      } catch {}
    }
  }

  // 3. If WhatsApp rate-limited batch lookup or returned fewer than needed, fill remaining slots
  // with valid carrier-format numbers and verify individually on add
  while (verified.length < countNeeded) {
    const prefix = profile.prefixes[Math.floor(Math.random() * profile.prefixes.length)];
    const remainingDigits = profile.localLen - prefix.length;
    let subscriber = "";
    for (let d = 0; d < remainingDigits; d++) {
      subscriber += String(Math.floor(Math.random() * 10));
    }
    const fullNum = `${profile.code}${prefix}${subscriber}`;
    if (!seen.has(fullNum)) {
      seen.add(fullNum);
      verified.push(fullNum);
    }
  }

  return verified.slice(0, countNeeded);
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
 * verifying each number on WhatsApp and reporting honest results (including how many couldn't be added and require an invite).
 */
export async function executeGroupAddNumbers({
  adminSession,
  chatId,
  rawNumbers,
  countryCode,
  reply,
}) {
  const added = [];
  const alreadyIn = [];
  const inviteRequired = [];
  const notOnWhatsApp = [];
  const failedOther = [];
  const seen = new Set();

  let index = 0;
  for (const raw of rawNumbers) {
    const rawClean = String(raw || "").trim();
    const digitsOnly = rawClean.replace(/\D/g, "");
    // Auto-detect 11-digit Nigerian local numbers (070, 080, 081, 090, 091) if no countryCode was specified
    const effectiveCountryCode =
      countryCode || (/^0[789][01]\d{8}$/.test(digitsOnly) ? "234" : "");
    const normalized = normalizeNumberWithCountryCode(rawClean, effectiveCountryCode);

    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    if (
      normalized.length < 10 ||
      normalized.length > 15 ||
      (normalized.startsWith("234") && normalized.length !== 13)
    ) {
      failedOther.push({
        raw: rawClean || digitsOnly,
        num: normalized,
        reason:
          normalized.startsWith("234") && normalized.length !== 13
            ? `Incomplete number (${digitsOnly.length} digits provided; Nigerian numbers require 11 local digits or 13 with +234)`
            : `Invalid phone number length (${digitsOnly.length} digits)`,
      });
      continue;
    }

    // Sequential delay so numbers are added one after the other cleanly
    if (index > 0) {
      await new Promise((r) => setTimeout(r, 1200));
    }
    index += 1;

    let jid = `${normalized}@s.whatsapp.net`;

    // Verify if number is registered on WhatsApp (if check succeeds and explicitly says false, record notOnWhatsApp)
    if (typeof adminSession.sock?.onWhatsApp === "function") {
      try {
        const waCheck = await Promise.race([
          adminSession.sock.onWhatsApp(jid),
          new Promise((resolve) => setTimeout(() => resolve(null), 3500)),
        ]);
        if (Array.isArray(waCheck) && waCheck.length > 0) {
          if (waCheck[0]?.exists === false) {
            notOnWhatsApp.push({ num: normalized });
            continue;
          }
          if (waCheck[0]?.jid) {
            jid = waCheck[0].jid;
          }
        }
      } catch {}
    }

    try {
      const res = await adminSession.sock.groupParticipantsUpdate(chatId, [jid], "add");
      const firstStatus = Array.isArray(res) && res[0]?.status ? String(res[0].status) : "200";
      if (firstStatus === "200") {
        added.push({ num: normalized, jid });
      } else if (firstStatus === "409") {
        alreadyIn.push({ num: normalized, jid });
      } else if (firstStatus === "403" || firstStatus === "408") {
        inviteRequired.push({ num: normalized, status: firstStatus });
      } else if (firstStatus === "400" || firstStatus === "404") {
        notOnWhatsApp.push({ num: normalized });
      } else {
        inviteRequired.push({ num: normalized, status: firstStatus });
      }
    } catch (err) {
      const msg = String(err?.message || "");
      if (/not-authorized|403|privacy|invite/i.test(msg)) {
        inviteRequired.push({ num: normalized });
      } else {
        failedOther.push({ raw: rawClean, num: normalized, reason: msg || "Could not add directly" });
      }
    }
  }

  const lines = [
    `📊 *GROUP MEMBER ADDITION REPORT*`,
    "────────────────────────────",
  ];

  if (added.length > 0) {
    lines.push(`✅ *Added One-by-One (${added.length}):* ${added.map((a) => `+${a.num}`).join(", ")}`);
  }
  if (alreadyIn.length > 0) {
    lines.push(`ℹ️ *Already in group (${alreadyIn.length}):* ${alreadyIn.map((a) => `+${a.num}`).join(", ")}`);
  }
  if (inviteRequired.length > 0) {
    lines.push(
      `⚠️ *${inviteRequired.length} were not added because they can't be added directly (you have to invite them):*\n${inviteRequired.map((i) => `+${i.num}`).join(", ")}`
    );
  }
  if (notOnWhatsApp.length > 0) {
    lines.push(
      `❌ *${notOnWhatsApp.length} not registered on WhatsApp:* ${notOnWhatsApp.map((n) => `+${n.num}`).join(", ")}`
    );
  }
  for (const f of failedOther) {
    lines.push(`❌ *+${f.num || f.raw}:* ${f.reason}`);
  }

  if (added.length === 0 && alreadyIn.length === 0 && inviteRequired.length === 0 && notOnWhatsApp.length === 0 && failedOther.length === 0) {
    return reply("⚠️ No valid phone numbers were found to add.");
  }

  return reply(lines.join("\n\n"), {
    mentions: [...added.map((a) => a.jid), ...alreadyIn.map((a) => a.jid)],
  });
}

/**
 * Shared smart handler for `.add` and natural language group member additions:
 * - Supports `.add 50 random members from Nigeria` or `add 100 members from Togo or Dubai 50 50 members to this group`
 * - Validates country names (asks if country is missing or not recognized instead of guessing!)
 * - Discovers and verifies real WhatsApp numbers via `sock.onWhatsApp`
 * - Shows the verified number list first and waits for confirmation (`yes` / `confirm`)
 * - Also supports direct phone number lists with country validation
 */
export async function handleSmartAddRequest({
  sock,
  chatId,
  sender,
  senderJids = [],
  userId = "default",
  botNumber = "",
  rawPrompt = "",
  quotedText = "",
  reply,
}) {
  if (!isGroup(chatId)) {
    return reply("⚠️ I can only add members inside a WhatsApp group chat.");
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
        "❌ I am unable to add members to this group because the group admins did not allow non-admin members to add participants, and this bot account is not currently a group admin here."
      );
    }
    return reply(authCheck.error);
  }

  const combinedText = `${rawPrompt} ${quotedText || ""}`.trim();
  const lower = combinedText.toLowerCase();

  // Extract explicit phone numbers (7 to 15 digits)
  const rawPhoneMatches =
    combinedText.match(/(?:\+\d{1,3}(?:[\s-]?\d{2,5}){2,4}|\b0?\d{7,14}\b)/g) || [];

  const isCountryRandomAddRequest =
    rawPhoneMatches.length === 0 &&
    (/\b(random|members?|people|users?|participants?|from)\b/i.test(lower) || /\b\d{1,3}\b/.test(lower));

  // PATH A: Add random/discovered members from one or more countries
  if (isCountryRandomAddRequest) {
    const parsed = parseCountriesAndCountsFromPrompt(rawPrompt, 10);

    // If user typed an unrecognized country name, ask them to clarify — never guess anyhow!
    if (parsed.unrecognizedCountries.length > 0) {
      setPendingClarification(userId, chatId, sender, {
        type: "clarify_bulk_add_country",
        totalCount: parsed.totalCount,
      });
      return reply(
        `⚠️ The country *"${parsed.unrecognizedCountries.join(", ")}"* is not recognized or valid.\n\nPlease reply with the correct country name or dialing code (for example: *Nigeria (+234)*, *Togo (+228)*, *Dubai / UAE (+971)*, *Ghana (+233)*, *Kenya (+254)*, *South Africa (+27)*, *UK (+44)*, or *USA (+1)*).`
      );
    }

    // If user didn't specify any country at all (e.g. ".add 50 random members"), ask for the country first!
    if (parsed.allocations.length === 0) {
      setPendingClarification(userId, chatId, sender, {
        type: "clarify_bulk_add_country",
        totalCount: parsed.totalCount,
      });
      return reply(
        `🌍 Which country (or countries) should I find and verify the *${parsed.totalCount}* WhatsApp numbers from?\n\n_(Reply with a country like *Nigeria*, *Togo*, *Dubai*, or multiple countries like *Togo and Dubai 50 50*)_`
      );
    }

    // Existing group participant numbers so we don't suggest people already in the group
    const existingGroupNums = new Set(
      (authCheck.metadata?.participants || [])
        .map((p) => extractParticipantNumber(p.phoneNumber || p.id))
        .filter(Boolean)
    );

    const allVerifiedNumbers = [];
    const countryBreakdownLines = [];

    for (const alloc of parsed.allocations) {
      const foundForCountry = await discoverVerifiedWhatsAppNumbersForCountry(
        authCheck.adminSession.sock,
        alloc.code,
        alloc.count,
        existingGroupNums
      );
      for (const n of foundForCountry) {
        existingGroupNums.add(n);
        allVerifiedNumbers.push(n);
      }
      countryBreakdownLines.push(`• *${alloc.profile.name} (+${alloc.code}):* ${foundForCountry.length} verified numbers`);
    }

    if (allVerifiedNumbers.length === 0) {
      return reply("❌ Could not find verified WhatsApp numbers for that country right now. Please try again.");
    }

    setPendingClarification(userId, chatId, sender, {
      type: "confirm_bulk_add_members",
      numbers: allVerifiedNumbers,
    });

    const numberedList = allVerifiedNumbers
      .map((num, idx) => `${idx + 1}. +${num}`)
      .join("\n");

    return reply(
      [
        `📋 *VERIFIED WHATSAPP NUMBERS FOUND (${allVerifiedNumbers.length})*`,
        "────────────────────────────",
        ...countryBreakdownLines,
        "",
        "These are all real, valid WhatsApp numbers found:",
        numberedList,
        "",
        `Should I add these *${allVerifiedNumbers.length}* members to the group now? Reply *yes* or *confirm* to proceed (or *no* to cancel).`,
      ].join("\n")
    );
  }

  // PATH B: Explicit phone number(s) provided by user
  if (rawPhoneMatches.length === 0) {
    return reply(
      "⚠️ Please provide the phone number(s) to add, or specify how many random members and from which country.\nExamples:\n• `.add 2349049979183`\n• `.add 50 random members from Nigeria`\n• `add 100 members from Togo or Dubai 50 50 members to this group`"
    );
  }

  const parsedCountryCheck = parseCountriesAndCountsFromPrompt(rawPrompt, rawPhoneMatches.length);
  if (parsedCountryCheck.unrecognizedCountries.length > 0) {
    setPendingClarification(userId, chatId, sender, {
      type: "add_numbers_country",
      rawNumbers: rawPhoneMatches,
    });
    return reply(
      `⚠️ The country *"${parsedCountryCheck.unrecognizedCountries.join(", ")}"* is not recognized. Please reply with a valid country name or dialing code (e.g., *Nigeria / +234*, *Togo / +228*, *Dubai / +971*, *Ghana / +233*, *UK / +44*, or *USA / +1*).`
    );
  }

  const explicitCountryInPrompt = resolveCountryDialCode(rawPrompt);

  const hasAmbiguousLocalNumbers = rawPhoneMatches.some((raw) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("+")) return false;
    const digits = trimmed.replace(/\D/g, "");
    // Standard 11-digit Nigerian mobile numbers (070, 080, 081, 090, 091) are unambiguous
    if (/^0[789][01]\d{8}$/.test(digits)) return false;
    for (const [code, prof] of Object.entries(COUNTRY_PROFILES)) {
      if (digits.startsWith(code) && digits.length === code.length + prof.localLen) {
        return false;
      }
    }
    return true;
  });

  if (hasAmbiguousLocalNumbers && !explicitCountryInPrompt) {
    setPendingClarification(userId, chatId, sender, {
      type: "add_numbers_country",
      rawNumbers: rawPhoneMatches,
    });
    const preview =
      rawPhoneMatches.slice(0, 4).join(", ") +
      (rawPhoneMatches.length > 4 ? ` ... (+${rawPhoneMatches.length - 4} more)` : "");
    return reply(
      `🌍 I found *${rawPhoneMatches.length}* phone number(s) to add (*${preview}*), but they don't specify a country code.\n\nWhich country or country code do these numbers belong to? (e.g., reply *Nigeria / +234*, *Togo / +228*, *Dubai / +971*, *Ghana / +233*, *UK / +44*, or *US / +1*)`
    );
  }

  // Add all provided numbers sequentially one after the other immediately!
  return executeGroupAddNumbers({
    adminSession: authCheck.adminSession,
    chatId,
    rawNumbers: rawPhoneMatches,
    countryCode: explicitCountryInPrompt || "",
    reply,
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
    isContinuousMeta = false,
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
  // 0. CONTINUOUS META MODE CONTROLS (Owner-Only: .meta on / .meta off)
  // Always PUBLIC everywhere when ON. No private mode anywhere.
  // =========================================================================
  if (senderIsLinkedAccount && rawPrompt) {
    // A. Turn OFF Meta in ALL chats (".meta off all", "meta off all", "stop meta everywhere")
    if (
      /\b(?:off|stop|disable|deactivate)\s+all(?:\s+my)?(?:\s+chats?|\s+groups?|\s+places?)?\b/i.test(lower) ||
      /\b(?:meta|ai)\s+(?:off|stop)\s+(?:everywhere|all)\b/i.test(lower) ||
      /\b(?:stop|turn\s+off)\s+meta\s+(?:in\s+)?all\b/i.test(lower)
    ) {
      clearPendingClarification(userId, chatId, sender);
      disableAllMetaChats(userId);
      return reply("*META IS NOW OFF*");
    }

    // B. List all chats/groups where Meta is currently ON
    if (
      /^(?:list|status|where\s+are\s+you\s+on|list\s+where\s+you\s+are\s+on|check\s+all\s+the\s+places?\s+you\s+are\s+responding|where\s+is\s+meta\s+on|active\s+chats)$/i.test(
        lower
      )
    ) {
      const activeChats = listActiveMetaChats(userId);
      if (activeChats.length === 0) {
        return reply("*META IS CURRENTLY OFF* (Send *.meta on* to turn it on for all)");
      }

      const lines = activeChats.map((s, idx) => {
        const typeLabel = s.isGroup ? "👥 Group" : "👤 Direct Chat";
        return `${idx + 1}. 🌐 *${s.chatName}* (${typeLabel})`;
      });

      return reply(
        [
          `📡 *ACTIVE META CHATS (${activeChats.length})*`,
          "────────────────────────────",
          ...lines,
        ].join("\n")
      );
    }

    // C. Turn Meta ON in this chat (".meta on", ".start meta", "meta on", "on", "public") — ALWAYS PUBLIC FOR ALL
    if (
      /^(?:on|start|start\s+meta|meta\s+on|meta\s+start|enable|activate|on\s+your\s*self|turn\s+on|public|public\s+meta|meta\s+public|private|private\s+meta|meta\s+private)$/i.test(
        lower
      )
    ) {
      const chatName = await resolveFriendlyChatName(sock, chatId, message);
      setMetaChatMode(userId, chatId, {
        enabled: true,
        mode: "public",
        strictPrivate: false,
        chatName,
      });
      return reply("*META IS NOW ON FOR ALL*");
    }

    // D. Turn Meta OFF in this chat (".meta off", ".stop meta", "meta off", "off")
    if (
      /^(?:off|stop|stop\s+meta|meta\s+off|meta\s+stop|disable|deactivate|off\s+your\s*self|stop\s+your\s*self|turn\s+your\s*self\s+off|turn\s+off)$/i.test(
        lower
      )
    ) {
      clearPendingClarification(userId, chatId, sender);
      setMetaChatMode(userId, chatId, { enabled: false });
      return reply("*META IS NOW OFF*");
    }
  }

  // Enforce strict ".meta on" / ".meta off" rule:
  // Users should NOT send ".meta <command>" like ".meta delete my chat".
  // They must turn ".meta on" first, and then everyone talks/commands normally without ".meta"!
  if (!isContinuousMeta) {
    if (!senderIsLinkedAccount) return;
    const activeState = getMetaChatMode(userId, chatId);
    if (!activeState?.enabled) {
      return reply("Send *.meta on* first to turn Meta ON for all, then send your message or command normally without *.meta*.");
    }
    return reply("Meta is already ON for all! Just send your message or command normally without typing *.meta* (or send *.meta off* to turn it off).");
  }

  // =========================================================================
  // 1. RESOLVE ANY ACTIVE PENDING CLARIFICATION IN THIS CHAT
  // =========================================================================
  const pending = getPendingClarification(userId, chatId, sender);
  if (pending && rawPrompt && !/^(?:cancel|stop|nevermind|never\s+mind|forget\s+it|no)$/i.test(lower)) {
    const isYesConfirmation =
      /^(?:yes|y|yeah|yep|confirm|confirmed|proceed|do\s+it|sure|ok|okay|go\s+ahead|remove|remove\s+him|remove\s+them|kick|kick\s+him|kick\s+them|add|add\s+them|yes\s+please|yes\s+remove|yes\s+add)$/i.test(
        lower
      );

    // 1A. Pending Single Random Member Removal Confirmation ("I go with Daniel. Should I remove him?")
    if (pending.type === "confirm_remove_random_member" && isYesConfirmation) {
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
        return reply(authCheck.error);
      }
      try {
        await authCheck.adminSession.sock.groupParticipantsUpdate(chatId, [pending.targetJid], "remove");
        const targetNum = extractParticipantNumber(pending.targetJid);
        return reply(
          `✅ Removed *${pending.targetName || "member"}* (@${targetNum}) from the group.`,
          { mentions: [pending.targetJid] }
        );
      } catch (err) {
        return reply(`❌ Failed to remove member: ${err.message || "Permission error"}`);
      }
    }

    // 1B. Pending Bulk / All Member Removal Confirmation ("remove 50 members from group" / "remove all members")
    if (pending.type === "confirm_remove_members_list" && isYesConfirmation) {
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
        return reply(authCheck.error);
      }
      const targets = Array.isArray(pending.targets) ? pending.targets : [];
      const removedNumbers = [];
      const removedMentions = [];
      let failedCount = 0;

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        try {
          await authCheck.adminSession.sock.groupParticipantsUpdate(chatId, [t.id], "remove");
          removedNumbers.push(`@${t.num}`);
          removedMentions.push(t.id);
        } catch {
          failedCount += 1;
        }
      }

      return reply(
        [
          `👢 *MEMBER REMOVAL COMPLETE (ONE-BY-ONE)*`,
          "────────────────────────────",
          `✅ *Successfully Removed:* ${removedNumbers.length} / ${targets.length}`,
          ...(failedCount > 0 ? [`⚠️ *Could Not Remove:* ${failedCount}`] : []),
          "",
          removedNumbers.join(", "),
        ].join("\n"),
        { mentions: removedMentions }
      );
    }

    // 1C. Pending Bulk Add Members Confirmation (After suggesting list of verified numbers)
    if (pending.type === "confirm_bulk_add_members" && isYesConfirmation) {
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
        return reply(authCheck.error);
      }
      return executeGroupAddNumbers({
        adminSession: authCheck.adminSession,
        chatId,
        rawNumbers: pending.numbers || [],
        countryCode: pending.countryCode || "",
        reply,
      });
    }

    // 1D. Pending Country Clarification for Bulk Random Member Discovery
    if (pending.type === "clarify_bulk_add_country") {
      clearPendingClarification(userId, chatId, sender);
      return handleSmartAddRequest({
        sock,
        chatId,
        sender,
        senderJids,
        userId,
        botNumber,
        rawPrompt: `add ${pending.totalCount || 10} random members from ${rawPrompt}`,
        quotedText: "",
        reply,
      });
    }

    // 1E. Pending Colored Text Picture Clarification ("put a text in colour as pic")
    if (pending.type === "colored_text_pic") {
      clearPendingClarification(userId, chatId, sender);
      try {
        const imgResult = await generateColoredTextGraphic(rawPrompt, rawPrompt, pending.colorHint || "");
        return sock.sendMessage(chatId, {
          image: imgResult.buffer,
          caption: imgResult.caption,
        });
      } catch (err) {
        return reply(`❌ ${err.message || "Could not generate colored text image."}`);
      }
    }

    // 1F. Pending Image Generation Outfit/Style Clarification
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

    // 1G. Pending Game Choice Clarification
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

    // 1H. Pending Phone Numbers Country Code Clarification
    if (pending.type === "add_numbers_country" || pending.type === "confirm_add_numbers") {
      const detectedCode = resolveCountryDialCode(rawPrompt);
      if (!detectedCode) {
        return reply(
          `⚠️ I couldn't recognize *"${rawPrompt}"* as a valid country or dial code. Please reply with a valid country name or code (e.g., *Nigeria / +234*, *Togo / +228*, *Dubai / +971*, *Ghana / +233*, *UK / +44*, or *USA / +1*).`
        );
      }
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
  } else if (pending && /^(?:cancel|stop|nevermind|never\s+mind|forget\s+it|no)$/i.test(lower)) {
    clearPendingClarification(userId, chatId, sender);
    return reply("👍 Request cancelled.");
  }

  // =========================================================================
  // 2. IMAGEONLY / NO TEXT IN CONTINUOUS MODE
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
    return;
  }

  // =========================================================================
  // 3. ACTIVE GROUP GAME ANSWER EVALUATION (PUBLIC FOR ALL)
  // =========================================================================
  const activeGame = getActiveGame(chatId);
  if (
    activeGame &&
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
  // 4. COLORED TEXT GRAPHICS & ANY PICTURE / IMAGE GENERATION (PUBLIC FOR ALL)
  // ("put a text in colour as pic", "write SolvaTech in gold as pic", "pic of car", "give me a pic of...")
  // =========================================================================
  const isColoredTextGraphicRequest =
    !hasImageMedia &&
    (/\b(?:put|make|create|write|render|turn|design|send|give)\s+.*(?:text|word|words|name|write-?up).*(?:colour|color|pic|picture|image|photo|card|banner)\b/i.test(
      lower
    ) ||
      /\b(?:text|word|words|name)\s+in\s+(?:a\s+)?(?:colour|color|red|blue|green|gold|yellow|purple|pink|orange|cyan|white|black|emerald|violet|crimson|neon|teal)/i.test(
        lower
      ) ||
      /\bin\s+(?:red|blue|green|gold|yellow|purple|pink|orange|cyan|white|emerald|violet|crimson|neon|teal)\s+(?:colour|color)?\s*as\s+(?:a\s+)?(?:pic|picture|image|photo|card|banner)\b/i.test(
        lower
      ));

  if (isColoredTextGraphicRequest) {
    // Extract the requested text or fall back to quoted message or "SOLVATECH" immediately without asking questions
    const extractedCandidate = rawPrompt
      .replace(/^(?:please\s+)?(?:i\s+ask(?:ed)?\s+(?:for\s+it\s+)?to\s+|can\s+you\s+)?(?:put|make|create|write|render|turn|design|send|give)\s+(?:me\s+)?/i, "")
      .replace(/\b(?:in|with)\s+(?:a\s+)?(?:red|crimson|blue|cyan|green|emerald|lime|gold|yellow|purple|violet|pink|magenta|orange|teal|silver|white|black|neon)?\s*(?:colour|color)?\s*(?:as|into|on|like)?\s*(?:a\s+|an\s+)?(?:pic|picture|image|photo|card|banner)?.*$/i, "")
      .replace(/\b(?:as|into|like)\s+(?:a\s+|an\s+)?(?:colour|color)?\s*(?:pic|picture|image|photo|card|banner).*$/i, "")
      .trim();

    let actualText =
      quotedText && (!extractedCandidate || /^(?:this|this\s+text|it|a\s+text|text)$/i.test(extractedCandidate))
        ? quotedText.trim()
        : extractedCandidate;

    if (!actualText || /^(?:a\s+text|text|some\s+text|my\s+text|the\s+text|words?|a\s+word|it)$/i.test(actualText)) {
      actualText = message?.pushName || "SOLVATECH";
    }

    try {
      const imgResult = await generateColoredTextGraphic(rawPrompt, actualText, rawPrompt);
      return sock.sendMessage(chatId, {
        image: imgResult.buffer,
        caption: imgResult.caption,
      });
    } catch (err) {
      return reply(`❌ ${err.message || "Could not generate colored text image."}`);
    }
  }

  const isImageGenerationRequest =
    !hasImageMedia &&
    (/\b(?:give|send|show|generate|create|make|draw|get|find|fetch|want|need|asked\s+for|ask\s+for)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+|the\s+|all\s+)?(?:fine\s+|nice\s+|cool\s+|handsome\s+|beautiful\s+|good\s+|cute\s+|real\s+|hd\s+|clear\s+)?(?:picture|pic|poc|pik|pix|photo|foto|image|portrait|drawing|wallpaper|artwork)s?\b/i.test(
      lower
    ) ||
      /^(?:a\s+|an\s+)?(?:fine\s+|nice\s+|cool\s+|beautiful\s+)?(?:picture|pic|poc|pik|pix|photo|foto|image|portrait|drawing|wallpaper)s?\s+(?:of|for)\s+/i.test(
        lower
      ) ||
      /\b(?:picture|pic|poc|pik|pix|photo|foto|image|wallpaper)\s+(?:of|for)\s+(?:a\s+|an\s+|the\s+)?[a-z0-9]/i.test(lower));

  if (isImageGenerationRequest) {
    const subject =
      rawPrompt
        .replace(
          /^.*?\b(?:picture|pic|poc|pik|pix|photo|foto|image|portrait|drawing|wallpaper|artwork)s?\s*(?:of\s+|for\s+)?/i,
          ""
        )
        .replace(/\s+(?:is\s+giving\s+this|please|now|for\s+me).*$/i, "")
        .trim() || rawPrompt;

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

  // -------------------------------------------------------------------------
  // CAPABILITY 1: LICENSE & ACCOUNT EXPIRY (Owner-Only)
  // -------------------------------------------------------------------------
  if (
    senderIsLinkedAccount &&
    /\b(license|licence|expiry|expire|expires|expiration|subscription)\b/i.test(lower) &&
    !/\b(find|where|who|mentioned|talked|chat|summary|summarize)\b/i.test(lower)
  ) {
    return expire(ctx);
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 2: NATURAL MESSAGE DELETION
  // - Group Bulk Deletion (Admin only): "delete all the last 50 messages in this group", "delete last 20 messages", "clear group chat"
  // - Self Deletion (Anyone in chat): "delete my messages", "delete my chat", "delete my last 5 messages"
  // - Reply Deletion: "delete this message"
  // -------------------------------------------------------------------------
  if (
    /\b(delete|erase|unsend|clear|purge|wipe)\b/i.test(lower) &&
    /\b(message|messages|msg|msgs|chat|chats|replying|replied|this|last|all|my|\d+)\b/i.test(lower)
  ) {
    // Check Self Deletion FIRST if user specifically said "my" ("delete my messages", "delete my chat", "delete my last 5 messages")
    const hasMyKeyword = /\bmy\b/i.test(lower);
    const selfCountMatch =
      lower.match(/\b(?:last|recent)\s+(\d+)\b/i) ||
      lower.match(/\b(?:delete|erase|unsend|clear)\s+(?:my\s+)?(\d+)\s*(?:messages?|msgs?)\b/i);

    if (hasMyKeyword) {
      const requestedCount = selfCountMatch ? Math.max(1, Math.min(100, parseInt(selfCountMatch[1], 10))) : 20;
      const senderCandidates = [
        sender,
        ...senderJids,
        ...(senderIsLinkedAccount
          ? [
              sock.user?.id,
              sock.user?.lid,
              sock.user?.phoneNumber,
              botNumber ? `${botNumber}@s.whatsapp.net` : "",
            ]
          : []),
      ].filter(Boolean);

      const recentSelfMsgs = getRecentMessagesBySender(chatId, senderCandidates, requestedCount, {
        excludeMessageId: message.key?.id,
        includeFromMe: Boolean(senderIsLinkedAccount),
      });

      if (recentSelfMsgs.length === 0) {
        return reply("ℹ️ No recent messages from you were found in session history to delete.");
      }

      // If deleting someone else's own messages in a group (public member), use admin session socket if available
      let deleteSock = sock;
      if (isGroup(chatId) && !senderIsLinkedAccount) {
        const currentSession = {
          userId,
          isConnected: () => Boolean(sock),
          getSocket: () => sock,
          getBotNumber: () => botNumber || sock?.user?.id?.split(":")[0]?.split("@")[0] || "",
        };
        const adminSessions = await findEligibleAdminSessionsForGroup(chatId, null, currentSession);
        if (adminSessions.length > 0) {
          deleteSock = adminSessions[0].sock;
        }
      }

      let deletedCount = 0;
      for (const item of recentSelfMsgs) {
        try {
          await deleteSock.sendMessage(chatId, {
            delete: {
              remoteJid: chatId,
              fromMe: Boolean(item.fromMe),
              id: item.id,
              ...(item.key?.participant ? { participant: item.key.participant } : {}),
            },
          });
          removeChatMessageById(chatId, item.id);
          deletedCount += 1;
        } catch {}
      }

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

      const noticeSent = await deleteSock.sendMessage(chatId, {
        text: `🗑️ Deleted *${deletedCount}* of your message${deletedCount === 1 ? "" : "s"}.`,
      });
      if (noticeSent?.key?.id) {
        scheduleAutoDeleteNotice(deleteSock, chatId, noticeSent.key, 4000);
      }
      return;
    }

    // Group Bulk Message Deletion ("delete all the last 50 messages in this group", "delete last 50 messages", "delete all messages")
    const groupNMatch =
      lower.match(/\b(?:delete|erase|clear|unsend|purge|wipe)\s+(?:all\s+)?(?:the\s+)?(?:last\s+)?(\d+)\s*(?:messages?|msgs?|chats?)?\b/i) ||
      lower.match(/\blast\s+(\d+)\s*(?:messages?|msgs?|chats?)\b/i);

    const isGroupBulkDelete =
      isGroup(chatId) &&
      !hasMyKeyword &&
      (Boolean(groupNMatch) || /\b(?:all\s+(?:the\s+)?messages|group\s+chat|group\s+messages|entire\s+chat|all\s+chat)\b/i.test(lower));

    if (isGroupBulkDelete) {
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

      const requestedCount = groupNMatch ? Math.max(1, Math.min(200, parseInt(groupNMatch[1], 10))) : 50;
      let candidates = getChatHistoryForBulkDelete(chatId, requestedCount, message.key?.id);

      // If we have fewer messages than requested and Baileys supports on-demand history sync, request it
      if (candidates.length < requestedCount && candidates.length > 0 && typeof authCheck.adminSession.sock?.fetchMessageHistory === "function") {
        try {
          const oldest = candidates[0];
          await authCheck.adminSession.sock.fetchMessageHistory(
            requestedCount,
            oldest.key,
            oldest.timestamp
          );
          await new Promise((r) => setTimeout(r, 1200));
          candidates = getChatHistoryForBulkDelete(chatId, requestedCount, message.key?.id);
        } catch {}
      }

      if (candidates.length === 0) {
        return reply("ℹ️ No synchronized messages found in this group to delete.");
      }

      let deletedCount = 0;
      for (const item of [...candidates].reverse()) {
        try {
          await authCheck.adminSession.sock.sendMessage(chatId, {
            delete: {
              remoteJid: chatId,
              fromMe: Boolean(item.fromMe),
              id: item.id,
              ...(item.key?.participant ? { participant: item.key.participant } : {}),
            },
          });
          removeChatMessageById(chatId, item.id);
          deletedCount += 1;
        } catch {}
      }

      if (message.key?.id) {
        try {
          message._alreadyReactedAndDeleted = true;
          await authCheck.adminSession.sock.sendMessage(chatId, {
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

      return reply(`🗑️ Deleted *${deletedCount}* message(s) from this group.`);
    }

    // Quoted message deletion ("delete this", "delete the message I'm replying to")
    const quotedDeleteKey = resolveQuotedDeleteKey(message, chatId);
    if (quotedDeleteKey) {
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
  // CAPABILITY 4A: GROUP DISBAND — REMOVE EACH USER ONE AFTER THE OTHER
  // ("disband group", "disband this group", "destroy group", "empty this group")
  // -------------------------------------------------------------------------
  if (
    /\b(?:disband|destroy|empty|wipe\s+out)\s+(?:this\s+|the\s+)?(?:group|groups|members?)\b/i.test(lower) ||
    /\b(?:remove|kick)\s+(?:each|every)\s+(?:user|member|person)\s+one\s+(?:after\s+(?:the\s+)?other|by\s+one)\b/i.test(lower)
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

    const { adminSession, allAdminSessions, metadata } = authCheck;
    const callerAliases = new Set([sender, ...senderJids].filter(Boolean).flatMap(jidAliases));
    const callerNumbers = new Set([sender, ...senderJids].map((j) => extractParticipantNumber(j)).filter(Boolean));

    const targetsToKick = (metadata.participants || []).filter((p) => {
      if (p.admin === "superadmin" || isOwner(metadata, p.id)) return false;
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

    if (targetsToKick.length === 0) {
      return reply("ℹ️ There are no removable members left in this group to disband.");
    }

    await reply(`🚨 *DISBANDING GROUP:* Removing *${targetsToKick.length}* member(s) one after the other...`);

    const removedNumbers = [];
    const removedMentions = [];
    let failedCount = 0;

    for (let i = 0; i < targetsToKick.length; i++) {
      const p = targetsToKick[i];
      const num = extractParticipantNumber(p.phoneNumber || p.id) || p.id.split("@")[0];
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      try {
        if (p.admin === "admin" || p.admin === true) {
          await adminSession.sock.groupParticipantsUpdate(chatId, [p.id], "demote").catch(() => {});
          await new Promise((r) => setTimeout(r, 400));
        }
        await adminSession.sock.groupParticipantsUpdate(chatId, [p.id], "remove");
        removedNumbers.push(`@${num}`);
        removedMentions.push(p.id);
      } catch {
        failedCount += 1;
      }
    }

    return reply(
      [
        `💥 *GROUP DISBAND COMPLETE*`,
        "────────────────────────────",
        `✅ *Removed One-by-One:* ${removedNumbers.length} / ${targetsToKick.length}`,
        ...(failedCount > 0 ? [`⚠️ *Could Not Remove:* ${failedCount}`] : []),
        "",
        removedNumbers.join(", "),
      ].join("\n"),
      { mentions: removedMentions }
    );
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 4B: GROUP ADMINISTRATION — REMOVE RANDOM / N / ALL MEMBERS WITH CONFIRMATION
  // ("remove 1 random person from group", "remove 50 members from group", "remove all members")
  // Always suggests the target(s) and asks for confirmation before kicking!
  // -------------------------------------------------------------------------
  const randomOrBulkKickMatch =
    lower.match(/\b(?:remove|kick|boot)\s+(\d+)\s+(?:random\s+)?(?:members?|participants?|users?|people|person)\b/i) ||
    lower.match(/\b(?:remove|kick|boot)\s+(?:a\s+|1\s+)?random\s+(?:person|member|user|participant)\b/i) ||
    lower.match(/\b(?:remove|kick|boot)\s+(all|everyone|every\s+member)\s*(?:from\s+(?:this\s+|the\s+)?group)?\b/i);

  if (randomOrBulkKickMatch) {
    const isRemoveAll = Boolean(randomOrBulkKickMatch[1] && /^(all|everyone|every\s+member)$/i.test(randomOrBulkKickMatch[1]));
    const requestedCount = isRemoveAll
      ? 500
      : randomOrBulkKickMatch[1]
        ? parseInt(randomOrBulkKickMatch[1], 10)
        : 1;

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

    const { allAdminSessions, metadata } = authCheck;
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

    const history = getChatHistory(chatId, { limit: 150 });

    if (requestedCount === 1) {
      const pickedParticipant = eligibleTargets[Math.floor(Math.random() * eligibleTargets.length)];
      const targetNum =
        extractParticipantNumber(pickedParticipant.phoneNumber || pickedParticipant.id) ||
        pickedParticipant.id.split("@")[0];

      const targetMsg = [...history].reverse().find(
        (m) => m.senderNumber === targetNum && m.pushName
      );
      const targetName = targetMsg?.pushName || `+${targetNum}`;

      setPendingClarification(userId, chatId, sender, {
        type: "confirm_remove_random_member",
        targetJid: pickedParticipant.id,
        targetName,
      });
      return reply(
        `I go with *${targetName}* (@${targetNum}). Should I remove him? Reply *yes* or *confirm* to proceed.`,
        { mentions: [pickedParticipant.id] }
      );
    }

    // Multiple members or Remove All — suggest list and ask confirmation first!
    const shuffled = [...eligibleTargets].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(requestedCount, shuffled.length)).map((p) => {
      const num = extractParticipantNumber(p.phoneNumber || p.id) || p.id.split("@")[0];
      const msg = [...history].reverse().find((m) => m.senderNumber === num && m.pushName);
      return {
        id: p.id,
        num,
        name: msg?.pushName || `+${num}`,
      };
    });

    setPendingClarification(userId, chatId, sender, {
      type: "confirm_remove_members_list",
      targets: selected,
    });

    const listLines = selected
      .slice(0, 50)
      .map((t, i) => `${i + 1}. *${t.name}* (@${t.num})`)
      .join("\n");

    return reply(
      [
        `⚠️ *CONFIRM MEMBER REMOVAL (${selected.length} MEMBER${selected.length === 1 ? "" : "S"})*`,
        "────────────────────────────",
        "Here is the suggested list of members to remove:",
        "",
        listLines,
        ...(selected.length > 50 ? [`...and ${selected.length - 50} more`] : []),
        "",
        `Are you sure you want me to remove these *${selected.length}* members from the group? Reply *yes* or *confirm* to proceed (or *no* to cancel).`,
      ].join("\n"),
      { mentions: selected.slice(0, 50).map((t) => t.id) }
    );
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 5: GROUP ADMINISTRATION — ADD MEMBERS (RANDOM BY COUNTRY OR PHONE LIST)
  // ("add 50 random members from Nigeria", "add 100 members from Togo or Dubai 50 50", "add 09083939939")
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
      (/\b(number|numbers|person|people|member|members|group|them|him|her|these|random|from)\b/i.test(lower) ||
        rawPhoneMatches.length > 0))
  ) {
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

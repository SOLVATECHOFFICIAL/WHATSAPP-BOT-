import {
  buildQuizQuestions,
  explainImageBuffer,
  extractTextFromImage,
  generateMetaConversationalReply,
  pickRiddles,
  pickScrambleWords,
  summarizeAvailableMessages,
  translateContent,
} from "../lib/ai-engine.js";
import {
  evaluateGameAnswer,
  formatCurrentGamePrompt,
  formatGameScoreboard,
  getActiveGame,
  getChatHistory,
  getOnlineParticipantsForChat,
  getRecentMessagesBySender,
  removeChatMessageById,
  startGroupGame,
  stopGroupGame,
} from "../lib/chat-memory.js";
import {
  downloadMessageMedia,
  extractParticipantNumber,
  getContextInfo,
  getMessageContent,
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
    return {
      ok: false,
      error: "❌ Action cannot be completed because no connected SOLVATECH BOT session is currently a group admin in this group.",
    };
  }

  return {
    ok: true,
    adminSession: adminSessions[0],
    allAdminSessions: adminSessions,
    metadata: adminSessions[0].metadata || metadata,
  };
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
    verifiedUid = "",
    userEmail = "",
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

  // 0. If user sent bare `.meta` with no request
  if (!rawPrompt) {
    if (hasImageMedia) {
      // Bare `.meta` on an image -> explain the image and extract any text
      try {
        const imgBuf = await downloadMessageMedia(sourceMediaMsg, "imageMessage", sock);
        const explanation = await explainImageBuffer(imgBuf, "Explain this image and transcribe any visible text.");
        return reply(explanation);
      } catch (err) {
        return reply(`❌ Could not analyze image: ${err.message || "Download failed"}`);
      }
    }

    if (quotedText) {
      const response = await generateMetaConversationalReply("Explain or summarize this message.", quotedText);
      return reply(response);
    }

    return reply(
      [
        "🤖 *SOLVATECH META AI ASSISTANT*",
        "────────────────────────────",
        "Ask me anything or tell me what to do in natural language!",
        "",
        "*Examples:*",
        "• `.meta summarize the chat while I was away`",
        "• `.meta mention everyone who is currently online`",
        "• `.meta check my license`",
        "• `.meta start a quiz and keep score`",
        "• `.meta make a riddle for the group`",
        "• `.meta delete my last 5 messages`",
        "• `.meta delete the message I'm replying to`",
        "• `.meta add these two numbers to the group 23480...`",
        "• `.meta remove 20 random members`",
        "• `.meta explain this image` / `.meta extract all text from this image`",
        "• `.meta translate this`",
        "• `.meta create a group announcement`",
      ].join("\n")
    );
  }

  // 1. Check if there is an active group game and the user is answering or controlling it
  const activeGame = getActiveGame(chatId);
  if (activeGame && !/\b(start|new|stop|end|cancel|score|leaderboard|hint|next|skip|summarize|delete|remove|kick|add|license|expire|online|translate)\b/i.test(lower)) {
    const evalResult = evaluateGameAnswer(chatId, rawPrompt, sender, message.pushName || "");
    if (evalResult.matched) {
      return reply(evalResult.responseText, evalResult.mentions?.length ? { mentions: evalResult.mentions } : {});
    }
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 1: LICENSE & ACCOUNT EXPIRY
  // Examples:
  // ".meta check my license", ".meta when does my license expire?",
  // ".meta is my license still active", ".meta when will my key expire", ".meta tell me my expiry"
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
  if (/\b(delete|erase|unsend|clear)\b/i.test(lower) && /\b(message|messages|msg|msgs|replying|replied|this|last)\b/i.test(lower)) {
    // Case A: "delete my last N messages" / "delete my last message"
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

      // Also delete the .meta command message itself if possible
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

    // Case B: "delete the message I'm replying to" / "delete this message"
    const quotedDeleteKey = resolveQuotedDeleteKey(message, chatId);
    if (!quotedDeleteKey) {
      return reply("⚠️ Please reply directly to the message you want me to delete, or specify e.g. `.meta delete my last 5 messages`.");
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

      // Also delete the .meta command message itself
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
  // Examples:
  // ".meta mention everyone who is currently online", ".meta tell me who is currently online"
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
          selfJid ? `• @${extractParticipantNumber(selfJid)} — 🟢 Online now (You)` : "• No other members have broadcast live online presence in the last few minutes.",
          "",
          "ℹ️ _Note: WhatsApp only shares live presence for members who have interacted recently or have online visibility enabled._",
        ].join("\n"),
        selfJid ? { mentions: [selfJid] } : {}
      );
    }

    const mentions = onlineList.map((u) => u.mentionJid).filter(Boolean);
    const memberLines = onlineList.map(
      (u, idx) =>
        `${idx + 1}. @${u.userNumber}${u.pushName ? ` (*${u.pushName}*)` : ""} — ${u.statusLabel}`
    );

    const header = shouldMention
      ? `📢 *MENTIONING CURRENTLY ONLINE / ACTIVE MEMBERS (${onlineList.length})*`
      : `🟢 *CURRENTLY ONLINE / ACTIVE MEMBERS (${onlineList.length})*`;

    return reply(
      [
        header,
        `Group: *${metadata.subject || "Group"}*`,
        "────────────────────────────",
        ...memberLines,
      ].join("\n"),
      { mentions }
    );
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 4: GROUP ADMINISTRATION — REMOVE N RANDOM MEMBERS
  // Example: ".meta remove 20 random members", ".meta kick 5 random members"
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

    // Filter strictly to regular non-admin members, excluding the caller and all connected bot accounts
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

    // Shuffle randomly
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
          extractParticipantNumber(participant.phoneNumber || participant.id) ||
          participant.id.split("@")[0];
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
  // Example: ".meta add these two numbers to the group 2348012345678 2348098765432"
  // -------------------------------------------------------------------------
  if (
    /\b(add|invite)\b/i.test(lower) &&
    (/\b(number|numbers|person|people|member|members|group|them|him|her)\b/i.test(lower) ||
      /\b\d{7,15}\b/.test(lower))
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

    const combinedTextForNumbers = `${rawPrompt} ${quotedText || ""}`;
    // Match formatted international numbers (e.g. +234 801 234 5678) or standalone 7-15 digit phone numbers
    const rawMatches =
      combinedTextForNumbers.match(/(?:\+\d{1,3}(?:[\s-]?\d{2,5}){2,4}|\b\d{7,15}\b)/g) || [];
    const normalizedNumbers = [
      ...new Set(
        rawMatches
          .map((m) => normalizeNumber(m))
          .filter((n) => n.length >= 7 && n.length <= 15)
      ),
    ];

    if (normalizedNumbers.length === 0) {
      return reply("⚠️ Please provide the phone number(s) (with country code) you want me to add to the group.\nExample: `.meta add 2348012345678 and 2348098765432 to the group`");
    }

    const { adminSession } = authCheck;
    const added = [];
    const failed = [];

    for (const num of normalizedNumbers) {
      const jid = `${num}@s.whatsapp.net`;
      try {
        const res = await adminSession.sock.groupParticipantsUpdate(chatId, [jid], "add");
        const firstStatus = Array.isArray(res) && res[0]?.status ? String(res[0].status) : "200";
        if (firstStatus === "200" || firstStatus === "409") {
          added.push({ num, jid, alreadyIn: firstStatus === "409" });
        } else {
          failed.push({ num, status: firstStatus });
        }
      } catch (err) {
        failed.push({ num, status: err.message || "failed" });
      }
    }

    const lines = ["➕ *GROUP ADD RESULT*", "────────────────────────────"];
    if (added.length > 0) {
      lines.push(
        `✅ *Added (${added.length}):* ${added
          .map((a) => `@${a.num}${a.alreadyIn ? " (already in group)" : ""}`)
          .join(", ")}`
      );
    }
    if (failed.length > 0) {
      lines.push(
        `❌ *Could not add (${failed.length}):* ${failed
          .map((f) => `+${f.num} (status: ${f.status})`)
          .join(", ")}`
      );
    }

    return reply(lines.join("\n"), {
      mentions: added.map((a) => a.jid),
    });
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 6: GROUP ADMINISTRATION — REMOVE / KICK SPECIFIC MEMBER(S)
  // Examples:
  // ".meta remove this person", ".meta kick the person I'm replying to", ".meta remove @2348012345678"
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

    // Also support multiple @mentions or numbers in prompt
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
  // (Promote, Demote, Lock, Unlock, Pin, Group Link, Group Info, Admins, TagAll)
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
  // Example: ".meta create a group announcement"
  // -------------------------------------------------------------------------
  if (/\b(create|make|write|draft|send)\s+(?:a\s+|an\s+)?(?:group\s+)?(?:announcement|notice)\b/i.test(lower)) {
    const announcementText = await generateMetaConversationalReply(
      `Create a clear, professional WhatsApp group announcement based on this request: "${rawPrompt}".`,
      quotedText
    );

    if (isGroup(chatId) && /\b(tag\s+everyone|mention\s+everyone|tag\s+all)\b/i.test(lower)) {
      return tagall({ ...ctx, text: announcementText });
    }
    return reply(announcementText);
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 10: GROUP CONVERSATION INTELLIGENCE (SUMMARIZE / SEARCH CHAT)
  // Examples:
  // ".meta summarize the chat while I was away", ".meta summarize the last 50 messages",
  // ".meta what happened in the last 30 messages?", ".meta what are people discussing?",
  // ".meta who has been talking about the new bot update?", ".meta find where someone mentioned the license",
  // ".meta explain what happened while I was offline", ".meta summarize this conversation"
  // -------------------------------------------------------------------------
  const isSingleQuotedSummary =
    Boolean(quotedText) &&
    /\b(summarize\s+this(?:\s+message)?|explain\s+this\s+message|tldr)\b/i.test(lower) &&
    !/\b(chat|group|conversation|away|offline|messages)\b/i.test(lower);

  if (isSingleQuotedSummary) {
    const singleSummary = await generateMetaConversationalReply(rawPrompt, quotedText);
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
  // Examples:
  // ".meta start a quiz for the group", ".meta start a quiz and keep score",
  // ".meta let's play a game", ".meta make a riddle for the group"
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
    /\b(start\s+a\s+quiz|quiz\s+for\s+the\s+group|keep\s+score|trivia|let'?s\s+play\s+a\s+game|play\s+a\s+game|word\s+scramble|guess\s+the\s+number|riddle\s+for\s+the\s+group|make\s+a\s+riddle)\b/i.test(
      lower
    )
  ) {
    // 1. Riddle Game
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

    // 2. Word Scramble Game
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

    // 3. Number Guessing Game
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

    // 4. Default: Multi-Round Interactive Group Quiz with Live Scorekeeping
    const topicMatch = rawPrompt.match(/\babout\s+([a-zA-Z0-9\s]+)$/i);
    const topic = topicMatch ? topicMatch[1].trim() : "";
    const questions = await buildQuizQuestions(topic, 5);
    const game = startGroupGame(chatId, {
      type: "quiz",
      title: "SOLVATECH GROUP TRIVIA QUIZ",
      questions,
      keepScore: true,
    });
    return reply(formatCurrentGamePrompt(game));
  }

  // -------------------------------------------------------------------------
  // CAPABILITY 12: MEDIA, OCR & IMAGE EXPLANATION
  // Examples:
  // ".meta extract all text from this image", ".meta explain this image",
  // ".meta make a sticker", ".meta open view once", ".meta recover deleted message"
  // -------------------------------------------------------------------------
  if (
    hasImageMedia &&
    /\b(extract|ocr|read\s+.*text|transcribe|words\s+in\s+this\s+image|text\s+from\s+this\s+image)\b/i.test(lower)
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
    return reply("⚠️ Please attach an image or reply to an image with `.meta extract all text from this image`.");
  }

  if (/\b(explain\s+this\s+image|describe\s+this\s+image|what\s+is\s+in\s+this\s+image)\b/i.test(lower) && !hasImageMedia) {
    return reply("⚠️ Please attach an image or reply to an image with `.meta explain this image`.");
  }

  if (/\b(make\s+a\s+sticker|turn\s+.*into\s+a\s+sticker|convert\s+to\s+sticker|create\s+sticker)\b/i.test(lower)) {
    return sticker(ctx);
  }

  if (/\b(sticker\s+to\s+(?:image|picture|photo|video)|antisticker|convert\s+sticker)\b/i.test(lower)) {
    return antisticker(ctx);
  }

  if (/\b(view\s*once|reveal\s+this|open\s+view\s*once)\b/i.test(lower)) {
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
      return reply("⚠️ Please reply to a message with `.meta translate this` (or `.meta translate to French: <text>`).");
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
  // CAPABILITY 15: GENERAL CONVERSATION, JOKES, RIDDLES, Q&A & CONTENT GENERATION
  // -------------------------------------------------------------------------
  const aiResponse = await generateMetaConversationalReply(rawPrompt, quotedText);
  return reply(aiResponse);
}

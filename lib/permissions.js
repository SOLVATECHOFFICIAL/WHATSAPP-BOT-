import {
  extractParticipantJid,
  extractParticipantNumber,
  getAllContextInfos,
  getMessageContent,
  isGroup,
  jidAliases,
  normalizedUser,
} from "./helpers.js";

export async function groupContext(sock, jid) {
  if (!isGroup(jid)) throw new Error("This command only works in groups.");
  const metadata = await sock.groupMetadata(jid);
  const admins = metadata.participants.filter((item) => item.admin);
  const botJid = normalizedUser(sock.user?.id || "");
  const senderJid = normalizedUser(metadata._messageSender || "");
  return { metadata, admins, botJid, senderJid };
}

export function isAdmin(metadata, jid) {
  if (!metadata || !Array.isArray(metadata.participants)) return false;
  const rawList = (Array.isArray(jid) ? jid : [jid]).filter(Boolean);
  const wanted = new Set(rawList.flatMap(jidAliases));
  const wantedNumbers = new Set(
    rawList
      .filter((j) => typeof j === "string" && (j.endsWith("@s.whatsapp.net") || !j.includes("@")))
      .map((j) => extractParticipantNumber(j))
      .filter(Boolean)
  );
  return Boolean(metadata.participants.find((item) => {
    const isItemAdmin = item.admin === "admin" || item.admin === "superadmin" || item.admin === true;
    if (!isItemAdmin) return false;
    const itemJids = [item.id, item.jid, item.lid, item.phoneNumber].filter(Boolean);
    const participantAliases = itemJids.flatMap(jidAliases);
    if (participantAliases.some((alias) => wanted.has(alias))) return true;
    if (wantedNumbers.size > 0) {
      const itemPhoneNumbers = itemJids
        .filter((j) => String(j).endsWith("@s.whatsapp.net"))
        .map((j) => extractParticipantNumber(j))
        .filter(Boolean);
      if (itemPhoneNumbers.some((num) => wantedNumbers.has(num))) return true;
    }
    return false;
  }));
}

export function isOwner(metadata, jid) {
  if (!metadata) return false;
  const wanted = new Set((Array.isArray(jid) ? jid : [jid]).filter(Boolean).flatMap(jidAliases));
  const owners = [
    metadata.owner,
    metadata.ownerPn,
    metadata.ownerLid,
    metadata.subjectOwner,
  ].filter(Boolean);
  return owners.some((owner) => jidAliases(owner).some((alias) => wanted.has(alias)));
}

export function isBotAdmin(metadata, botJid) {
  return isAdmin(metadata, botJid);
}

export function participantJid(metadata, jid) {
  if (!metadata || !Array.isArray(metadata.participants)) return null;
  const wanted = new Set((Array.isArray(jid) ? jid : [jid]).filter(Boolean).flatMap(jidAliases));
  const participant = metadata.participants.find((item) => {
    const aliases = [
      ...(item.id ? jidAliases(item.id) : []),
      ...(item.jid ? jidAliases(item.jid) : []),
      ...(item.lid ? jidAliases(item.lid) : []),
      ...(item.phoneNumber ? jidAliases(item.phoneNumber) : []),
    ];
    return aliases.some((alias) => wanted.has(alias));
  });
  return participant?.id || participant?.jid || participant?.lid || participant?.phoneNumber || null;
}

export function targetFromMessage(message) {
  const content = getMessageContent(message);
  const directContext =
    content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo ||
    content?.documentMessage?.contextInfo ||
    content?.audioMessage?.contextInfo ||
    content?.stickerMessage?.contextInfo ||
    content?.ptvMessage?.contextInfo ||
    content?.contextInfo;

  if (directContext?.mentionedJid?.length > 0) {
    return directContext.mentionedJid[0];
  }
  if ((directContext?.stanzaId || directContext?.quotedMessage) && directContext?.participant) {
    return directContext.participant;
  }

  const allContexts = getAllContextInfos(message);
  for (const ctx of allContexts) {
    if (Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.length > 0) {
      return ctx.mentionedJid[0];
    }
  }
  for (const ctx of allContexts) {
    if ((ctx?.stanzaId || ctx?.quotedMessage) && ctx?.participant) {
      return ctx.participant;
    }
  }

  return null;
}

/**
 * Strictly resolves the target for manual `.warn` ONLY from:
 * 1. The replied-to message sender (Reply method), OR
 * 2. The explicitly tagged user (Tag method).
 * Never falls back to the command sender. Also extracts the replied-to message key for deletion.
 */
export function resolveManualWarnTarget(metadata, message, args = [], chatId = "") {
  const content = getMessageContent(message);
  const directContext =
    content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo ||
    content?.documentMessage?.contextInfo ||
    content?.audioMessage?.contextInfo ||
    content?.stickerMessage?.contextInfo ||
    content?.ptvMessage?.contextInfo ||
    content?.contextInfo ||
    message?.contextInfo ||
    Object.values(content || {}).find((v) => v && typeof v === "object" && v.contextInfo)?.contextInfo ||
    null;

  let replyContext = null;
  if ((directContext?.stanzaId || directContext?.quotedMessage) && directContext?.participant) {
    replyContext = directContext;
  } else if (message?.quoted && (message.quoted.participant || message.quoted.key?.participant)) {
    replyContext = {
      stanzaId: message.quoted.key?.id || message.quoted.id || message.quoted.stanzaId,
      participant: message.quoted.participant || message.quoted.key?.participant,
      quotedMessage: message.quoted.message || message.quoted,
    };
  } else {
    const allContexts = getAllContextInfos(message);
    replyContext = allContexts.find((ctx) => (ctx?.stanzaId || ctx?.quotedMessage) && ctx?.participant) || null;
  }

  const hasExplicitArgTag = Array.isArray(args) && args.some((a) => String(a || "").trim().startsWith("@"));
  let rawTarget = null;
  let isReplyMethod = false;
  let quotedMessageId = null;
  let quotedParticipant = null;

  // 1. Reply method: Admin replies to a violating message with `.warn`
  if (replyContext && replyContext.participant && !hasExplicitArgTag) {
    rawTarget = replyContext.participant;
    isReplyMethod = true;
    quotedMessageId = replyContext.stanzaId || null;
    quotedParticipant = replyContext.participant;
  }

  // 2. Tag method: Admin sends `.warn @user`
  if (!rawTarget) {
    if (Array.isArray(directContext?.mentionedJid) && directContext.mentionedJid.length > 0) {
      rawTarget = directContext.mentionedJid[0];
    } else {
      const allContexts = getAllContextInfos(message);
      for (const ctx of allContexts) {
        if (Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.length > 0) {
          rawTarget = ctx.mentionedJid[0];
          break;
        }
      }
    }

    if (!rawTarget && Array.isArray(args) && args.length > 0) {
      const firstArg = String(args[0] || "").trim();
      if (firstArg.endsWith("@s.whatsapp.net") || firstArg.endsWith("@lid")) {
        rawTarget = firstArg.replace(/^@/, "");
      } else if (firstArg.startsWith("@")) {
        const stripped = firstArg.slice(1);
        if (/^\+?\d[\d\s-]{4,18}\d$/.test(stripped)) {
          const digits = stripped.replace(/\D/g, "");
          if (digits.length >= 6 && digits.length <= 16) {
            rawTarget = `${digits}@s.whatsapp.net`;
          }
        }
      }
    }

    // If the admin both replied to a message AND tagged the same sender, still delete the replied-to message
    if (rawTarget && replyContext && replyContext.stanzaId && replyContext.participant) {
      const replyAliases = new Set(jidAliases(replyContext.participant));
      if (jidAliases(rawTarget).some((a) => replyAliases.has(a))) {
        isReplyMethod = true;
        quotedMessageId = replyContext.stanzaId;
        quotedParticipant = replyContext.participant;
      }
    }
  }

  if (!rawTarget || typeof rawTarget !== "string") {
    return null;
  }

  const resolved = resolveGroupTargetJids(metadata, { message: {} }, [rawTarget]);
  if (!resolved || !resolved.canonicalJid) {
    return null;
  }

  const effectiveChatId = chatId || message?.key?.remoteJid || "";
  const quotedDeleteKey =
    isReplyMethod && quotedMessageId && effectiveChatId
      ? {
          remoteJid: effectiveChatId,
          fromMe: false,
          id: quotedMessageId,
          participant: quotedParticipant || resolved.matchedParticipant?.id || resolved.mentionJid || resolved.canonicalJid,
        }
      : null;

  return {
    ...resolved,
    isReplyMethod,
    quotedMessageId,
    quotedParticipant,
    quotedDeleteKey,
  };
}

/**
 * Resolves a target group participant from a mention, reply, or explicit JID/number argument,
 * returning both the canonical JID and all JID aliases (phone JID, LID, device JID) for that user.
 * Never uses display names as warning keys. Returns null if no valid target is present.
 */
export function resolveGroupTargetJids(metadata, message, args = []) {
  let rawTarget = targetFromMessage(message);

  if (!rawTarget && Array.isArray(args) && args.length > 0) {
    const firstArg = String(args[0] || "").trim();
    if (firstArg.endsWith("@s.whatsapp.net") || firstArg.endsWith("@lid")) {
      rawTarget = firstArg.replace(/^@/, "");
    } else {
      // Only accept numeric phone/JID tokens (never plain display names)
      const stripped = firstArg.replace(/^@/, "");
      if (/^\+?\d[\d\s-]{5,18}\d$/.test(stripped)) {
        const digits = stripped.replace(/\D/g, "");
        if (digits.length >= 7 && digits.length <= 16) {
          rawTarget = `${digits}@s.whatsapp.net`;
        }
      }
    }
  }

  if (!rawTarget || typeof rawTarget !== "string") {
    return null;
  }

  const cleanRaw = normalizedUser(rawTarget);
  if (!cleanRaw || cleanRaw.endsWith("@g.us") || cleanRaw === "status@broadcast") {
    return null;
  }

  const wantedAliases = new Set(jidAliases(cleanRaw));
  const wantedNumber = cleanRaw.endsWith("@s.whatsapp.net") ? extractParticipantNumber(cleanRaw) : "";

  const matchedParticipant = (metadata?.participants || []).find((item) => {
    const itemJids = [item.id, item.jid, item.lid, item.phoneNumber].filter(Boolean);
    const aliases = itemJids.flatMap(jidAliases);
    if (aliases.some((alias) => wantedAliases.has(alias))) return true;
    if (wantedNumber && itemJids.some((j) => j.endsWith("@s.whatsapp.net") && extractParticipantNumber(j) === wantedNumber)) {
      return true;
    }
    return false;
  });

  const candidateSeeds = [
    matchedParticipant?.phoneNumber,
    matchedParticipant?.jid,
    matchedParticipant?.id,
    matchedParticipant?.lid,
    cleanRaw,
    rawTarget,
  ].filter(Boolean);

  const allJids = [
    ...new Set(
      candidateSeeds
        .flatMap((j) => [
          j,
          normalizedUser(j),
          j.endsWith("@s.whatsapp.net") ? extractParticipantJid(j) : "",
          ...jidAliases(j),
        ])
        .filter((j) => j && typeof j === "string" && !j.endsWith("@g.us") && j !== "status@broadcast")
    ),
  ];

  const preferredPhoneJid =
    matchedParticipant?.phoneNumber ||
    matchedParticipant?.jid ||
    allJids.find((j) => j.endsWith("@s.whatsapp.net")) ||
    matchedParticipant?.id ||
    matchedParticipant?.lid ||
    cleanRaw;

  const canonicalJid = normalizedUser(preferredPhoneJid) || cleanRaw;
  const mentionJid = matchedParticipant?.id || canonicalJid;

  return {
    rawTarget,
    canonicalJid,
    mentionJid,
    allJids,
    matchedParticipant: matchedParticipant || null,
  };
}

export function assertAdmin(metadata, sender, botRequired = false, botJid = "") {
  if (!isAdmin(metadata, sender)) throw new Error("❌ You must be a group admin.");
  if (botRequired && !isBotAdmin(metadata, botJid)) throw new Error("❌ I need to be a group admin.");
}
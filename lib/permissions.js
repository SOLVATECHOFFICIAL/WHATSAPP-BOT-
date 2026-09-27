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
  const wanted = new Set((Array.isArray(jid) ? jid : [jid]).flatMap(jidAliases));
  return Boolean(metadata.participants.find((item) => {
    const participantAliases = [
      ...(item.id ? jidAliases(item.id) : []),
      ...(item.jid ? jidAliases(item.jid) : []),
      ...(item.lid ? jidAliases(item.lid) : []),
      ...(item.phoneNumber ? jidAliases(item.phoneNumber) : []),
    ];
    const sameUser = participantAliases.some((alias) => wanted.has(alias));
    return sameUser && (item.admin === "admin" || item.admin === "superadmin" || item.admin === true);
  }));
}

export function isOwner(metadata, jid) {
  const wanted = new Set((Array.isArray(jid) ? jid : [jid]).flatMap(jidAliases));
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
  const wanted = new Set((Array.isArray(jid) ? jid : [jid]).flatMap(jidAliases));
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
    content?.documentMessage?.contextInfo;

  if (directContext?.mentionedJid?.length > 0) {
    return directContext.mentionedJid[0];
  }
  if (directContext?.participant) {
    return directContext.participant;
  }

  const allContexts = getAllContextInfos(message);
  for (const ctx of allContexts) {
    if (Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.length > 0) {
      return ctx.mentionedJid[0];
    }
  }
  for (const ctx of allContexts) {
    if (ctx?.participant) {
      return ctx.participant;
    }
  }

  return null;
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
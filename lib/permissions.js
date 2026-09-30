import { getMessageContent, isGroup, jidAliases, normalizedUser } from "./helpers.js";

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
  const context =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo;
  const mentioned = context?.mentionedJid || [];
  return mentioned[0] || context?.participant || null;
}

export function assertAdmin(metadata, sender, botRequired = false, botJid = "") {
  if (!isAdmin(metadata, sender)) throw new Error("❌ You must be a group admin.");
  if (botRequired && !isBotAdmin(metadata, botJid)) throw new Error("❌ I need to be a group admin.");
}
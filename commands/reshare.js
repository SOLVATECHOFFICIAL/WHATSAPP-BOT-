import sharp from "sharp";
import { isJidStatusBroadcast, jidNormalizedUser } from "@whiskeysockets/baileys";
import { downloadViewOnceRobust } from "../lib/media.js";
import { downloadMessageMedia, getMessageContent, unwrapMediaMessage } from "../lib/helpers.js";
import { getCachedIncomingMessage, getKnownContactJids } from "../lib/deleted-messages.js";
import { logger } from "../lib/logger.js";

const STATUS_BROADCAST_JID = "status@broadcast";
const PUBLISH_TIMEOUT_MS = 45000;

function escapeXml(unsafe) {
  return String(unsafe || "").replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
      default: return c;
    }
  });
}

function wrapText(text, maxCharsPerLine = 30) {
  const rawLines = String(text || "").split(/\r?\n/);
  const resultLines = [];
  for (const rawLine of rawLines) {
    if (!rawLine.trim()) {
      resultLines.push("");
      continue;
    }
    const words = rawLine.split(/\s+/);
    let currentLine = "";
    for (const word of words) {
      if (!currentLine) {
        currentLine = word;
      } else if ((currentLine + " " + word).length <= maxCharsPerLine) {
        currentLine += ` ${word}`;
      } else {
        resultLines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) {
      resultLines.push(currentLine);
    }
  }
  return resultLines;
}

function argbToHex(argb) {
  if (typeof argb !== "number" || argb === 0) return null;
  const unsigned = argb >>> 0;
  const rgb = unsigned & 0x00FFFFFF;
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

async function renderTextStatusImage(text, options = {}) {
  const bg = options.backgroundColor || "#243640";
  const lines = wrapText(text, 28);
  const totalLines = Math.max(1, lines.length);

  let fontSize = 52;
  if (totalLines > 16 || text.length > 300) fontSize = 32;
  else if (totalLines > 10 || text.length > 180) fontSize = 38;
  else if (totalLines > 6 || text.length > 90) fontSize = 46;

  const lineHeight = Math.round(fontSize * 1.45);
  const totalTextHeight = totalLines * lineHeight;
  const startY = Math.max(220, Math.round((1920 - totalTextHeight) / 2) + Math.round(fontSize / 2));

  const textNodes = lines.map((line, idx) => {
    const y = startY + (idx * lineHeight);
    return `<text x="540" y="${y}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-weight="600" font-size="${fontSize}" fill="#ffffff" text-anchor="middle">${escapeXml(line)}</text>`;
  }).join("\n    ");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1080" height="1920" viewBox="0 0 1080 1920" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="statusGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${bg}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${bg}" stop-opacity="0.9"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#statusGrad)"/>
  <g>
    ${textNodes}
  </g>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Builds the complete recipient JID list required by WhatsApp/Baileys
 * for distributing the sender key to the user's devices and contacts.
 */
function buildStatusRecipientJidList({ sock, message, contextInfo, userId }) {
  const jidSet = new Set();

  const addJid = (rawJid) => {
    if (!rawJid || typeof rawJid !== "string") return;
    if (rawJid.endsWith("@g.us") || isJidStatusBroadcast(rawJid)) return;
    try {
      const normalized = jidNormalizedUser(rawJid);
      if (normalized) jidSet.add(normalized);
    } catch {
      jidSet.add(rawJid.split(":")[0].split("@")[0] + "@s.whatsapp.net");
    }
  };

  // 1. Bot / Owner own account devices
  addJid(sock.user?.id);
  addJid(sock.user?.lid);
  addJid(sock.authState?.creds?.me?.id);
  addJid(sock.authState?.creds?.me?.lid);

  // 2. Requester who sent .reshare
  addJid(message.key?.participant);
  addJid(message.key?.remoteJid);

  // 3. Status author participant
  addJid(contextInfo?.participant);

  // 4. Known recent contacts from active session
  const contacts = getKnownContactJids(userId);
  for (const contactJid of contacts) {
    addJid(contactJid);
  }

  return Array.from(jidSet);
}

/**
 * .reshare command:
 * Triggered strictly by replying directly to a WhatsApp Status.
 * Retrieves that exact Status (Photo, Video, or Text) and publishes it
 * directly to the requesting user's own WhatsApp Status.
 */
export default async function reshare({ sock, message, reply, userId = "default" }) {
  const startTime = Date.now();
  const msgKey = message.key || {};
  const content = getMessageContent(message);
  const contextInfo = Object.values(content).find(
    (val) => val && typeof val === "object" && val.contextInfo
  )?.contextInfo;

  const quotedMsg = contextInfo?.quotedMessage;
  const quotedStanzaId = contextInfo?.stanzaId;

  // 1. Strict Status Verification:
  // Must verify that the replied message actually represents a WhatsApp Status.
  const cachedEntry = quotedStanzaId ? getCachedIncomingMessage(userId, quotedStanzaId) : null;
  const isStatus =
    contextInfo?.remoteJid === STATUS_BROADCAST_JID ||
    message.key?.remoteJid === STATUS_BROADCAST_JID ||
    cachedEntry?.remoteJid === STATUS_BROADCAST_JID;

  logger.info("[RESHARE] Status check initiated", {
    messageId: msgKey.id,
    remoteJid: msgKey.remoteJid,
    participant: msgKey.participant,
    quotedStanzaId,
    quotedRemoteJid: contextInfo?.remoteJid,
    isStatus,
    hasQuotedMsg: Boolean(quotedMsg),
  });

  if (!quotedMsg || !isStatus) {
    logger.warn("[RESHARE] Rejected: not a direct reply to a WhatsApp Status", {
      hasQuotedMsg: Boolean(quotedMsg),
      isStatus,
      quotedRemoteJid: contextInfo?.remoteJid,
    });
    return reply("Reply directly to a Status with .reshare.");
  }

  const unwrapQuoted = unwrapMediaMessage(quotedMsg);

  try {
    const quotedSource = {
      key: {
        remoteJid: STATUS_BROADCAST_JID,
        id: quotedStanzaId || msgKey.id,
        participant: contextInfo?.participant,
        fromMe: false,
      },
      message: quotedMsg,
    };

    let statusType = "unknown";
    let messagePayload = null;

    // ----------------------------------------------------
    // CASE 1: PHOTO STATUS
    // ----------------------------------------------------
    const hasImage = Boolean(
      unwrapQuoted.imageMessage ||
      unwrapQuoted.viewOnceMessage?.message?.imageMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.imageMessage ||
      cachedEntry?.mediaType === "image"
    );

    if (hasImage) {
      statusType = "photo";
      logger.info("[RESHARE] Status detected: Photo Status. Starting media retrieval...", {
        stanzaId: quotedStanzaId,
        participant: contextInfo?.participant,
      });

      let imageBuffer;
      try {
        imageBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch (err) {
        logger.warn("[RESHARE] downloadViewOnceRobust failed for image, trying downloadMessageMedia fallback", err.message);
        imageBuffer = await downloadMessageMedia(quotedSource, "image", sock);
      }

      if (!imageBuffer || imageBuffer.length === 0) {
        logger.error("[RESHARE] Photo retrieval failed: Empty buffer received");
        throw new Error("Empty image buffer retrieved from status");
      }

      const caption = unwrapQuoted.imageMessage?.caption ||
        unwrapQuoted.viewOnceMessage?.message?.imageMessage?.caption ||
        "";

      logger.info("[RESHARE] Photo retrieved successfully", {
        bufferBytes: imageBuffer.length,
        hasCaption: Boolean(caption),
      });

      messagePayload = {
        image: imageBuffer,
        caption: caption || undefined,
      };
    }

    // ----------------------------------------------------
    // CASE 2: VIDEO STATUS
    // ----------------------------------------------------
    const hasVideo = !messagePayload && Boolean(
      unwrapQuoted.videoMessage ||
      unwrapQuoted.ptvMessage ||
      unwrapQuoted.viewOnceMessage?.message?.videoMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.videoMessage ||
      cachedEntry?.mediaType === "video"
    );

    if (hasVideo) {
      statusType = "video";
      logger.info("[RESHARE] Status detected: Video Status. Starting media retrieval...", {
        stanzaId: quotedStanzaId,
        participant: contextInfo?.participant,
      });

      let videoBuffer;
      try {
        videoBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch (err) {
        logger.warn("[RESHARE] downloadViewOnceRobust failed for video, trying downloadMessageMedia fallback", err.message);
        videoBuffer = await downloadMessageMedia(quotedSource, "video", sock);
      }

      if (!videoBuffer || videoBuffer.length === 0) {
        logger.error("[RESHARE] Video retrieval failed: Empty buffer received");
        throw new Error("Empty video buffer retrieved from status");
      }

      const caption = unwrapQuoted.videoMessage?.caption ||
        unwrapQuoted.viewOnceMessage?.message?.videoMessage?.caption ||
        "";
      const mimetype = unwrapQuoted.videoMessage?.mimetype || "video/mp4";

      logger.info("[RESHARE] Video retrieved successfully", {
        bufferBytes: videoBuffer.length,
        mimetype,
        hasCaption: Boolean(caption),
      });

      messagePayload = {
        video: videoBuffer,
        caption: caption || undefined,
        mimetype,
      };
    }

    // ----------------------------------------------------
    // CASE 3: TEXT STATUS
    // ----------------------------------------------------
    if (!messagePayload) {
      const statusText =
        unwrapQuoted.conversation ||
        unwrapQuoted.extendedTextMessage?.text ||
        "";

      if (statusText && statusText.trim().length > 0) {
        statusType = "text";
        logger.info("[RESHARE] Status detected: Text Status. Rendering high-res status image...", {
          textLength: statusText.length,
          stanzaId: quotedStanzaId,
        });

        const bgArgb = unwrapQuoted.extendedTextMessage?.backgroundArgb;
        const hexColor = argbToHex(bgArgb) || "#243640";

        const statusImageBuffer = await renderTextStatusImage(statusText, {
          backgroundColor: hexColor,
        });

        if (!statusImageBuffer || statusImageBuffer.length === 0) {
          logger.error("[RESHARE] Text status image rendering failed: Empty buffer generated");
          throw new Error("Failed to render text status image buffer");
        }

        logger.info("[RESHARE] Text status image rendered successfully", {
          bufferBytes: statusImageBuffer.length,
          backgroundColor: hexColor,
        });

        messagePayload = {
          image: statusImageBuffer,
        };
      }
    }

    if (!messagePayload) {
      logger.error("[RESHARE] Status type unrecognized or unhandled content", {
        unwrapQuotedKeys: Object.keys(unwrapQuoted),
      });
      return reply("❌ I couldn't publish that Status. Please try again.");
    }

    // ----------------------------------------------------
    // PUBLICATION TO USER'S OWN WHATSAPP STATUS
    // ----------------------------------------------------
    const statusJidList = buildStatusRecipientJidList({
      sock,
      message,
      contextInfo,
      userId,
    });

    const sendOptions = {
      broadcast: true,
      statusJidList,
      mediaUploadTimeoutMs: PUBLISH_TIMEOUT_MS,
    };

    logger.info("[RESHARE] Publishing to WhatsApp Status...", {
      destination: STATUS_BROADCAST_JID,
      statusType,
      recipientCount: statusJidList.length,
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });

    const sendPromise = sock.sendMessage(STATUS_BROADCAST_JID, messagePayload, sendOptions);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Status publication timed out after 45 seconds")), PUBLISH_TIMEOUT_MS)
    );

    const publishResult = await Promise.race([sendPromise, timeoutPromise]);

    // Verify publication response
    const publishedId = publishResult?.key?.id;
    const publishedRemoteJid = publishResult?.key?.remoteJid;

    if (!publishedId || publishedRemoteJid !== STATUS_BROADCAST_JID) {
      logger.error("[RESHARE] Publication result invalid", {
        publishResult,
        publishedId,
        publishedRemoteJid,
      });
      throw new Error(`Invalid publication confirmation from WhatsApp (id: ${publishedId}, remoteJid: ${publishedRemoteJid})`);
    }

    const durationMs = Date.now() - startTime;
    logger.info("[RESHARE] Publication succeeded!", {
      statusType,
      publishedStatusId: publishedId,
      destination: publishedRemoteJid,
      durationMs,
    });

    return reply("✅ Done — reshared to your Status. You can check it now.");
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error("[RESHARE] Publication failed with error", {
      error: err.message,
      stack: err.stack,
      durationMs,
    });
    return reply("❌ I couldn't publish that Status. Please try again.");
  }
}

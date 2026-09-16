import sharp from "sharp";
import { downloadViewOnceRobust } from "../lib/media.js";
import { downloadMessageMedia, getMessageContent, unwrapMediaMessage } from "../lib/helpers.js";
import { getCachedIncomingMessage } from "../lib/deleted-messages.js";
import { logger } from "../lib/logger.js";

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
 * .reshare command:
 * Triggered strictly by replying to a WhatsApp Status.
 * Retrieves that exact Status (Photo, Video, or Text) and publishes it
 * directly to the requesting user's own WhatsApp Status.
 */
export default async function reshare({ sock, message, reply, userId = "default" }) {
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
    contextInfo?.remoteJid === "status@broadcast" ||
    message.key?.remoteJid === "status@broadcast" ||
    cachedEntry?.remoteJid === "status@broadcast";

  if (!quotedMsg || !isStatus) {
    return reply("Reply directly to a Status with .reshare.");
  }

  const unwrapQuoted = unwrapMediaMessage(quotedMsg);

  try {
    const quotedSource = {
      key: {
        remoteJid: "status@broadcast",
        id: quotedStanzaId || message.key?.id,
        participant: contextInfo?.participant,
        fromMe: false,
      },
      message: quotedMsg,
    };

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
      let imageBuffer;
      try {
        imageBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        imageBuffer = await downloadMessageMedia(quotedSource, "image", sock);
      }

      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error("Empty image buffer received from Status");
      }

      const caption = unwrapQuoted.imageMessage?.caption ||
        unwrapQuoted.viewOnceMessage?.message?.imageMessage?.caption ||
        "";

      await sock.sendMessage("status@broadcast", {
        image: imageBuffer,
        caption: caption || undefined,
      }, {
        broadcast: true,
      });

      return reply("✅ Done — reshared to your Status. You can check it now.");
    }

    // ----------------------------------------------------
    // CASE 2: VIDEO STATUS
    // ----------------------------------------------------
    const hasVideo = Boolean(
      unwrapQuoted.videoMessage ||
      unwrapQuoted.ptvMessage ||
      unwrapQuoted.viewOnceMessage?.message?.videoMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.videoMessage ||
      cachedEntry?.mediaType === "video"
    );

    if (hasVideo) {
      let videoBuffer;
      try {
        videoBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        videoBuffer = await downloadMessageMedia(quotedSource, "video", sock);
      }

      if (!videoBuffer || videoBuffer.length === 0) {
        throw new Error("Empty video buffer received from Status");
      }

      const caption = unwrapQuoted.videoMessage?.caption ||
        unwrapQuoted.viewOnceMessage?.message?.videoMessage?.caption ||
        "";

      const mimetype = unwrapQuoted.videoMessage?.mimetype || "video/mp4";

      await sock.sendMessage("status@broadcast", {
        video: videoBuffer,
        caption: caption || undefined,
        mimetype,
      }, {
        broadcast: true,
      });

      return reply("✅ Done — reshared to your Status. You can check it now.");
    }

    // ----------------------------------------------------
    // CASE 3: TEXT STATUS
    // ----------------------------------------------------
    const statusText =
      unwrapQuoted.conversation ||
      unwrapQuoted.extendedTextMessage?.text ||
      "";

    if (statusText && statusText.trim().length > 0) {
      const bgArgb = unwrapQuoted.extendedTextMessage?.backgroundArgb;
      const hexColor = argbToHex(bgArgb) || "#243640";

      const statusImageBuffer = await renderTextStatusImage(statusText, {
        backgroundColor: hexColor,
      });

      await sock.sendMessage("status@broadcast", {
        image: statusImageBuffer,
      }, {
        broadcast: true,
      });

      return reply("✅ Done — reshared to your Status. You can check it now.");
    }

    // If neither photo, video, nor text status was recognizable
    return reply("❌ Couldn't reshare that Status. Please try again.");
  } catch (err) {
    logger.error("Failed to reshare status", err.stack || err.message);
    return reply("❌ Couldn't reshare that Status. Please try again.");
  }
}

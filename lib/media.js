import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import axios from "axios";
import sharp from "sharp";
import { downloadContentFromMessage, downloadMediaMessage } from "@whiskeysockets/baileys";
import { logger } from "./logger.js";
import { streamToBuffer, unwrapMediaMessage } from "./helpers.js";

export async function imageToSticker(buffer) {
  return sharp(buffer)
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 82 })
    .toBuffer();
}

export async function stickerToImage(buffer) {
  return sharp(buffer).png().toBuffer();
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString().slice(-1000))));
  });
}

export async function videoToSticker(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "solvatech-sticker-"));
  const input = path.join(dir, "input.mp4");
  const output = path.join(dir, "output.webp");
  try {
    await fs.writeFile(input, buffer);
    await runFfmpeg([
      "-y",
      "-i", input,
      "-t", "6",
      "-vf", "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(512-iw)/2:(512-ih)/2:color=#00000000,setsar=1,fps=12",
      "-loop", "0",
      "-an",
      "-vsync", "0",
      "-c:v", "libwebp",
      "-lossless", "0",
      "-compression_level", "4",
      "-q:v", "40",
      output,
    ]);
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function stickerToVideo(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "solvatech-antisticker-"));
  const gifFile = path.join(dir, "anim.gif");
  const output = path.join(dir, "output.mp4");
  try {
    // Strategy 1: Sharp animated GIF decoding -> FFmpeg MP4
    let success = false;
    try {
      const gifBuffer = await sharp(buffer, { animated: true }).gif().toBuffer();
      await fs.writeFile(gifFile, gifBuffer);
      await runFfmpeg([
        "-y",
        "-i", gifFile,
        "-movflags", "faststart",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        output,
      ]);
      const stat = await fs.stat(output);
      if (stat.size > 0) {
        success = true;
      }
    } catch (gifErr) {
      logger.warn("stickerToVideo GIF conversion attempted, falling back to frame sequence", gifErr.message);
    }

    // Strategy 2: Extract frame by frame PNGs if GIF conversion failed
    if (!success) {
      const meta = await sharp(buffer, { animated: true }).metadata();
      const pageCount = meta.pages || 1;
      const delays = meta.delay || [];
      const delayMs = delays[0] && delays[0] > 0 ? delays[0] : 80;
      const fps = Math.max(1, Math.min(60, Math.round(1000 / delayMs)));

      for (let i = 0; i < pageCount; i++) {
        const frameBuf = await sharp(buffer, { page: i }).png().toBuffer();
        await fs.writeFile(path.join(dir, `frame_${String(i).padStart(4, "0")}.png`), frameBuf);
      }

      await runFfmpeg([
        "-y",
        "-framerate", String(fps),
        "-i", path.join(dir, "frame_%04d.png"),
        "-movflags", "faststart",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        output,
      ]);
    }

    return await fs.readFile(output);
  } catch (error) {
    logger.error("stickerToVideo conversion failed", error.message);
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function mediaFromDirectUrl(message) {
  const content = unwrapMediaMessage(message);
  const media =
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage ||
    content.stickerMessage;
  const url = media?.url;
  if (!url) throw new Error("No direct media URL.");
  const response = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  return Buffer.from(response.data);
}

export async function downloadMediaUrl(url, maxBytes = 50 * 1024 * 1024) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 45000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const buffer = Buffer.from(response.data);
  if (!buffer.length) throw new Error("The media URL returned an empty file.");
  if (buffer.length > maxBytes) throw new Error("That media file is larger than 50 MB.");
  return {
    buffer,
    contentType: String(response.headers["content-type"] || "").split(";")[0].toLowerCase(),
  };
}

async function mediaFromKey(message, sock) {
  const content = unwrapMediaMessage(message);
  const media =
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage ||
    content.stickerMessage;
  if (!media?.mediaKey) {
    throw new Error("No media key was present.");
  }
  return downloadMediaMessage(message, "buffer", {}, {
    logger: sock.logger,
    reuploadRequest: sock.updateMediaMessage,
  });
}

export async function downloadViewOnceRobust(sock, message, cachedEntry = null) {
  // 1. If we already have pre-buffered media in memory, return immediately
  if (cachedEntry?.mediaBuffer && Buffer.isBuffer(cachedEntry.mediaBuffer) && cachedEntry.mediaBuffer.length > 0) {
    return cachedEntry.mediaBuffer;
  }

  const target = cachedEntry?.rawMessage || message;

  // Direct media stream decryption via Baileys downloadContentFromMessage
  const directAttempt = async () => {
    const content = unwrapMediaMessage(target);
    const media =
      content.imageMessage ||
      content.videoMessage ||
      content.audioMessage ||
      content.documentMessage ||
      content.stickerMessage;

    if (!media || (!media.url && !media.directPath)) {
      throw new Error("No media direct stream available.");
    }

    const type = content.imageMessage
      ? "image"
      : content.videoMessage
      ? "video"
      : content.audioMessage
      ? "audio"
      : content.stickerMessage
      ? "sticker"
      : "document";

    const stream = await downloadContentFromMessage(media, type);
    const buf = await streamToBuffer(stream);
    if (buf && buf.length > 0) return buf;
    throw new Error("Decrypted stream was empty.");
  };

  const attempts = [
    directAttempt,
    async () => downloadMediaMessage(target, "buffer", {}, { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }),
    async () => mediaFromDirectUrl(target),
    async () => mediaFromKey(target, sock),
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const buffer = await attempt();
      if (buffer?.length) return buffer;
    } catch (error) {
      lastError = error;
      logger.warn("View-once decryption method attempt failed", error.message);
    }
  }
  throw lastError || new Error("All view-once decryption methods failed.");
}

export function guessViewOnceType(message, cachedEntry = null) {
  if (cachedEntry?.mediaType) return cachedEntry.mediaType;
  const target = cachedEntry?.rawMessage || message;
  const content = unwrapMediaMessage(target);
  if (content.imageMessage) return "image";
  if (content.videoMessage) return "video";
  if (content.audioMessage) return "audio";
  if (content.documentMessage) return "document";
  if (content.stickerMessage) return "sticker";

  const raw = target?.message || target || {};
  if (raw.imageMessage || raw.viewOnceMessage?.message?.imageMessage || raw.viewOnceMessageV2?.message?.imageMessage) return "image";
  if (raw.videoMessage || raw.viewOnceMessage?.message?.videoMessage || raw.viewOnceMessageV2?.message?.videoMessage) return "video";
  if (raw.audioMessage || raw.viewOnceMessage?.message?.audioMessage || raw.viewOnceMessageV2?.message?.audioMessage) return "audio";
  if (raw.documentMessage || raw.viewOnceMessage?.message?.documentMessage || raw.viewOnceMessageV2?.message?.documentMessage) return "document";
  return null;
}

export function viewOncePayload(message, buffer, type, cachedEntry = null) {
  const target = cachedEntry?.rawMessage || message;
  const content = unwrapMediaMessage(target);
  const media =
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage ||
    content.stickerMessage ||
    {};

  if (type === "image") return { image: buffer, caption: "🔓 *View-once image revealed.*" };
  if (type === "video") return { video: buffer, caption: "🔓 *View-once video revealed.*" };
  if (type === "audio") {
    return {
      audio: buffer,
      mimetype: media.mimetype || "audio/ogg; codecs=opus",
      ptt: Boolean(media.ptt),
    };
  }
  if (type === "sticker") return { sticker: buffer };
  return {
    document: buffer,
    mimetype: media.mimetype || "application/octet-stream",
    fileName: media.fileName || "revealed-media",
    caption: "🔓 *View-once media revealed.*",
  };
}

export async function downloadToFile(url, extension) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "solvatech-download-"));
  const target = path.join(dir, `media.${extension}`);
  try {
    const response = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
    await fs.writeFile(target, Buffer.from(response.data));
    return { dir, target };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}
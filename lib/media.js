import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import axios from "axios";
import sharp from "sharp";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { logger } from "./logger.js";
import { unwrapMediaMessage } from "./helpers.js";

export async function imageToSticker(buffer) {
  return sharp(buffer).resize(512, 512, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
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
    await runFfmpeg(["-y", "-i", input, "-t", "6", "-vf", "scale=512:512:force_original_aspect_ratio=decrease,fps=12", "-loop", "0", "-an", "-c:v", "libwebp", "-q:v", "50", output]);
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
    // Sharp decodes animated WebP chunks (ANIM/ANMF) reliably and outputs animated GIF
    const gifBuffer = await sharp(buffer, { animated: true }).gif().toBuffer();
    await fs.writeFile(gifFile, gifBuffer);

    // FFmpeg converts GIF into WhatsApp-compatible MP4 (h264, yuv420p, faststart, even dimensions)
    await runFfmpeg([
      "-y",
      "-i", gifFile,
      "-movflags", "faststart",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      output,
    ]);
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

export async function downloadViewOnceRobust(sock, message) {
  const attempts = [
    async () => downloadMediaMessage(message, "buffer", {}, { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }),
    async () => mediaFromDirectUrl(message),
    async () => mediaFromKey(message, sock),
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      const buffer = await attempt();
      if (buffer?.length) return buffer;
    } catch (error) {
      lastError = error;
      logger.warn("View-once decryption method failed", error.message);
    }
  }
  throw lastError || new Error("All view-once methods failed.");
}

export function guessViewOnceType(message) {
  const content = unwrapMediaMessage(message);
  if (content.imageMessage) return "image";
  if (content.videoMessage) return "video";
  if (content.audioMessage) return "audio";
  if (content.documentMessage) return "document";
  if (content.stickerMessage) return "sticker";
  return null;
}

export function viewOncePayload(message, buffer, type) {
  const content = unwrapMediaMessage(message);
  const media =
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage ||
    content.stickerMessage ||
    {};

  if (type === "image") return { image: buffer, caption: "🔓 View-once media recovered." };
  if (type === "video") return { video: buffer, caption: "🔓 View-once media recovered." };
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
    fileName: media.fileName || "view-once-media",
    caption: "🔓 View-once media recovered.",
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
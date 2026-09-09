import { imageToSticker, videoToSticker } from "../lib/media.js";
import { downloadMessageMedia, getQuotedMessage, mediaTypeFromMessage } from "../lib/helpers.js";

export default async function sticker({ sock, message, reply }) {
  const source = getQuotedMessage(message) || message;
  const type = mediaTypeFromMessage(source);
  if (!type) return reply("❌ Reply to an image or video with .sticker.");
  try {
    const buffer = await downloadMessageMedia(source, `${type}Message`);
    const stickerBuffer = type === "image" ? await imageToSticker(buffer) : await videoToSticker(buffer);
    await sock.sendMessage(message.key.remoteJid, { sticker: stickerBuffer });
  } catch (error) {
    await reply("❌ The media could not be downloaded.");
    throw error;
  }
}
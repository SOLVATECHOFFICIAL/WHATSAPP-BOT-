import { extractTextFromImage } from "../lib/ai-engine.js";
import { downloadMessageMedia, getQuotedMessage, mediaTypeFromMessage, unwrapMediaMessage } from "../lib/helpers.js";
import { logger } from "../lib/logger.js";

export default async function read({ sock, message, reply }) {
  const source = getQuotedMessage(message) || message;
  const content = unwrapMediaMessage(source);
  const type = mediaTypeFromMessage(source);

  const isImage =
    type === "image" ||
    Boolean(content?.imageMessage) ||
    content?.documentMessage?.mimetype?.startsWith("image/");

  if (!isImage) {
    return reply("❌ Reply to an image or send an image with *.read* to extract its text.");
  }

  try {
    const buffer = await downloadMessageMedia(source, "imageMessage", sock);
    if (!buffer || buffer.length === 0) {
      return reply("❌ Could not download the image media for text extraction.");
    }

    const extractedText = await extractTextFromImage(buffer);

    if (!extractedText) {
      return reply("🔍 *OCR Result:* _No readable text detected in this image._");
    }

    await reply(
      [
        "╭━━〔 📖 *VERBATIM OCR EXTRACTED TEXT* 〕━━╮",
        "",
        extractedText,
        "",
        "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
      ].join("\n")
    );
  } catch (error) {
    logger.error("OCR extraction failed", error);
    await reply(`❌ *OCR Extraction Failed:* ${error.message || "Failed to process image"}`);
  }
}

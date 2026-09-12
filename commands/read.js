import { GoogleGenAI } from "@google/genai";
import { downloadMessageMedia, getQuotedMessage, mediaTypeFromMessage, unwrapMediaMessage } from "../lib/helpers.js";
import { logger } from "../lib/logger.js";

let aiClient = null;

function getAIClient() {
  if (!aiClient) {
    aiClient = new GoogleGenAI({});
  }
  return aiClient;
}

const OCR_MODELS = ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.6-flash"];

export default async function read({ sock, message, reply }) {
  const source = getQuotedMessage(message) || message;
  const content = unwrapMediaMessage(source);
  const type = mediaTypeFromMessage(source);

  if (type !== "image" && !content.imageMessage) {
    return reply("❌ Reply to an image or send an image with *.read* to extract its text.");
  }

  try {
    const buffer = await downloadMessageMedia(source, "imageMessage");
    if (!buffer || buffer.length === 0) {
      return reply("❌ Could not download the image media for text extraction.");
    }

    const mimeType = content.imageMessage?.mimetype || "image/jpeg";
    const ai = getAIClient();

    let extractedText = "";
    let lastError = null;

    for (const model of OCR_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              inlineData: {
                mimeType: mimeType.split(";")[0],
                data: buffer.toString("base64"),
              },
            },
            {
              text: "Extract and transcribe all visible text from this image VERBATIM without translating, summarizing, correcting, or adding commentary. Return ONLY the exact transcribed text as it appears in the image. If there is no visible text in the image, reply with: [NO TEXT DETECTED IN IMAGE]",
            },
          ],
        });

        extractedText = (response.text || "").trim();
        if (extractedText) break;
      } catch (err) {
        lastError = err;
        logger.warn(`OCR model ${model} failed, trying next`, err.message);
      }
    }

    if (!extractedText && lastError) {
      throw lastError;
    }

    if (!extractedText || extractedText === "[NO TEXT DETECTED IN IMAGE]") {
      return reply("🔍 *OCR Result:* No readable text was detected in this image.");
    }

    await reply([
      "📖 *VERBATIM OCR EXTRACTED TEXT*",
      "────────────────────────────",
      extractedText,
    ].join("\n"));
  } catch (error) {
    logger.error("OCR extraction failed", error);
    await reply(`❌ OCR extraction failed: ${error.message || "Failed to process image"}`);
  }
}

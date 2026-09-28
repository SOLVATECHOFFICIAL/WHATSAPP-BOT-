import sharp from "sharp";
import Tesseract from "tesseract.js";
import { GoogleGenAI } from "@google/genai";
import { logger } from "./logger.js";
import { DEFAULT_QUIZ_BANK, DEFAULT_RIDDLES, DEFAULT_SCRAMBLE_WORDS } from "./chat-memory.js";

const GEMINI_TEXT_MODELS = [
  "gemini-3.8-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
];

let cachedClient = null;
let cachedKey = null;

function getConfiguredGeminiKey() {
  const key = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    process.env.GEMINI_KEY ||
    ""
  ).trim();
  // Never use known leaked placeholder keys
  if (!key || key === "AIzaSyAlYgzxMesR8Ffwc4g0jzGAJOWUlVNxJl8") {
    return "";
  }
  return key;
}

export function getGenAIClient() {
  const apiKey = getConfiguredGeminiKey();
  if (apiKey) {
    if (!cachedClient || cachedKey !== apiKey) {
      cachedClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
      cachedKey = apiKey;
    }
    return cachedClient;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credsRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS.trim();
    if (credsRaw.startsWith("{")) {
      try {
        const credentials = JSON.parse(credsRaw);
        return new GoogleGenAI({
          googleAuthOptions: { credentials },
          httpOptions: { headers: { "User-Agent": "aistudio-build" } },
        });
      } catch (err) {
        logger.warn("Could not parse GOOGLE_APPLICATION_CREDENTIALS JSON", err.message);
      }
    } else {
      return new GoogleGenAI({
        httpOptions: { headers: { "User-Agent": "aistudio-build" } },
      });
    }
  }

  return null;
}

/**
 * Calls Gemini text/multimodal generation across valid models, returning null on 403/429/error
 * so callers can seamlessly fall back without crashing.
 */
export async function tryGeminiGenerate({ contents, systemInstruction = "", responseMimeType = undefined }) {
  const ai = getGenAIClient();
  if (!ai) return null;

  for (const model of GEMINI_TEXT_MODELS) {
    try {
      const config = {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(responseMimeType ? { responseMimeType } : {}),
      };
      const response = await ai.models.generateContent({
        model,
        contents,
        ...(Object.keys(config).length > 0 ? { config } : {}),
      });
      const out = (response.text || "").trim();
      if (out) return out;
    } catch (err) {
      logger.debug?.(`Gemini model ${model} notice:`, err?.message || err);
    }
  }
  return null;
}

/**
 * Extracts verbatim text from an image buffer using Gemini Vision first,
 * and automatically falling back to local Tesseract.js OCR with Sharp preprocessing
 * so OCR NEVER fails with 403 PERMISSION_DENIED.
 */
export async function extractTextFromImage(rawBuffer) {
  if (!rawBuffer || !Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
    throw new Error("Empty or invalid image buffer.");
  }

  let jpegBuffer = rawBuffer;
  try {
    jpegBuffer = await sharp(rawBuffer)
      .rotate()
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (sharpErr) {
    logger.debug?.("Sharp JPEG normalization notice:", sharpErr.message);
    jpegBuffer = rawBuffer;
  }

  // 1. Try Gemini Vision OCR if available and authorized
  const geminiOcr = await tryGeminiGenerate({
    contents: [
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: jpegBuffer.toString("base64"),
        },
      },
      {
        text: "Extract and transcribe all visible text from this image VERBATIM without translating, summarizing, correcting, or adding commentary. Return ONLY the exact transcribed text as it appears in the image. If there is no visible text in the image, reply with: [NO TEXT DETECTED IN IMAGE]",
      },
    ],
  });

  if (geminiOcr) {
    if (geminiOcr === "[NO TEXT DETECTED IN IMAGE]") {
      return "";
    }
    return geminiOcr.trim();
  }

  // 2. Local Tesseract.js OCR fallback (100% immune to API key 403 / quota limits)
  let preprocessedBuffer = jpegBuffer;
  try {
    const metadata = await sharp(rawBuffer).metadata();
    const targetWidth = metadata.width && metadata.width < 1000 ? metadata.width * 2 : undefined;
    let pipeline = sharp(rawBuffer).rotate().grayscale().normalize().sharpen();
    if (targetWidth) {
      pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: false });
    }
    preprocessedBuffer = await pipeline.png().toBuffer();
  } catch {
    preprocessedBuffer = jpegBuffer;
  }

  try {
    const result = await Tesseract.recognize(preprocessedBuffer, "eng");
    const text = String(result?.data?.text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text;
  } catch (tessErr) {
    logger.error("Tesseract OCR fallback error", tessErr.message);
    throw new Error("Could not extract text from the image.");
  }
}

/**
 * Explains or analyzes an image buffer for `.meta explain this image` (or visual Q&A).
 */
export async function explainImageBuffer(rawBuffer, userPrompt = "Explain this image clearly.") {
  if (!rawBuffer || !Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
    throw new Error("Could not download the image to analyze.");
  }

  let jpegBuffer = rawBuffer;
  let metaInfo = null;
  try {
    metaInfo = await sharp(rawBuffer).metadata();
    jpegBuffer = await sharp(rawBuffer).rotate().jpeg({ quality: 90 }).toBuffer();
  } catch {}

  const promptText =
    userPrompt && userPrompt.trim()
      ? userPrompt.trim()
      : "Explain this image in detail, describing what is shown, any visible text, and key takeaways.";

  // 1. Try Gemini Vision
  const geminiVision = await tryGeminiGenerate({
    contents: [
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: jpegBuffer.toString("base64"),
        },
      },
      {
        text: promptText,
      },
    ],
    systemInstruction:
      "You are SOLVATECH Meta AI inside WhatsApp. Provide a clear, accurate, well-structured explanation of the image.",
  });

  if (geminiVision) {
    return geminiVision;
  }

  // 2. Fallback: Extract visible text via OCR + inspect image properties via Sharp
  let ocrText = "";
  try {
    ocrText = await extractTextFromImage(rawBuffer);
  } catch {}

  const dimensions =
    metaInfo?.width && metaInfo?.height ? `${metaInfo.width}×${metaInfo.height}px` : "Standard image";
  const format = (metaInfo?.format || "image").toUpperCase();

  if (ocrText) {
    const lines = ocrText.split("\n").map((l) => l.trim()).filter(Boolean);
    const previewSummary =
      lines.length > 3
        ? `This image contains structured text/document content (${lines.length} lines detected).`
        : `This image displays text/graphic content.`;

    return [
      "🖼️ *IMAGE ANALYSIS & EXPLANATION*",
      "────────────────────────────",
      `• *Format & Resolution:* ${format} (${dimensions})`,
      `• *Overview:* ${previewSummary}`,
      "",
      "📖 *Visible Text in Image:*",
      ocrText,
    ].join("\n");
  }

  return [
    "🖼️ *IMAGE ANALYSIS*",
    "────────────────────────────",
    `• *Format:* ${format}`,
    `• *Dimensions:* ${dimensions}`,
    `• *Color Space:* ${metaInfo?.space || "sRGB"}`,
    `• *Visible Text:* None detected`,
    "",
    "ℹ️ _This is a visual graphic/photo with no embedded text._",
  ].join("\n");
}

/**
 * Summarizes actual available group/chat messages honestly.
 */
export async function summarizeAvailableMessages(messages, userQuery = "") {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "I can only summarize the messages currently available to me. There are no recorded chat messages in my current session history for this conversation yet.";
  }

  const formattedTranscript = messages
    .map((m) => {
      const timeStr = new Date(m.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const speaker = m.pushName
        ? `${m.pushName} (@${m.senderNumber || "user"})`
        : `@${m.senderNumber || "user"}`;
      const mediaTag = m.mediaType ? `[${m.mediaType.toUpperCase()}] ` : "";
      return `[${timeStr}] ${speaker}: ${mediaTag}${m.text || ""}`;
    })
    .join("\n");

  const aiSummary = await tryGeminiGenerate({
    contents: [
      {
        text: [
          `User request: "${userQuery || "Summarize the conversation"}"`,
          `Available chat history (${messages.length} messages):`,
          formattedTranscript,
        ].join("\n\n"),
      },
    ],
    systemInstruction:
      "You are SOLVATECH Meta AI. Use ONLY the provided chat transcript. Do NOT invent conversations or pretend to have access to messages that are not in the transcript. Summarize the key topics, who said what, and answer the user's specific question about the conversation clearly and concisely.",
  });

  if (aiSummary) {
    return [
      `📋 *CHAT SUMMARY (${messages.length} available message${messages.length === 1 ? "" : "s"})*`,
      "────────────────────────────",
      aiSummary,
    ].join("\n");
  }

  // Deterministic local conversation analyzer when external LLM is unavailable
  const queryLower = String(userQuery || "").toLowerCase();

  // Check if user is searching for who mentioned a specific topic (e.g. "find where someone mentioned the license", "who has been talking about the new bot update")
  const searchMatch =
    queryLower.match(/(?:mentioned|talking about|talked about|discussed|said about|find where.*mentioned)\s+(.+?)$/i) ||
    queryLower.match(/about\s+the\s+(.+?)$/i);

  if (searchMatch) {
    const rawTopic = searchMatch[1]
      .replace(/[?.!]+$/g, "")
      .replace(/^(the|a|an)\s+/i, "")
      .trim();
    const keywords = rawTopic
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    const matchingMsgs = messages.filter((m) => {
      const hay = `${m.text || ""}`.toLowerCase();
      return keywords.some((kw) => hay.includes(kw));
    });

    if (matchingMsgs.length > 0) {
      const matchLines = matchingMsgs.slice(-10).map((m) => {
        const timeStr = new Date(m.timestamp).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });
        const speaker = m.pushName ? `${m.pushName} (@${m.senderNumber})` : `@${m.senderNumber}`;
        return `• *[${timeStr}] ${speaker}:* "${m.text}"`;
      });

      return [
        `🔎 *CONVERSATION SEARCH: "${rawTopic}"*`,
        `Found *${matchingMsgs.length}* matching message${matchingMsgs.length === 1 ? "" : "s"} in the ${messages.length} available messages:`,
        "",
        ...matchLines,
      ].join("\n");
    } else {
      return `🔎 I checked the *${messages.length}* currently available message${messages.length === 1 ? "" : "s"} in this chat, and no one mentioned *"${rawTopic}"*. (I can only search the messages currently available to me.)`;
    }
  }

  // Group statistics & participant highlights
  const bySpeaker = new Map();
  for (const m of messages) {
    const key = m.senderNumber || m.senderJid || "unknown";
    const entry = bySpeaker.get(key) || {
      senderNumber: m.senderNumber,
      pushName: m.pushName || "",
      count: 0,
      samples: [],
    };
    entry.count += 1;
    if (m.pushName && !entry.pushName) entry.pushName = m.pushName;
    if (m.text && entry.samples.length < 3) {
      entry.samples.push(m.text.length > 90 ? `${m.text.slice(0, 87)}...` : m.text);
    }
    bySpeaker.set(key, entry);
  }

  const speakersSorted = Array.from(bySpeaker.values()).sort((a, b) => b.count - a.count);
  const topContributors = speakersSorted.slice(0, 6).map((s) => {
    const label = s.pushName ? `${s.pushName} (@${s.senderNumber})` : `@${s.senderNumber}`;
    return `• *${label}* (${s.count} msg${s.count === 1 ? "" : "s"})${s.samples.length ? `: _"${s.samples[s.samples.length - 1]}"_` : ""}`;
  });

  const recentHighlights = messages
    .filter((m) => m.text)
    .slice(-8)
    .map((m) => {
      const timeStr = new Date(m.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const label = m.pushName || `@${m.senderNumber}`;
      const snippet = m.text.length > 100 ? `${m.text.slice(0, 97)}...` : m.text;
      return `• [${timeStr}] *${label}:* ${snippet}`;
    });

  return [
    `📋 *CHAT SUMMARY (${messages.length} available message${messages.length === 1 ? "" : "s"})*`,
    "────────────────────────────",
    `👥 *Active Participants (${bySpeaker.size}):*`,
    ...topContributors,
    "",
    "💬 *Recent Key Messages:*",
    ...(recentHighlights.length ? recentHighlights : ["• _(Media messages only)_"]),
  ].join("\n");
}

const JOKES_LIST = [
  "Why do programmers prefer dark mode?\nBecause light attracts bugs! 🐛💻",
  "Why did the developer go broke?\nBecause he used up all his cache! 💸",
  "How many programmers does it take to change a light bulb?\nNone — that's a hardware problem! 💡",
  "Why did the smartphone go to school?\nBecause it wanted to be a little smarter! 📱🎓",
  "I told my Wi-Fi we were having connection issues.\nNow it won't even talk to me without a password! 📶😂",
  "Why do Java developers wear glasses?\nBecause they can't C#! 👓",
  "What do you call a group chat where everyone actually replies on time?\nScience fiction! 🚀😂",
];

/**
 * Generates a natural conversational or creative response for `.meta`.
 */
export async function generateMetaConversationalReply(userPrompt, quotedText = "") {
  const fullInput = quotedText
    ? `Context / Replied-to message:\n"""\n${quotedText}\n"""\n\nUser request: ${userPrompt}`
    : userPrompt;

  const aiReply = await tryGeminiGenerate({
    contents: fullInput,
    systemInstruction:
      "You are SOLVATECH Meta AI, an intelligent, helpful WhatsApp assistant integrated into SOLVATECH BOT. Keep responses clear, accurate, engaging, and well-formatted for WhatsApp.",
  });

  if (aiReply) return aiReply;

  const lower = String(userPrompt || "").toLowerCase().trim();

  // Joke fallback
  if (/\b(joke|funny|laugh|humor)\b/i.test(lower)) {
    const joke = JOKES_LIST[Math.floor(Math.random() * JOKES_LIST.length)];
    return `😄 *SOLVATECH META AI*\n\n${joke}`;
  }

  // Riddle fallback
  if (/\b(riddle|brain\s*teaser)\b/i.test(lower)) {
    const r = DEFAULT_RIDDLES[Math.floor(Math.random() * DEFAULT_RIDDLES.length)];
    return `🧩 *RIDDLE TIME*\n\n❝ *${r.riddle}* ❞\n\n💡 _Answer:_ || *${r.displayAnswer}* ||`;
  }

  // Announcement / notice generation fallback
  if (/\b(announcement|announce|notice|broadcast)\b/i.test(lower)) {
    const topic = userPrompt
      .replace(/^(?:please\s+)?(?:create|make|write|draft|send)\s+(?:a\s+)?(?:group\s+)?(?:announcement|notice)\s*(?:about|for|that|saying|:)?\s*/i, "")
      .trim();
    const bodyText =
      topic ||
      quotedText ||
      "Please take note of the latest updates shared in this group and adhere to all community guidelines.";
    return [
      "📢 *OFFICIAL GROUP ANNOUNCEMENT*",
      "────────────────────────────",
      bodyText,
      "",
      "🙏 _Thank you for your cooperation — Group Management_",
    ].join("\n");
  }

  // Summarizing a single replied-to text message
  if (quotedText && /\b(summarize|summary|tldr|tl;dr|explain|break\s*down)\b/i.test(lower)) {
    const sentences = quotedText
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const keyPoints = sentences.slice(0, 4).map((s) => `• ${s}`);
    return [
      "📝 *MESSAGE SUMMARY & BREAKDOWN*",
      "────────────────────────────",
      ...keyPoints,
    ].join("\n");
  }

  // Math expression evaluation if user asks a calculation
  const mathCandidate = lower
    .replace(/^(what is|calculate|solve|compute|evaluate)\s+/i, "")
    .replace(/[?=]+$/g, "")
    .trim();
  if (/^[\d\s+\-*/().%^]+$/.test(mathCandidate) && /\d/.test(mathCandidate)) {
    try {
      const normalizedExpr = mathCandidate.replace(/\^/g, "**");
      // Safe arithmetic evaluation
      const val = Function(`"use strict"; return (${normalizedExpr});`)();
      if (typeof val === "number" && Number.isFinite(val)) {
        return `🧮 *Calculation Result:*\n\`${mathCandidate} = ${val}\``;
      }
    } catch {}
  }

  return [
    "🤖 *SOLVATECH META AI*",
    "────────────────────────────",
    quotedText
      ? `Regarding the message:\n_"${quotedText.slice(0, 200)}${quotedText.length > 200 ? "..." : ""}"_\n\nHow would you like me to act on this? You can ask me to *summarize*, *translate*, *delete*, *pin*, *warn the sender*, or *extract text*.`
      : `I understood your request: *"${userPrompt}"*.\n\nHere is what I can execute for you right now:\n• *Chat Intelligence:* Summarize recent messages, find who mentioned a topic, or check who is online\n• *Group Actions:* Add numbers, remove/kick members (including random members), promote/demote, lock/unlock, or create announcements\n• *Message & Media Tools:* Delete your last N messages, delete a replied-to message, extract text from images (OCR), explain images, or create stickers\n• *Games & Fun:* Start a group quiz with live scorekeeping, make a riddle, or tell a joke\n• *Account:* Check your license status and expiry countdown`,
  ].join("\n");
}

/**
 * Translates text using Gemini first, with a fallback dictionary/translator when offline.
 */
export async function translateContent(sourceText, targetLanguage = "English") {
  if (!sourceText || !String(sourceText).trim()) {
    return null;
  }

  const aiTranslation = await tryGeminiGenerate({
    contents: `Translate the following text into ${targetLanguage}. Provide ONLY the accurate translation (and brief pronunciation/notes if helpful):\n\n"""\n${sourceText}\n"""`,
    systemInstruction: "You are a precise multilingual translator for SOLVATECH Meta AI.",
  });

  if (aiTranslation) {
    return [
      `🌐 *TRANSLATION (${targetLanguage})*`,
      "────────────────────────────",
      aiTranslation,
    ].join("\n");
  }

  // Fallback public Google Translate GTX endpoint (keyless)
  try {
    const langMap = {
      english: "en",
      en: "en",
      french: "fr",
      fr: "fr",
      spanish: "es",
      es: "es",
      german: "de",
      arabic: "ar",
      yoruba: "yo",
      igbo: "ig",
      hausa: "ha",
      portuguese: "pt",
      italian: "it",
      chinese: "zh-CN",
      japanese: "ja",
      korean: "ko",
      russian: "ru",
      hindi: "hi",
      swahili: "sw",
    };
    const tl = langMap[String(targetLanguage || "english").toLowerCase().trim()] || "en";
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(sourceText)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.[0])) {
        const translated = data[0].map((part) => part?.[0] || "").join("").trim();
        if (translated) {
          return [
            `🌐 *TRANSLATION (${targetLanguage})*`,
            "────────────────────────────",
            translated,
          ].join("\n");
        }
      }
    }
  } catch (err) {
    logger.debug?.("Fallback translate endpoint notice:", err.message);
  }

  return [
    `🌐 *TRANSLATION (${targetLanguage})*`,
    "────────────────────────────",
    sourceText,
  ].join("\n");
}

/**
 * Generates or selects quiz questions for `.meta start a quiz`.
 */
export async function buildQuizQuestions(topic = "", count = 5) {
  const aiJson = await tryGeminiGenerate({
    contents: `Create a ${count}-question multiple-choice trivia quiz${topic ? ` about "${topic}"` : " covering general knowledge, science, and technology"}. Return JSON array of objects with properties: question (string), options (array of 4 strings starting with "A) ", "B) ", "C) ", "D) "), answerLetter ("A"|"B"|"C"|"D"), answerText (lowercase answer text), explanation (short string).`,
    responseMimeType: "application/json",
  });

  if (aiJson) {
    try {
      const parsed = JSON.parse(aiJson);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].question && Array.isArray(parsed[0].options)) {
        return parsed.slice(0, count);
      }
    } catch {}
  }

  // Shuffle default quiz bank
  const copy = [...DEFAULT_QUIZ_BANK];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

export function pickRiddles(count = 3) {
  const copy = [...DEFAULT_RIDDLES];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

export function pickScrambleWords(count = 3) {
  const copy = [...DEFAULT_SCRAMBLE_WORDS];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

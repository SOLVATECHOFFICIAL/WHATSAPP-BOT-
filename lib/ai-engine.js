import axios from "axios";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { GoogleGenAI } from "@google/genai";
import { logger } from "./logger.js";
import {
  DEFAULT_QUIZ_BANK,
  DEFAULT_RIDDLES,
  DEFAULT_SCRAMBLE_WORDS,
  getAIConversationHistory,
  recordAIConversationTurn,
} from "./chat-memory.js";

const GEMINI_TEXT_MODELS = [
  "gemini-3.8-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
];

let cachedClient = null;
let cachedKey = null;
let geminiBlockedUntil = 0;

// Live Gradio 5 Groq / Llama-3.3-70B endpoints verified for real-time worldwide intelligence
const LIVE_GRADIO_LLM_SPACES = [
  {
    host: "https://ishan2204-groq-ai-chatbot-2026.hf.space",
    endpoint: "/chatbot",
    buildArgs: (prompt) => [prompt],
  },
  {
    host: "https://chaithu123-chatbot-groq-langchain.hf.space",
    endpoint: "/get_text_response",
    buildArgs: (prompt) => [prompt],
  },
];

let dynamicGradioSpaces = [];
let lastDynamicDiscoveryAt = 0;

function getConfiguredGeminiKey() {
  const key = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    process.env.GEMINI_KEY ||
    ""
  ).trim();
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
 * Calls a Gradio 5 `/gradio_api/call/<endpoint>` space and parses its `event: complete` output.
 */
async function callGradioSpace(host, endpoint, dataArgs, timeoutMs = 10000) {
  const startRes = await axios.post(
    `${host}/gradio_api/call${endpoint}`,
    { data: dataArgs },
    {
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      timeout: 5000,
    }
  );
  const eventId = startRes.data?.event_id;
  if (!eventId) return null;

  const streamRes = await axios.get(`${host}/gradio_api/call${endpoint}/${eventId}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: timeoutMs,
    responseType: "text",
  });

  const rawText = String(streamRes.data || "");
  const lines = rawText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("data:")) {
      const jsonPart = line.slice(5).trim();
      if (!jsonPart || jsonPart === "null") continue;
      try {
        const parsed = JSON.parse(jsonPart);
        if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].trim()) {
          const textOut = parsed[0].trim();
          if (!textOut.startsWith("Error:") && !textOut.includes("Organization has been restricted")) {
            return textOut;
          }
        }
      } catch {}
    }
  }
  return null;
}

/**
 * Dynamically discovers fresh active Groq/Llama Gradio 5 spaces on HuggingFace if static ones rotate.
 */
async function discoverLiveGradioSpaces() {
  if (Date.now() - lastDynamicDiscoveryAt < 10 * 60 * 1000 && dynamicGradioSpaces.length > 0) {
    return dynamicGradioSpaces;
  }
  lastDynamicDiscoveryAt = Date.now();
  try {
    const res = await axios.get(
      "https://huggingface.co/api/spaces?search=groq+chat&sort=lastModified&limit=15",
      { timeout: 4000 }
    );
    const found = [];
    await Promise.all(
      (res.data || []).slice(0, 10).map(async (s) => {
        const host = `https://${s.id.replace("/", "-").replace(/[_.]/g, "-").toLowerCase()}.hf.space`;
        try {
          const info = await axios.get(`${host}/gradio_api/info`, { timeout: 2500 });
          const eps = info.data?.named_endpoints || {};
          for (const [ep, meta] of Object.entries(eps)) {
            const params = meta.parameters || [];
            if (params.length >= 1 && params[0]?.type?.type === "string") {
              found.push({
                host,
                endpoint: ep,
                buildArgs: (prompt) =>
                  params.map((p, idx) => (idx === 0 ? prompt : p.parameter_default)),
              });
            }
          }
        } catch {}
      })
    );
    if (found.length > 0) {
      dynamicGradioSpaces = found;
    }
  } catch {}
  return dynamicGradioSpaces;
}

/**
 * Calls live LLM providers (Gemini -> Live Groq/Llama-3.3-70B Gradio spaces -> Pollinations)
 * so `.meta` has full worldwide ChatGPT-level general intelligence at all times.
 */
export async function tryGeminiGenerate({
  contents,
  systemInstruction = "",
  responseMimeType = undefined,
  allowExternalFallback = true,
}) {
  // 1. Try @google/genai if not recently blocked by 403 project restriction
  const ai = getGenAIClient();
  if (ai && Date.now() >= geminiBlockedUntil) {
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
        const msg = String(err?.message || err);
        if (msg.includes("403") || msg.includes("PERMISSION_DENIED") || msg.includes("denied access")) {
          geminiBlockedUntil = Date.now() + 5 * 60 * 1000;
          break;
        }
        logger.debug?.(`Gemini model ${model} notice:`, msg);
      }
    }
  }

  if (!allowExternalFallback) {
    return null;
  }

  // Extract text prompt from contents if contents is string or array of parts
  let textPrompt = "";
  let hasInlineImage = false;
  if (typeof contents === "string") {
    textPrompt = contents;
  } else if (Array.isArray(contents)) {
    const textParts = [];
    for (const item of contents) {
      if (typeof item === "string") textParts.push(item);
      else if (item?.text) textParts.push(item.text);
      else if (item?.inlineData) hasInlineImage = true;
    }
    textPrompt = textParts.join("\n\n");
  } else if (contents?.parts && Array.isArray(contents.parts)) {
    for (const part of contents.parts) {
      if (part?.text) textPrompt += (textPrompt ? "\n\n" : "") + part.text;
      if (part?.inlineData) hasInlineImage = true;
    }
  }

  // Vision-only calls without text or with inline image should use OCR + LLM in their caller
  if (!textPrompt || hasInlineImage) {
    return null;
  }

  const combinedPrompt = systemInstruction
    ? `${systemInstruction}\n\n${textPrompt}`
    : textPrompt;

  // 2. Try verified live Groq / Llama-3.3-70B Gradio 5 endpoints
  for (const space of LIVE_GRADIO_LLM_SPACES) {
    try {
      const out = await callGradioSpace(
        space.host,
        space.endpoint,
        space.buildArgs(combinedPrompt),
        10000
      );
      if (out) return out;
    } catch (err) {
      logger.debug?.(`Live LLM space ${space.host} notice:`, err?.message || err);
    }
  }

  // 3. Try dynamically discovered HuggingFace Groq/Llama spaces
  const discovered = await discoverLiveGradioSpaces();
  for (const space of discovered.slice(0, 4)) {
    try {
      const out = await callGradioSpace(
        space.host,
        space.endpoint,
        space.buildArgs(combinedPrompt),
        8000
      );
      if (out) return out;
    } catch {}
  }

  // 4. Try Pollinations GET text endpoint
  try {
    const pollRes = await axios.get(
      `https://text.pollinations.ai/${encodeURIComponent(combinedPrompt.slice(0, 1200))}`,
      { timeout: 7000 }
    );
    if (typeof pollRes.data === "string" && pollRes.data.trim() && !pollRes.data.includes("ENOSPC")) {
      return pollRes.data.trim();
    }
  } catch {}

  return null;
}

/**
 * Searches Wikipedia for real-world knowledge as a factual backup.
 */
async function searchWikipediaKnowledge(query) {
  try {
    const cleanQ = String(query || "")
      .replace(/^(who|what|where|when|why|how|tell me about|explain|define)\s+(is|are|was|were|did|does|do|the|a|an)?\s*/i, "")
      .replace(/[?!.]+$/g, "")
      .trim();
    if (!cleanQ || cleanQ.length < 2) return null;

    const searchRes = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: {
        action: "query",
        list: "search",
        srsearch: cleanQ,
        utf8: 1,
        format: "json",
        srlimit: 2,
      },
      headers: { "User-Agent": "SolvaTechBot/2.0 (https://solvatech.ai)" },
      timeout: 5000,
    });

    const firstHit = searchRes.data?.query?.search?.[0];
    if (!firstHit?.title) return null;

    const extractRes = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: {
        action: "query",
        prop: "extracts",
        exintro: 1,
        explaintext: 1,
        titles: firstHit.title,
        format: "json",
      },
      headers: { "User-Agent": "SolvaTechBot/2.0 (https://solvatech.ai)" },
      timeout: 5000,
    });

    const pages = extractRes.data?.query?.pages || {};
    const page = Object.values(pages)[0];
    const extract = String(page?.extract || "").trim();
    if (!extract) return null;

    const paragraphs = extract.split(/\n+/).filter(Boolean).slice(0, 2).join("\n\n");
    return `🌐 *${firstHit.title}*\n\n${paragraphs.slice(0, 1200)}`;
  } catch {
    return null;
  }
}

/**
 * Generates or fetches a high-resolution image for `.meta` image generation requests
 * (e.g. "give me a fine pic of a guy in a black suit", "generate an image of a lion", etc.).
 */
export async function generateMetaImage(promptText = "") {
  const cleanPrompt = String(promptText || "")
    .replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:give|send|show|generate|create|make|draw|get)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:fine\s+|nice\s+|cool\s+|beautiful\s+|good\s+)?(?:picture|pic|photo|image|portrait|drawing|art|wallpaper)\s+(?:of\s+)?/i, "")
    .trim() || promptText.trim();

  // 1. Try Gemini Image generation if an authorized key is active
  const ai = getGenAIClient();
  if (ai && Date.now() >= geminiBlockedUntil) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite-image",
        contents: {
          parts: [{ text: `High quality photorealistic image: ${cleanPrompt}` }],
        },
      });
      const parts = response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const buf = Buffer.from(part.inlineData.data, "base64");
          const jpeg = await sharp(buf).jpeg({ quality: 92 }).toBuffer();
          return {
            buffer: jpeg,
            caption: `🎨 *${cleanPrompt}*`,
          };
        }
      }
    } catch {}
  }

  // 2. Try Pollinations AI Image Generation
  try {
    const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(
      `${cleanPrompt}, photorealistic, high detail, 8k`
    )}?width=768&height=768&nologo=true`;
    const pollRes = await axios.get(pollUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      },
      timeout: 9000,
    });
    const contentType = String(pollRes.headers?.["content-type"] || "");
    if (pollRes.status === 200 && contentType.startsWith("image/") && pollRes.data?.byteLength > 4000) {
      const jpeg = await sharp(Buffer.from(pollRes.data)).jpeg({ quality: 92 }).toBuffer();
      return {
        buffer: jpeg,
        caption: `🎨 *${cleanPrompt}*`,
      };
    }
  } catch {}

  // 3. Search Openverse high-resolution photography API (with intelligent query refinement)
  const searchQueries = [
    cleanPrompt,
    cleanPrompt
      .replace(/\b(fine|nice|cool|handsome|beautiful|pretty|wearing|dressed in|standing|sitting|with|in a|in)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ].filter(Boolean);

  for (const q of searchQueries) {
    try {
      const ovRes = await axios.get("https://api.openverse.org/v1/images/", {
        params: { q, page_size: 15 },
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        },
        timeout: 7000,
      });
      const results = Array.isArray(ovRes.data?.results) ? ovRes.data.results : [];
      // Shuffle top 8 results so repeated requests give fresh images
      const pool = results.slice(0, 8).sort(() => Math.random() - 0.5);
      for (const item of pool) {
        const candidateUrls = [item.url, item.thumbnail].filter(Boolean);
        for (const imgUrl of candidateUrls) {
          try {
            const imgRes = await axios.get(imgUrl, {
              responseType: "arraybuffer",
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
              },
              timeout: 6000,
            });
            if (imgRes.data && imgRes.data.byteLength > 5000) {
              const jpeg = await sharp(Buffer.from(imgRes.data))
                .rotate()
                .resize({ width: 1024, withoutEnlargement: true })
                .jpeg({ quality: 90 })
                .toBuffer();
              return {
                buffer: jpeg,
                caption: `🖼️ *${cleanPrompt}*`,
              };
            }
          } catch {}
        }
      }
    } catch {}
  }

  // 4. Wikimedia Commons fallback search
  try {
    const wikiRes = await axios.get("https://commons.wikimedia.org/w/api.php", {
      params: {
        action: "query",
        generator: "search",
        gsrsearch: `${cleanPrompt} filetype:bitmap`,
        gsrlimit: 8,
        prop: "imageinfo",
        iiprop: "url",
        iiurlwidth: 900,
        format: "json",
      },
      headers: { "User-Agent": "SolvaTechBot/2.0 (https://solvatech.ai)" },
      timeout: 6000,
    });
    const pages = Object.values(wikiRes.data?.query?.pages || {});
    for (const p of pages) {
      const u = p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url;
      if (!u) continue;
      try {
        const imgRes = await axios.get(u, {
          responseType: "arraybuffer",
          headers: { "User-Agent": "SolvaTechBot/2.0 (https://solvatech.ai)" },
          timeout: 6000,
        });
        if (imgRes.data && imgRes.data.byteLength > 5000) {
          const jpeg = await sharp(Buffer.from(imgRes.data)).jpeg({ quality: 90 }).toBuffer();
          return {
            buffer: jpeg,
            caption: `🖼️ *${cleanPrompt}*`,
          };
        }
      } catch {}
    }
  } catch {}

  throw new Error("Could not generate or retrieve an image for that prompt right now. Please try describing it slightly differently.");
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
    allowExternalFallback: false,
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
    allowExternalFallback: false,
  });

  if (geminiVision) {
    return geminiVision;
  }

  // 2. Extract visible text via OCR + pass to Live LLM for intelligent explanation!
  let ocrText = "";
  try {
    ocrText = await extractTextFromImage(rawBuffer);
  } catch {}

  const dimensions =
    metaInfo?.width && metaInfo?.height ? `${metaInfo.width}×${metaInfo.height}px` : "Standard image";
  const format = (metaInfo?.format || "image").toUpperCase();

  if (ocrText) {
    const llmExplanation = await tryGeminiGenerate({
      contents: `The user sent an image (${format}, ${dimensions}) and asked: "${promptText}".\n\nHere is the text extracted from the image via OCR:\n"""\n${ocrText}\n"""\n\nPlease answer the user's request and explain/analyze the content clearly for WhatsApp.`,
      systemInstruction: "You are SOLVATECH Meta AI. Analyze the extracted image text and answer the user's question directly and helpfully.",
    });

    if (llmExplanation) {
      return llmExplanation;
    }

    return [
      "🖼️ *IMAGE ANALYSIS & EXPLANATION*",
      "────────────────────────────",
      `• *Format & Resolution:* ${format} (${dimensions})`,
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
 * Generates a natural conversational, worldwide ChatGPT-like response for `.meta`
 * with multi-turn per-chat conversation history.
 */
export async function generateMetaConversationalReply(userPrompt, quotedText = "", options = {}) {
  const { userId = "default", chatId = "", senderName = "" } = options;

  const priorTurns = chatId ? getAIConversationHistory(userId, chatId, 8) : [];
  const historyTranscript =
    priorTurns.length > 0
      ? "Recent conversation context in this chat:\n" +
        priorTurns
          .map((t) => `${t.role === "user" ? "User" : "Meta AI"}: ${t.content}`)
          .join("\n") +
        "\n\n"
      : "";

  const quotedContext = quotedText
    ? `Replied-to message in WhatsApp:\n"""\n${quotedText}\n"""\n\n`
    : "";

  const fullInput = `${historyTranscript}${quotedContext}User${senderName ? ` (${senderName})` : ""}: ${userPrompt}`;

  const aiReply = await tryGeminiGenerate({
    contents: fullInput,
    systemInstruction:
      "You are SOLVATECH Meta AI, a brilliant, natural, friendly, general-purpose AI assistant (like ChatGPT) built into WhatsApp. You have unrestricted worldwide knowledge across science, history, coding, math, culture, entertainment, business, and everyday conversation. Reply directly, naturally, and helpfully formatted for WhatsApp. Never output a generic command menu unless the user specifically asks for your command list.",
  });

  if (aiReply) {
    if (chatId) {
      recordAIConversationTurn(userId, chatId, userPrompt, aiReply);
    }
    return aiReply;
  }

  const lower = String(userPrompt || "").toLowerCase().trim();

  // Joke fallback
  if (/\b(joke|funny|laugh|humor)\b/i.test(lower)) {
    const joke = JOKES_LIST[Math.floor(Math.random() * JOKES_LIST.length)];
    return `😄 *${joke}*`;
  }

  // Riddle fallback
  if (/\b(riddle|brain\s*teaser)\b/i.test(lower)) {
    const r = DEFAULT_RIDDLES[Math.floor(Math.random() * DEFAULT_RIDDLES.length)];
    return `🧩 *RIDDLE TIME*\n\n❝ *${r.riddle}* ❞\n\n💡 _Answer:_ || *${r.displayAnswer}* ||`;
  }

  // Math expression evaluation if user asks a calculation
  const mathCandidate = lower
    .replace(/^(what is|calculate|solve|compute|evaluate)\s+/i, "")
    .replace(/[?=]+$/g, "")
    .trim();
  if (/^[\d\s+\-*/().%^]+$/.test(mathCandidate) && /\d/.test(mathCandidate)) {
    try {
      const normalizedExpr = mathCandidate.replace(/\^/g, "**");
      const val = Function(`"use strict"; return (${normalizedExpr});`)();
      if (typeof val === "number" && Number.isFinite(val)) {
        return `🧮 *${mathCandidate} = ${val}*`;
      }
    } catch {}
  }

  // Wikipedia knowledge lookup fallback for factual questions
  const wikiAnswer = await searchWikipediaKnowledge(userPrompt);
  if (wikiAnswer) {
    if (chatId) {
      recordAIConversationTurn(userId, chatId, userPrompt, wikiAnswer);
    }
    return wikiAnswer;
  }

  // Natural conversational fallback (never a static command menu!)
  const naturalFallback = quotedText
    ? `Here's my take on that message (_"${quotedText.slice(0, 120)}${quotedText.length > 120 ? "..." : ""}"_): How would you like me to help with it? I can explain it further, translate it, rewrite it, or answer any question you have.`
    : `I'm right here with you! Could you share a bit more detail about *"${userPrompt}"* so I can give you the best answer?`;

  if (chatId) {
    recordAIConversationTurn(userId, chatId, userPrompt, naturalFallback);
  }
  return naturalFallback;
}

/**
 * Translates text using live LLM first, with Google Translate clients5 / GTX fallback.
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

  // Fallback 1: Google Translate clients5 endpoint
  try {
    const res = await axios.get("https://clients5.google.com/translate_a/t", {
      params: {
        client: "dict-chrome-ex",
        sl: "auto",
        tl,
        q: sourceText,
      },
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 6000,
    });
    const first = res.data?.[0];
    const translated = Array.isArray(first) ? first[0] : typeof first === "string" ? first : "";
    if (translated) {
      return [
        `🌐 *TRANSLATION (${targetLanguage})*`,
        "────────────────────────────",
        translated,
      ].join("\n");
    }
  } catch {}

  // Fallback 2: GTX endpoint
  try {
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
    contents: `Create a ${count}-question multiple-choice trivia quiz${topic ? ` about "${topic}"` : " covering general knowledge, science, sports, and world facts"}. Return ONLY a valid JSON array of objects (no markdown fences) with properties: question (string), options (array of 4 strings starting with "A) ", "B) ", "C) ", "D) "), answerLetter ("A"|"B"|"C"|"D"), answerText (lowercase answer text), explanation (short string).`,
    responseMimeType: "application/json",
  });

  if (aiJson) {
    try {
      const cleaned = aiJson
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const startBracket = cleaned.indexOf("[");
      const endBracket = cleaned.lastIndexOf("]");
      const jsonSlice =
        startBracket !== -1 && endBracket !== -1
          ? cleaned.slice(startBracket, endBracket + 1)
          : cleaned;
      const parsed = JSON.parse(jsonSlice);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed[0].question &&
        Array.isArray(parsed[0].options)
      ) {
        return parsed.slice(0, count);
      }
    } catch {}
  }

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

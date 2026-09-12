import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { getWhatsAppController } from "./lib/whatsapp.js";

process.on("uncaughtException", (error) => {
  logger.error("Process uncaught exception handled gracefully", error?.stack || error?.message);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  logger.error("Process unhandled rejection handled gracefully", msg);
});

const app = express();
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, "public");
const apiPrefix = String(process.env.BOT_API_PREFIX || "/bot-api").replace(/\/$/, "");

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(publicDir, { extensions: ["html"] }));

function resolveUserId(request) {
  const header = request.headers["x-user-id"];
  const query = request.query?.userId;
  const body = request.body?.userId;
  const raw = String(header || query || body || "default").trim();
  // Sanitize to safe characters for path safety
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "default";
}

function getFirebaseClientConfig() {
  try {
    const configPath = path.join(rootDir, "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return {
        apiKey: parsed.apiKey,
        authDomain: parsed.authDomain,
        projectId: parsed.projectId,
        storageBucket: parsed.storageBucket,
        messagingSenderId: parsed.messagingSenderId,
        appId: parsed.appId,
        firestoreDatabaseId: parsed.firestoreDatabaseId || "(default)",
      };
    }
  } catch (error) {
    logger.warn("Could not read firebase-applet-config.json", error.message);
  }
  return null;
}

const prefixes = Array.from(new Set([apiPrefix, "/api", "/bot-api"]));

for (const p of prefixes) {
  app.get(`${p}/health`, (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get(`${p}/firebase-config`, (_request, response) => {
    const config = getFirebaseClientConfig();
    if (!config) {
      return response.status(500).json({ error: "Firebase configuration is not available on the server." });
    }
    response.json(config);
  });

  app.get(`${p}/status`, (request, response) => {
    const userId = resolveUserId(request);
    const controller = getWhatsAppController(userId);
    response.json({ ...controller.getStatus(), userId });
  });

  app.post(`${p}/pair`, async (request, response) => {
    const userId = resolveUserId(request);
    const controller = getWhatsAppController(userId);
    try {
      const result = await controller.requestPairingCode(request.body?.number);
      response.json({
        code: result.code,
        pairingCode: result.code,
        expiresAt: result.expiresAt,
        pairingNumber: result.phone,
        userId,
      });
    } catch (error) {
      logger.error(`Pairing request failed for user ${userId}`, error.stack || error.message);
      response.status(400).json({
        error: error.message || "Pairing code could not be generated.",
        statusCode: error?.output?.statusCode ?? error?.statusCode ?? null,
        userId,
      });
    }
  });

  app.post(`${p}/disconnect`, async (request, response) => {
    const userId = resolveUserId(request);
    const controller = getWhatsAppController(userId);
    try {
      await controller.disconnect();
      response.json({ ok: true, status: "idle", userId });
    } catch (error) {
      logger.error(`Disconnect failed for user ${userId}`, error.stack || error.message);
      response.status(500).json({ error: "The WhatsApp session could not be cleared.", userId });
    }
  });
}

app.use((request, response, next) => {
  if (prefixes.some((p) => request.path.startsWith(`${p}/`))) return next();
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, _request, response, _next) => {
  logger.error("Unhandled web error", error.stack || error.message);
  response.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info("SOLVATECH BOT web server listening", String(PORT));
});
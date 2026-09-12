import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { getWhatsAppController } from "./lib/whatsapp.js";
import { requireAuth } from "./lib/auth.js";

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
app.use(express.static(rootDir, { extensions: ["html"] }));

/**
 * ARCHITECTURAL NOTE - STORAGE ON RAILWAY & PRODUCTION:
 * ======================================================
 * Currently, WhatsApp authentication keys and session state are stored in the local
 * filesystem directory (`sessions/<safeUserId>`) via Baileys multi-file auth state,
 * and group settings in `data/group-settings-<safeUserId>.json`.
 *
 * Ephemeral container platforms like Railway rebuild/restart containers, which resets
 * local filesystem storage unless a persistent Railway Volume is mounted to `./sessions`
 * and `./data`, or session state is synced to Cloud Firestore / database.
 *
 * For this phase, session directory isolation is strictly keyed to the verified Firebase UID.
 */

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
  // Public Health & Firebase Config endpoints
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

  // Protected Routes: Require valid Firebase Auth Bearer token
  // The verified Firebase UID is authoritative and determines the WhatsApp session.
  // Any client-supplied body.userId, query.userId, or header x-user-id is strictly ignored.
  app.get(`${p}/status`, requireAuth, (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const controller = getWhatsAppController(safeUserId);
    response.json({
      ...controller.getStatus(),
      userId: verifiedUid,
      user: {
        uid: request.auth.uid,
        email: request.auth.email,
        displayName: request.auth.displayName,
        photoURL: request.auth.photoURL,
      },
    });
  });

  app.get(`${p}/user/profile`, requireAuth, (request, response) => {
    response.json({
      uid: request.auth.uid,
      email: request.auth.email,
      displayName: request.auth.displayName,
      photoURL: request.auth.photoURL,
    });
  });

  app.post(`${p}/pair`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const controller = getWhatsAppController(safeUserId);
    try {
      const result = await controller.requestPairingCode(request.body?.number);
      response.json({
        code: result.code,
        pairingCode: result.code,
        expiresAt: result.expiresAt,
        pairingNumber: result.phone,
        userId: verifiedUid,
      });
    } catch (error) {
      logger.error(`Pairing request failed for verified user ${verifiedUid}`, error.stack || error.message);
      response.status(400).json({
        error: error.message || "Pairing code could not be generated.",
        statusCode: error?.output?.statusCode ?? error?.statusCode ?? null,
        userId: verifiedUid,
      });
    }
  });

  app.post(`${p}/disconnect`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const controller = getWhatsAppController(safeUserId);
    try {
      await controller.disconnect();
      response.json({ ok: true, status: "idle", userId: verifiedUid });
    } catch (error) {
      logger.error(`Disconnect failed for verified user ${verifiedUid}`, error.stack || error.message);
      response.status(500).json({ error: "The WhatsApp session could not be cleared.", userId: verifiedUid });
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
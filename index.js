import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { createWhatsAppController } from "./lib/whatsapp.js";

const app = express();
const controller = createWhatsAppController();
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, "public");
const apiPrefix = String(process.env.BOT_API_PREFIX || "/bot-api").replace(/\/$/, "");

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(publicDir, { extensions: ["html"] }));

app.get(`${apiPrefix}/status`, (_request, response) => {
  response.json(controller.getStatus());
});

app.post(`${apiPrefix}/pair`, async (request, response) => {
  try {
    const result = await controller.requestPairingCode(request.body?.number);
    response.json({ code: result.code, pairingCode: result.code, expiresAt: result.expiresAt, pairingNumber: result.phone });
  } catch (error) {
    logger.error("Pairing request failed", error.stack || error.message);
    response.status(400).json({
      error: error.message || "Pairing code could not be generated.",
      statusCode: error?.output?.statusCode ?? error?.statusCode ?? null,
    });
  }
});

app.post(`${apiPrefix}/disconnect`, async (_request, response) => {
  try {
    await controller.disconnect();
    response.json({ ok: true, status: "idle" });
  } catch (error) {
    logger.error("Disconnect failed", error.stack || error.message);
    response.status(500).json({ error: "The WhatsApp session could not be cleared." });
  }
});

app.use((request, response, next) => {
  if (request.path.startsWith(`${apiPrefix}/`)) return next();
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, _request, response, _next) => {
  logger.error("Unhandled web error", error.stack || error.message);
  response.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info("SOLVATECH BOT web server listening", String(PORT));
  void controller.start().catch((error) => logger.error("WhatsApp startup failed", error.stack || error.message));
});
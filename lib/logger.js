import fs from "node:fs";
import path from "node:path";
import { LOG_FILE } from "./config.js";

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function write(level, message, details) {
  let detailStr = "";
  if (details !== undefined && details !== null) {
    if (typeof details === "object") {
      try {
        detailStr = " " + JSON.stringify(details);
      } catch {
        detailStr = " " + String(details);
      }
    } else {
      detailStr = " " + details;
    }
  }
  const line = `${new Date().toISOString()} [${level}] ${message}${detailStr}\n`;
  fs.appendFile(LOG_FILE, line, () => {});
  if (level === "ERROR") console.error(line.trim());
}

export const logger = {
  debug(message, details) {
    write("DEBUG", message, details);
  },
  info(message, details) {
    write("INFO", message, details);
  },
  warn(message, details) {
    write("WARN", message, details);
  },
  error(message, details) {
    write("ERROR", message, details);
  },
};
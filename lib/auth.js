import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { logger } from "./logger.js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Load Firebase configuration
function loadFirebaseConfig() {
  try {
    const configPath = path.join(rootDir, "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch (error) {
    logger.warn("Could not read firebase-applet-config.json for auth verification", error.message);
  }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || "gen-lang-client-0324946831",
    apiKey: process.env.FIREBASE_API_KEY || "AIzaSyA_g2ek4ziXSE9m4VD5-5PfKpKJjAobYFg",
  };
}

const firebaseConfig = loadFirebaseConfig();
const PROJECT_ID = firebaseConfig.projectId || "gen-lang-client-0324946831";
const API_KEY = firebaseConfig.apiKey || "";

// Cache for Google's public x509 certificates
let cachedPublicCerts = null;
let certsExpiresAt = 0;

// Cache for verified ID tokens (token -> { uid, email, displayName, photoURL, exp })
const verifiedTokenCache = new Map();

/**
 * Prunes expired tokens from in-memory cache
 */
function pruneTokenCache() {
  const now = Date.now();
  for (const [token, data] of verifiedTokenCache.entries()) {
    if (data.exp * 1000 < now) {
      verifiedTokenCache.delete(token);
    }
  }
}

// Prune token cache every 5 minutes
setInterval(pruneTokenCache, 5 * 60 * 1000).unref();

/**
 * Fetches Google's public certificates for Firebase token verification
 */
async function getGooglePublicCerts() {
  const now = Date.now();
  if (cachedPublicCerts && now < certsExpiresAt) {
    return cachedPublicCerts;
  }

  try {
    const res = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching Google public certs`);
    
    // Parse Cache-Control header for max-age
    const cacheControl = res.headers.get("cache-control") || "";
    const match = cacheControl.match(/max-age=(\d+)/);
    const maxAgeSec = match ? parseInt(match[1], 10) : 3600;
    certsExpiresAt = now + (maxAgeSec * 1000);

    cachedPublicCerts = await res.json();
    return cachedPublicCerts;
  } catch (error) {
    logger.warn("Failed to fetch Google public certs, will use accounts:lookup fallback", error.message);
    return cachedPublicCerts || {};
  }
}

/**
 * Decodes base64url string to JSON
 */
function decodeBase64Json(str) {
  try {
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Verifies a Firebase Auth ID Token server-side.
 * 
 * Verifies:
 * 1. RS256 cryptographic signature against Google's public certificates
 * 2. Header `alg` is RS256 and `kid` matches Google cert
 * 3. `aud` equals the Firebase project ID
 * 4. `iss` equals `https://securetoken.google.com/<projectId>`
 * 5. `sub` (UID) is non-empty string <= 128 chars
 * 6. `exp` is in the future
 * 7. `auth_time` is in the past
 * 
 * Includes Google Identity Toolkit fallback verification for maximum reliability.
 */
export async function verifyFirebaseIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    return null;
  }

  const cleanToken = idToken.trim();
  if (!cleanToken) return null;

  // Check in-memory cache first
  const cached = verifiedTokenCache.get(cleanToken);
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached && cached.exp > nowSec + 10) {
    return cached;
  }

  // Token format: header.payload.signature
  const parts = cleanToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeBase64Json(headerB64);
  const payload = decodeBase64Json(payloadB64);

  if (!header || !payload) {
    return null;
  }

  // 1. Basic JWT claims verification
  if (header.alg !== "RS256" || !header.kid) {
    return null;
  }

  if (payload.aud !== PROJECT_ID) {
    logger.warn(`Firebase token aud mismatch: expected ${PROJECT_ID}, got ${payload.aud}`);
    return null;
  }

  const expectedIss = `https://securetoken.google.com/${PROJECT_ID}`;
  if (payload.iss !== expectedIss) {
    logger.warn(`Firebase token iss mismatch: expected ${expectedIss}, got ${payload.iss}`);
    return null;
  }

  if (!payload.sub || typeof payload.sub !== "string" || payload.sub.length > 128) {
    return null;
  }

  // Clock verification (allowing 5 minute clock skew)
  if (payload.exp && payload.exp < nowSec - 300) {
    return null;
  }
  if (payload.iat && payload.iat > nowSec + 300) {
    return null;
  }
  if (payload.auth_time && payload.auth_time > nowSec + 300) {
    return null;
  }

  // 2. Cryptographic signature check with Google's public certificates
  let signatureValid = false;
  try {
    const certs = await getGooglePublicCerts();
    const cert = certs[header.kid];
    if (cert) {
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(`${headerB64}.${payloadB64}`);
      const sigBuffer = Buffer.from(signatureB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      signatureValid = verifier.verify(cert, sigBuffer);
    }
  } catch (error) {
    logger.debug("Local crypto verification exception", error.message);
  }

  // 3. If local signature succeeded, build user identity
  if (signatureValid) {
    const verifiedUser = {
      uid: payload.sub,
      email: payload.email || "",
      displayName: payload.name || payload.displayName || "",
      photoURL: payload.picture || payload.photoURL || "",
      exp: payload.exp || nowSec + 3600,
      safeUserId: "user_" + payload.sub.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96),
    };

    // Cache verified user
    verifiedTokenCache.set(cleanToken, verifiedUser);
    return verifiedUser;
  }

  // 4. Fallback: Google Identity Toolkit accounts:lookup API
  if (API_KEY) {
    try {
      const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: cleanToken }),
      });

      if (res.ok) {
        const data = await res.json();
        const user = data.users?.[0];
        if (user && user.localId) {
          const verifiedUser = {
            uid: user.localId,
            email: user.email || payload.email || "",
            displayName: user.displayName || payload.name || "",
            photoURL: user.photoUrl || payload.picture || "",
            exp: payload.exp || nowSec + 3600,
            safeUserId: "user_" + user.localId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96),
          };
          verifiedTokenCache.set(cleanToken, verifiedUser);
          return verifiedUser;
        }
      } else {
        const errJson = await res.json().catch(() => ({}));
        logger.debug("Identity toolkit lookup failed", errJson?.error?.message || res.status);
      }
    } catch (error) {
      logger.warn("Identity toolkit fallback request failed", error.message);
    }
  }

  return null;
}

/**
 * Express Middleware: Strictly enforces Firebase ID token authentication on protected routes.
 * 
 * Reject missing, invalid, malformed, or expired tokens with HTTP 401.
 * Authoritative: Derives the user identity ONLY from the verified token UID.
 * Ignores any client-supplied x-user-id, query.userId, or body.userId.
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Unauthorized: Missing or invalid Authorization header. Expected Bearer <Firebase ID token>.",
      code: "AUTH_TOKEN_MISSING",
    });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({
      error: "Unauthorized: Empty Firebase authentication token.",
      code: "AUTH_TOKEN_EMPTY",
    });
  }

  try {
    const auth = await verifyFirebaseIdToken(token);
    if (!auth || !auth.uid) {
      return res.status(401).json({
        error: "Unauthorized: Invalid, revoked, or expired Firebase ID token.",
        code: "AUTH_TOKEN_INVALID",
      });
    }

    // Attach verified user identity to the request
    req.auth = auth;
    req.verifiedUid = auth.uid;
    req.safeUserId = auth.safeUserId;

    next();
  } catch (error) {
    logger.error("Authentication middleware failure", error.stack || error.message);
    return res.status(401).json({
      error: "Unauthorized: Authentication verification failed.",
      code: "AUTH_VERIFICATION_ERROR",
    });
  }
}

export const ADMIN_EMAIL = "awoyinfasolomon1@gmail.com";

let serverFirestoreInstance = null;

/**
 * Returns a server-side Firestore instance initialized from project config
 */
export function getFirebaseServerFirestore() {
  if (serverFirestoreInstance) return serverFirestoreInstance;
  try {
    const apps = getApps();
    const app = apps.length > 0 ? apps[0] : initializeApp(firebaseConfig);
    const dbId = firebaseConfig.firestoreDatabaseId || "(default)";
    serverFirestoreInstance = getFirestore(app, dbId);
  } catch (e) {
    logger.debug("Server firestore init note", e.message);
  }
  return serverFirestoreInstance;
}

/**
 * Express Middleware: Strictly enforces Administrator authorization.
 * Verifies that the authenticated user's email matches the exact admin address.
 */
export function requireAdmin(req, res, next) {
  if (!req.auth || !req.auth.email) {
    return res.status(401).json({
      error: "Unauthorized: Authentication required.",
      code: "AUTH_REQUIRED",
    });
  }

  const normalizedUserEmail = req.auth.email.trim().toLowerCase();
  const normalizedAdminEmail = ADMIN_EMAIL.trim().toLowerCase();

  if (normalizedUserEmail !== normalizedAdminEmail) {
    logger.warn(`Forbidden admin access attempt by ${req.auth.email} (UID: ${req.auth.uid})`);
    return res.status(403).json({
      error: "Forbidden: You do not have administrator permissions.",
      code: "ADMIN_FORBIDDEN",
    });
  }

  next();
}

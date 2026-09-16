import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import {
  getWhatsAppController,
  restoreAllSessions,
  auditActiveSessions,
  getAllWhatsAppStatuses,
  disconnectUserWhatsAppSession,
} from "./lib/whatsapp.js";
import {
  getLockedNumberForUid,
  getAllNumberLocks,
  wipeNumberFromAccount,
  getAllNumberHistory,
} from "./lib/number-lock.js";
import {
  requireAuth,
  requireAdmin,
  createPreviewToken,
  getFirebaseServerFirestore,
  setUserAccountStatus,
  isUserAccountDisabled,
  recordAdminAuditLog,
  getAdminAuditLogs,
} from "./lib/auth.js";
import {
  createLicenseRecord,
  listAllLicenses,
  redeemLicenseCode,
  getUserLicenseStatus,
  syncAllFromFirestore,
  stopActiveLicense,
  ADMIN_EMAIL,
} from "./lib/license.js";
import {
  ensureUserReferralData,
  getReferralStats,
  claimReferralReward,
  getAdminReferralAudit,
  getOfficialLicensePrice,
} from "./lib/referral.js";

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

// Explicit CORS configuration for Railway, GitHub Pages frontend, custom domains, and local development
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin, x-user-id, Cache-Control, Pragma");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const staticOptions = {
  extensions: ["html"],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Service-Worker-Allowed", "/");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    } else if (filePath.endsWith(".webmanifest") || filePath.endsWith("manifest.json")) {
      res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  }
};

app.use(express.static(rootDir, staticOptions));
app.use(express.static(publicDir, staticOptions));

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

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

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

  // Studio Preview / Development Session Provider
  // Used when testing in environments whose dynamic domain is not yet allowlisted in Firebase Console.
  app.post(`${p}/auth/preview-session`, (_request, response) => {
    const user = {
      uid: "admin_awoyinfasolomon1",
      email: ADMIN_EMAIL,
      displayName: "Solomon Awoyinfa (Admin)",
      photoURL: "./solva.webp",
    };
    const token = createPreviewToken(user);
    response.json({
      token,
      user,
      mode: "preview",
      message: "Studio preview session established successfully.",
    });
  });

  // Protected Routes: Require valid Firebase Auth Bearer token
  // The verified Firebase UID is authoritative and determines the WhatsApp session.
  // Any client-supplied body.userId, query.userId, or header x-user-id is strictly ignored.
  app.get(`${p}/status`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const userEmail = request.auth.email;
    const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail });
    
    const [lockedNumber, license] = await Promise.all([
      getLockedNumberForUid(verifiedUid),
      getUserLicenseStatus(verifiedUid, userEmail),
    ]);

    response.json({
      ...controller.getStatus(),
      lockedNumber,
      license,
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
    const userEmail = request.auth.email;

    try {
      // License enforcement: Admin (awoyinfasolomon1@gmail.com) has automatic unlimited active status.
      // Normal users must have an active, non-expired license.
      const licenseStatus = await getUserLicenseStatus(verifiedUid, userEmail);
      if (!licenseStatus.hasActiveLicense) {
        return response.status(403).json({
          error: "Active license required. Please enter and redeem a valid SOLVATECH activation code in your dashboard before pairing your WhatsApp account.",
          code: "LICENSE_REQUIRED",
          userId: verifiedUid,
        });
      }

      const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail });
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
      const statusCode = error.code === "NUMBER_LOCKED_TO_ANOTHER_ACCOUNT" || error.code === "ACCOUNT_LOCKED_TO_DIFFERENT_NUMBER" ? 403 : 400;
      response.status(statusCode).json({
        error: error.message || "Pairing code could not be generated.",
        code: error.code || "PAIRING_FAILED",
        statusCode: error?.output?.statusCode ?? error?.statusCode ?? null,
        userId: verifiedUid,
      });
    }
  });

  app.post(`${p}/disconnect`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail: request.auth.email });
    try {
      await controller.disconnect();
      response.json({ ok: true, status: "idle", userId: verifiedUid });
    } catch (error) {
      logger.error(`Disconnect failed for verified user ${verifiedUid}`, error.stack || error.message);
      response.status(500).json({ error: "The WhatsApp session could not be cleared.", userId: verifiedUid });
    }
  });

  // Dedicated Auto-Reconnection Logs and Battery Telemetry API
  app.get(`${p}/reconnect-logs`, requireAuth, async (request, response) => {
    try {
      const safeUserId = request.safeUserId;
      const verifiedUid = request.verifiedUid;
      const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail: request.auth.email });
      const statusData = controller.getStatus();

      response.json({
        ok: true,
        userId: verifiedUid,
        botNumber: statusData.botNumber || "",
        state: statusData.state || statusData.status,
        battery: statusData.battery,
        reconnectStats: statusData.reconnectStats,
        logs: statusData.reconnectLogs || [],
      });
    } catch (error) {
      logger.error("Failed to retrieve reconnect logs", error.stack || error.message);
      response.status(500).json({ error: "Could not retrieve reconnection telemetry logs." });
    }
  });

  // Trigger Instant Manual Reconnect
  app.post(`${p}/reconnect`, requireAuth, async (request, response) => {
    try {
      const safeUserId = request.safeUserId;
      const verifiedUid = request.verifiedUid;
      const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail: request.auth.email });
      const result = await controller.triggerManualReconnect();
      response.json({
        ok: true,
        ...result,
        status: controller.getStatus(),
      });
    } catch (error) {
      logger.error("Failed to initiate manual reconnect", error.stack || error.message);
      response.status(500).json({ error: error.message || "Could not trigger reconnect." });
    }
  });

  // --------------------------------------------------------------------------
  // USER LICENSE ROUTES (Authenticated)
  // --------------------------------------------------------------------------
  app.get(`${p}/license/status`, requireAuth, async (request, response) => {
    try {
      const verifiedUid = request.verifiedUid;
      const userEmail = request.auth.email;
      const status = await getUserLicenseStatus(verifiedUid, userEmail);
      response.json({
        ...status,
        userId: verifiedUid,
        userEmail: request.auth.email,
        isAdmin: request.auth.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase(),
      });
    } catch (error) {
      logger.error("Failed to retrieve license status", error.stack || error.message);
      response.status(500).json({ error: "Could not fetch license status." });
    }
  });

  app.post(`${p}/license/redeem`, requireAuth, async (request, response) => {
    try {
      const code = request.body?.code;
      const candidateRef = request.body?.ref || request.query?.ref || "";
      if (!code) {
        return response.status(400).json({ error: "Please enter a valid license code." });
      }

      // Verified user from authoritative Firebase token - NOT request body
      const verifiedUser = {
        uid: request.verifiedUid,
        email: request.auth.email,
      };

      // If user came in through a referral link or has a preserved referral code, ensure permanent attribution in Firebase before redemption
      if (candidateRef) {
        try {
          await ensureUserReferralData(
            request.verifiedUid,
            request.auth.email,
            candidateRef,
            request.headers.authorization
          );
        } catch (refErr) {
          logger.warn("Pre-redemption referral attribution notice", refErr.message);
        }
      }

      const result = await redeemLicenseCode(code, verifiedUser, request.headers.authorization);

      // Auto-reconnect existing saved session if present and valid
      const controller = getWhatsAppController(request.safeUserId, {
        verifiedUid: request.verifiedUid,
        userEmail: request.auth.email,
      });
      if (controller.hasSavedSession() && !controller.isConnected()) {
        logger.info(`Auto-reconnecting WhatsApp session for user ${request.verifiedUid} after license redemption`);
        controller.start().catch((err) => {
          logger.warn("Auto-reconnect after license redemption notice", err.message);
        });
      }

      response.json(result);
    } catch (error) {
      logger.warn(`License redemption rejected for user ${request.verifiedUid}: ${error.message}`);
      const statusCode = error.code === "LICENSE_NOT_FOUND" ? 404 : error.code === "LICENSE_ALREADY_USED" ? 409 : 400;
      response.status(statusCode).json({
        error: error.message || "License redemption failed.",
        code: error.code || "REDEMPTION_FAILED",
      });
    }
  });

  // --------------------------------------------------------------------------
  // REFERRAL SYSTEM ROUTES (Permanent Firebase Source of Truth)
  // --------------------------------------------------------------------------
  app.get(`${p}/referral/me`, requireAuth, async (request, response) => {
    try {
      const candidateCode = request.query?.ref || "";
      await ensureUserReferralData(
        request.verifiedUid,
        request.auth.email,
        candidateCode,
        request.headers.authorization
      );
      const stats = await getReferralStats(request.verifiedUid);
      response.json({
        success: true,
        ...stats,
      });
    } catch (error) {
      logger.error("Get referral stats error", error.stack || error.message);
      response.status(500).json({ error: "Failed to load referral details." });
    }
  });

  app.post(`${p}/referral/attribute`, requireAuth, async (request, response) => {
    try {
      const candidateCode = request.body?.code || request.body?.ref || request.query?.ref || "";
      if (!candidateCode) {
        return response.status(400).json({ error: "Referral code is required." });
      }
      await ensureUserReferralData(
        request.verifiedUid,
        request.auth.email,
        candidateCode,
        request.headers.authorization
      );
      const stats = await getReferralStats(request.verifiedUid);
      response.json({
        success: true,
        message: "Referral attribution processed.",
        ...stats,
      });
    } catch (error) {
      logger.error("Attribute referral error", error.stack || error.message);
      response.status(500).json({ error: "Failed to attribute referral code." });
    }
  });

  app.post(`${p}/referral/claim`, requireAuth, async (request, response) => {
    try {
      const result = await claimReferralReward(
        request.verifiedUid,
        request.auth.email,
        request.headers.authorization
      );
      response.json(result);
    } catch (error) {
      logger.warn(`Referral claim failed for user ${request.verifiedUid}: ${error.message}`);
      const statusCode = error.code === "NO_REWARD_AVAILABLE" ? 400 : 500;
      response.status(statusCode).json({
        error: error.message || "Failed to claim referral reward.",
        code: error.code || "CLAIM_FAILED",
      });
    }
  });

  // --------------------------------------------------------------------------
  // ADMIN LICENSE & REFERRAL AUDIT ROUTES (Strictly Admin Email: awoyinfasolomon1@gmail.com)
  // --------------------------------------------------------------------------
  app.get(`${p}/admin/overview`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const [licenses, numberLocks, referralAudit, whatsappList] = await Promise.all([
        listAllLicenses(),
        getAllNumberLocks(),
        getAdminReferralAudit(),
        Promise.resolve(getAllWhatsAppStatuses()),
      ]);

      const db = getFirebaseServerFirestore();
      const firestoreUsers = {};
      if (db) {
        try {
          const { collection, getDocs } = await import("firebase/firestore");
          const [usersSnap, userLicensesSnap] = await Promise.all([
            getDocs(collection(db, "users")).catch(() => ({ forEach: () => {} })),
            getDocs(collection(db, "user_licenses")).catch(() => ({ forEach: () => {} })),
          ]);

          usersSnap.forEach((d) => {
            if (d.data()) firestoreUsers[d.id] = { ...(firestoreUsers[d.id] || {}), ...d.data(), uid: d.id };
          });
          userLicensesSnap.forEach((d) => {
            if (d.data()) firestoreUsers[d.id] = { ...(firestoreUsers[d.id] || {}), activeLicense: d.data(), uid: d.id };
          });
        } catch (err) {
          logger.debug("Admin comprehensive Firestore scan notice", err.message);
        }
      }

      const locksByUid = {};
      for (const [phone, lock] of Object.entries(numberLocks || {})) {
        if (lock && lock.uid) {
          locksByUid[lock.uid] = phone;
        }
      }

      const wsByUid = {};
      for (const ws of (whatsappList || [])) {
        if (ws && ws.verifiedUid) {
          wsByUid[ws.verifiedUid] = ws;
        }
      }

      const referrersByUid = {};
      for (const ref of (referralAudit?.referrers || [])) {
        if (ref && ref.uid) {
          referrersByUid[ref.uid] = ref;
        }
      }

      const now = Date.now();
      const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

      let totalRevenueNgn = 0;
      let activeCount = 0;
      let expiringSoonCount = 0;
      let expiredCount = 0;
      let unusedCount = 0;
      let usedCount = 0;
      let lifetimeCount = 0;

      const enrichedLicenses = licenses.map((lic) => {
        const isUsed = lic.status === "used" || Boolean(lic.redeemedByUid);
        const durationDays = Number(lic.durationDays) || 1;
        const priceNgn = getOfficialLicensePrice(durationDays);
        const isLifetime = durationDays >= 36500 || lic.durationDays === "Unlimited";

        let calculatedStatus = "unused";
        let remainingMs = null;

        if (isUsed) {
          usedCount++;
          if (lic.expiresAt) {
            const expiryMs = new Date(lic.expiresAt).getTime();
            remainingMs = expiryMs - now;
            if (isLifetime) {
              calculatedStatus = "lifetime";
              lifetimeCount++;
            } else if (remainingMs > 0) {
              if (remainingMs <= FORTY_EIGHT_HOURS_MS) {
                calculatedStatus = "expiring_soon";
                expiringSoonCount++;
                activeCount++;
              } else {
                calculatedStatus = "active";
                activeCount++;
              }
            } else {
              calculatedStatus = "expired";
              expiredCount++;
            }
          } else if (isLifetime) {
            calculatedStatus = "lifetime";
            lifetimeCount++;
          } else {
            calculatedStatus = "active";
            activeCount++;
          }

          if (priceNgn > 0) {
            totalRevenueNgn += priceNgn;
          }
        } else {
          unusedCount++;
          calculatedStatus = "unused";
        }

        const redeemedUid = lic.redeemedByUid || "";
        const phone = locksByUid[redeemedUid] || "";
        const fsUser = firestoreUsers[redeemedUid] || {};

        return {
          ...lic,
          priceNgn,
          isUsed,
          computedStatus: calculatedStatus,
          remainingMs,
          whatsappNumber: phone,
          customerEmail: lic.redeemedByEmail || fsUser.email || "",
          customerName: fsUser.displayName || "",
        };
      });

      const customersMap = {};

      for (const [uid, uData] of Object.entries(firestoreUsers)) {
        customersMap[uid] = {
          uid,
          email: uData.email || "",
          displayName: uData.displayName || "",
          photoURL: uData.photoURL || "",
          createdAt: uData.createdAt || uData.joinedAt || null,
          activeLicense: uData.activeLicense || null,
        };
      }

      for (const lic of enrichedLicenses) {
        if (lic.redeemedByUid) {
          const uid = lic.redeemedByUid;
          if (!customersMap[uid]) {
            customersMap[uid] = {
              uid,
              email: lic.redeemedByEmail || "",
              displayName: lic.customerName || "",
              createdAt: lic.redeemedAt || lic.createdAt || null,
            };
          }
          if (!customersMap[uid].activeLicense || new Date(lic.expiresAt || 0) > new Date(customersMap[uid].activeLicense.expiresAt || 0)) {
            customersMap[uid].activeLicense = {
              code: lic.code,
              durationDays: lic.durationDays,
              expiresAt: lic.expiresAt,
              redeemedAt: lic.redeemedAt,
              status: lic.computedStatus,
            };
          }
        }
      }

      for (const ref of (referralAudit?.referrers || [])) {
        if (!customersMap[ref.uid]) {
          customersMap[ref.uid] = {
            uid: ref.uid,
            email: ref.email || "",
            displayName: "",
            createdAt: null,
          };
        }
      }

      const customersList = Object.values(customersMap).map((cust) => {
        const phone = locksByUid[cust.uid] || "";
        const ws = wsByUid[cust.uid] || null;
        const refInfo = referrersByUid[cust.uid] || null;

        let licenseStatus = "none";
        let remainingMs = null;
        let expiresAt = null;

        if (cust.uid === "admin" || cust.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
          licenseStatus = "lifetime";
        } else if (cust.activeLicense && cust.activeLicense.expiresAt) {
          expiresAt = cust.activeLicense.expiresAt;
          const expiryMs = new Date(expiresAt).getTime();
          remainingMs = expiryMs - now;
          if (remainingMs > 0) {
            licenseStatus = remainingMs <= FORTY_EIGHT_HOURS_MS ? "expiring_soon" : "active";
          } else {
            licenseStatus = "expired";
          }
        }

        return {
          ...cust,
          phoneNumber: phone,
          whatsappStatus: ws ? ws.status : phone ? "disconnected" : "never_paired",
          botNumber: ws?.botNumber || phone || "",
          connectedAt: ws?.connectedAt || null,
          licenseStatus,
          remainingMs,
          expiresAt,
          referralCode: refInfo?.referralCode || "",
          qualifyingSalesNgn: refInfo?.qualifyingSalesNgn || 0,
          earnedDaysTotal: refInfo?.earnedDaysTotal || 0,
          claimedDaysTotal: refInfo?.claimedDaysTotal || 0,
          availableDays: refInfo?.availableDays || 0,
          referredCount: refInfo?.referredCount || 0,
        };
      }).sort((a, b) => (b.activeLicense ? 1 : 0) - (a.activeLicense ? 1 : 0));

      const activityEvents = [];

      for (const lic of licenses) {
        if (lic.createdAt) {
          activityEvents.push({
            id: `lic_create_${lic.code}`,
            type: "LICENSE_GENERATED",
            title: `License Generated (${lic.durationDays} Days)`,
            description: `Code ${lic.code} created`,
            timestamp: lic.createdAt,
            user: lic.createdBy || "Admin",
            meta: { code: lic.code, duration: lic.durationDays },
          });
        }
        if (lic.redeemedAt && lic.redeemedByUid) {
          activityEvents.push({
            id: `lic_redeem_${lic.code}`,
            type: "LICENSE_REDEEMED",
            title: `License Redeemed (${lic.durationDays} Days)`,
            description: `Code ${lic.code} activated by ${lic.redeemedByEmail || lic.redeemedByUid}`,
            timestamp: lic.redeemedAt,
            user: lic.redeemedByEmail || lic.redeemedByUid,
            meta: { code: lic.code, expiresAt: lic.expiresAt },
          });
        }
      }

      for (const pur of (referralAudit?.recentPurchases || [])) {
        if (pur.createdAt) {
          activityEvents.push({
            id: `ref_pur_${pur.purchaseId || Math.random()}`,
            type: "REFERRAL_PURCHASE",
            title: `Qualifying Purchase Recorded`,
            description: `₦${Number(pur.amountNgn || 0).toLocaleString()} credited for referrer ${pur.referrerCode || pur.referrerUid}`,
            timestamp: pur.createdAt,
            user: pur.buyerEmail || pur.buyerUid || "Customer",
            meta: { amountNgn: pur.amountNgn, referrer: pur.referrerCode },
          });
        }
      }

      activityEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      let connectedWhatsApp = 0;
      let disconnectedWhatsApp = 0;
      for (const ws of (whatsappList || [])) {
        if (ws.status === "connected") connectedWhatsApp++;
        else disconnectedWhatsApp++;
      }

      response.json({
        success: true,
        overview: {
          totalUsers: customersList.length,
          activeLicenses: activeCount,
          expiringSoon: expiringSoonCount,
          expiredLicenses: expiredCount,
          lifetimeLicenses: lifetimeCount,
          unusedKeys: unusedCount,
          usedKeys: usedCount,
          totalRevenueNgn,
          connectedWhatsApp,
          disconnectedWhatsApp,
          totalReferrals: referralAudit?.summary?.totalReferredCustomers || 0,
          totalReferrers: referralAudit?.summary?.totalReferrers || 0,
          totalQualifyingSalesNgn: referralAudit?.summary?.totalQualifyingSalesNgn || 0,
          rewardsEarnedDays: referralAudit?.summary?.totalRewardsEarnedDays || 0,
          rewardsClaimedDays: referralAudit?.summary?.totalRewardsClaimedDays || 0,
          rewardsAvailableDays: referralAudit?.summary?.totalRewardsAvailableDays || 0,
        },
        licenses: enrichedLicenses,
        customers: customersList,
        referrals: referralAudit,
        whatsappSessions: whatsappList,
        recentActivity: activityEvents.slice(0, 50),
        systemHealth: {
          uptimeSeconds: Math.floor(process.uptime()),
          serverTime: new Date().toISOString(),
          nodeVersion: process.version,
          platform: process.platform,
          memory: process.memoryUsage(),
          status: "operational",
        },
        adminEmail: ADMIN_EMAIL,
      });
    } catch (error) {
      logger.error("Admin overview aggregate error", error.stack || error.message);
      response.status(500).json({ error: "Failed to generate admin overview data." });
    }
  });

  app.get(`${p}/admin/referrals`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const audit = await getAdminReferralAudit();
      response.json({
        success: true,
        ...audit,
      });
    } catch (error) {
      logger.error("Admin referral audit error", error.stack || error.message);
      response.status(500).json({ error: "Failed to list referral audit data." });
    }
  });

  app.get(`${p}/admin/licenses`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const licenses = await listAllLicenses();
      response.json({
        licenses,
        total: licenses.length,
        admin: ADMIN_EMAIL,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Admin list licenses error", error.stack || error.message);
      response.status(500).json({ error: "Failed to list licenses." });
    }
  });

  app.post(`${p}/admin/licenses/generate`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const days = request.body?.days;
      if (!days || isNaN(Number(days)) || Number(days) <= 0) {
        return response.status(400).json({ error: "Valid duration in days is required (1-365)." });
      }

      const created = await createLicenseRecord(days, request.auth.email, request.headers.authorization);
      logger.info(`Admin generated new ${days}-day license: ${created.code}`);
      response.json({
        success: true,
        license: created,
        message: `Successfully generated ${days}-day license code.`,
      });
    } catch (error) {
      logger.error("Admin generate license error", error.stack || error.message);
      response.status(400).json({ error: error.message || "Failed to generate license." });
    }
  });

  // ==========================================================================
  // SUPER ADMIN — ACCOUNT & NUMBER MANAGEMENT ENDPOINTS
  // ==========================================================================

  app.get(`${p}/admin/accounts-and-numbers`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const db = getFirebaseServerFirestore();
      const firestoreUsers = {};

      if (db) {
        try {
          const { collection, getDocs } = await import("firebase/firestore");
          const snap = await getDocs(collection(db, "users"));
          snap.forEach((docSnap) => {
            firestoreUsers[docSnap.id] = docSnap.data();
          });
        } catch (err) {
          logger.debug("Firestore users fetch notice in accounts-and-numbers", err.message);
        }
      }

      const [licenses, numberLocks, numberHistoryList, referralAudit, auditLogsList] = await Promise.all([
        listAllLicenses(),
        getAllNumberLocks(),
        getAllNumberHistory(),
        getAdminReferralAudit().catch(() => ({ summary: {}, referrers: [] })),
        getAdminAuditLogs().catch(() => []),
      ]);

      const whatsappList = getAllWhatsAppStatuses();
      const wsByUid = {};
      for (const ws of whatsappList) {
        if (ws.verifiedUid) wsByUid[ws.verifiedUid] = ws;
        if (ws.userId) wsByUid[ws.userId] = ws;
      }

      const locksByUid = {};
      const locksByPhone = {};
      for (const [phone, lock] of Object.entries(numberLocks || {})) {
        if (lock && lock.uid) {
          locksByUid[lock.uid] = lock;
          locksByPhone[phone] = lock;
        }
      }

      const referrersByUid = {};
      for (const ref of (referralAudit?.referrers || [])) {
        if (ref && ref.uid) referrersByUid[ref.uid] = ref;
      }

      // Group history by UID, email, and phone
      const historyByUid = {};
      const historyByPhone = {};
      for (const hist of numberHistoryList || []) {
        if (hist.uid) {
          historyByUid[hist.uid] = historyByUid[hist.uid] || [];
          historyByUid[hist.uid].push(hist);
        }
        if (hist.phoneNumber) {
          historyByPhone[hist.phoneNumber] = historyByPhone[hist.phoneNumber] || [];
          historyByPhone[hist.phoneNumber].push(hist);
        }
      }

      const accountsMap = {};

      // 1. Seed from Firestore users
      for (const [uid, uData] of Object.entries(firestoreUsers)) {
        accountsMap[uid] = {
          uid,
          email: uData.email || "",
          displayName: uData.displayName || "",
          photoURL: uData.photoURL || "",
          createdAt: uData.createdAt || uData.joinedAt || null,
          disabled: uData.disabled === true,
          disabledAt: uData.disabledAt || null,
          disabledBy: uData.disabledBy || null,
          disabledReason: uData.disabledReason || null,
          status: uData.disabled === true ? "DISABLED" : "ACTIVE",
          activeLicense: uData.activeLicense || null,
        };
      }

      // 2. Seed from licenses
      for (const lic of licenses) {
        if (lic.redeemedByUid) {
          const uid = lic.redeemedByUid;
          if (!accountsMap[uid]) {
            accountsMap[uid] = {
              uid,
              email: lic.redeemedByEmail || "",
              displayName: "",
              createdAt: lic.redeemedAt || lic.createdAt || null,
              disabled: false,
              status: "ACTIVE",
            };
          }
          if (!accountsMap[uid].activeLicense || new Date(lic.expiresAt || 0) > new Date(accountsMap[uid].activeLicense.expiresAt || 0)) {
            accountsMap[uid].activeLicense = {
              code: lic.code,
              durationDays: lic.durationDays,
              expiresAt: lic.expiresAt,
              redeemedAt: lic.redeemedAt,
              status: lic.status === "stopped" || lic.adminStopped ? "stopped" : (new Date(lic.expiresAt).getTime() > Date.now() ? "active" : "expired"),
              adminStopped: lic.adminStopped || lic.status === "stopped",
            };
          }
        }
      }

      // 3. Seed from number locks
      for (const [phone, lock] of Object.entries(numberLocks || {})) {
        if (lock && lock.uid) {
          const uid = lock.uid;
          if (!accountsMap[uid]) {
            accountsMap[uid] = {
              uid,
              email: lock.userEmail || "",
              displayName: "",
              createdAt: lock.lockedAt || null,
              disabled: false,
              status: "ACTIVE",
            };
          }
        }
      }

      // 4. Seed from referrers
      for (const ref of (referralAudit?.referrers || [])) {
        if (ref && ref.uid && !accountsMap[ref.uid]) {
          accountsMap[ref.uid] = {
            uid: ref.uid,
            email: ref.email || "",
            displayName: "",
            createdAt: null,
            disabled: false,
            status: "ACTIVE",
          };
        }
      }

      // 5. Ensure Super Admin account is represented
      if (!Object.values(accountsMap).some((a) => a.email.toLowerCase() === ADMIN_EMAIL.toLowerCase())) {
        accountsMap["admin_root"] = {
          uid: "admin_root",
          email: ADMIN_EMAIL,
          displayName: "Super Administrator",
          createdAt: new Date().toISOString(),
          disabled: false,
          status: "ACTIVE",
        };
      }

      const now = Date.now();
      const accountsList = Object.values(accountsMap).map((acc) => {
        const lock = locksByUid[acc.uid] || null;
        const currentPhone = lock?.phoneNumber || null;
        const currentNumberLinkedAt = lock?.lockedAt || null;

        const ws = wsByUid[acc.uid] || (currentPhone ? wsByUid[currentPhone] : null) || null;
        const refInfo = referrersByUid[acc.uid] || null;

        // Collect number history for this account
        let numberHistory = historyByUid[acc.uid] || [];
        if (currentPhone && historyByPhone[currentPhone]) {
          const existingIds = new Set(numberHistory.map((h) => h.id));
          for (const h of historyByPhone[currentPhone]) {
            if (!existingIds.has(h.id)) {
              numberHistory.push(h);
              existingIds.add(h.id);
            }
          }
        }

        // If currently locked number is not in history list yet, add synthetic current record
        if (currentPhone && !numberHistory.some((h) => h.phoneNumber === currentPhone && h.status === "Current")) {
          numberHistory.unshift({
            id: `current_${acc.uid}_${currentPhone}`,
            phoneNumber: currentPhone,
            uid: acc.uid,
            userEmail: acc.email,
            action: "LINKED",
            status: "Current",
            linkedAt: currentNumberLinkedAt,
            unlinkedAt: null,
            timestamp: currentNumberLinkedAt || acc.createdAt,
          });
        }

        numberHistory.sort((a, b) => new Date(b.timestamp || b.linkedAt || 0).getTime() - new Date(a.timestamp || a.linkedAt || 0).getTime());

        // License status determination
        let licenseInfo = {
          code: null,
          durationDays: null,
          activatedDate: null,
          expirationDate: null,
          remainingMs: 0,
          remainingFormatted: "No License",
          status: "NO LICENSE",
          isLifetime: false,
          adminStopped: false,
        };

        if (acc.uid === "admin_root" || acc.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
          licenseInfo = {
            code: "ADMIN-UNLIMITED",
            durationDays: "Unlimited",
            activatedDate: acc.createdAt,
            expirationDate: null,
            remainingMs: 3153600000000,
            remainingFormatted: "Unlimited (Admin Access)",
            status: "ACTIVE",
            isLifetime: true,
            adminStopped: false,
          };
        } else if (acc.activeLicense) {
          const lic = acc.activeLicense;
          const expMs = lic.expiresAt ? new Date(lic.expiresAt).getTime() : 0;
          const remMs = Math.max(0, expMs - now);

          let statusStr = "ACTIVE";
          if (lic.adminStopped || lic.status === "stopped") {
            statusStr = "ADMIN STOPPED";
          } else if (remMs <= 0) {
            statusStr = "EXPIRED";
          }

          let remainingFormatted = "Expired";
          if (statusStr === "ADMIN STOPPED") {
            remainingFormatted = "Admin Stopped";
          } else if (remMs > 0) {
            const days = Math.floor(remMs / 86400000);
            const hrs = Math.floor((remMs % 86400000) / 3600000);
            const mins = Math.floor((remMs % 3600000) / 60000);
            remainingFormatted = `${days}d ${hrs}h ${mins}m left`;
          }

          licenseInfo = {
            code: lic.code || null,
            durationDays: lic.durationDays || null,
            activatedDate: lic.redeemedAt || null,
            expirationDate: lic.expiresAt || null,
            remainingMs: remMs,
            remainingFormatted,
            status: statusStr,
            isLifetime: false,
            adminStopped: Boolean(lic.adminStopped || lic.status === "stopped"),
            stoppedAt: lic.stoppedAt || null,
            stoppedReason: lic.stoppedReason || null,
          };
        }

        const wsStatus = ws ? ws.status : currentPhone ? "disconnected" : "never_paired";

        return {
          uid: acc.uid,
          email: acc.email,
          displayName: acc.displayName,
          createdAt: acc.createdAt,
          status: acc.status || "ACTIVE",
          disabled: Boolean(acc.disabled),
          disabledAt: acc.disabledAt,
          disabledBy: acc.disabledBy,
          disabledReason: acc.disabledReason,
          currentNumber: currentPhone,
          currentNumberLinkedAt,
          numberHistory,
          license: licenseInfo,
          whatsappStatus: wsStatus,
          botNumber: ws?.botNumber || currentPhone || "",
          connectedAt: ws?.connectedAt || null,
          referrals: {
            referralCode: refInfo?.referralCode || "",
            referrerCode: refInfo?.referrerCode || "",
            referredCount: refInfo?.referredCount || 0,
            qualifyingSalesNgn: refInfo?.qualifyingSalesNgn || 0,
            earnedDaysTotal: refInfo?.earnedDaysTotal || 0,
            claimedDaysTotal: refInfo?.claimedDaysTotal || 0,
            availableDays: refInfo?.availableDays || 0,
          },
        };
      });

      // Compute Dashboard Statistics (7 KPI Metrics)
      const totalAccounts = accountsList.length;
      const activeAccounts = accountsList.filter((a) => a.status === "ACTIVE").length;
      const disabledAccounts = accountsList.filter((a) => a.status === "DISABLED").length;
      const withCurrentNumber = accountsList.filter((a) => Boolean(a.currentNumber)).length;
      const withoutCurrentNumber = accountsList.filter((a) => !a.currentNumber).length;
      const totalCurrentNumberAssociations = Object.keys(numberLocks || {}).length;
      const totalHistoricalAssociations = (numberHistoryList || []).length;

      response.json({
        success: true,
        stats: {
          totalAccounts,
          activeAccounts,
          disabledAccounts,
          withCurrentNumber,
          withoutCurrentNumber,
          totalCurrentNumberAssociations,
          totalHistoricalAssociations,
        },
        accounts: accountsList,
        auditLogs: (auditLogsList || []).slice(0, 100),
        adminEmail: ADMIN_EMAIL,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Admin accounts and numbers aggregate error", error.stack || error.message);
      response.status(500).json({ error: "Failed to retrieve accounts and numbers data." });
    }
  });

  app.post(`${p}/admin/wipe-number`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { uid, reason } = request.body || {};
      if (!uid) return response.status(400).json({ error: "Target account UID is required." });

      const adminEmail = request.auth?.email || ADMIN_EMAIL;
      const result = await wipeNumberFromAccount(uid, adminEmail, reason || "Wiped by Super Admin");

      // Audit Log
      await recordAdminAuditLog(
        {
          action: "NUMBER_WIPED",
          targetUid: uid,
          targetEmail: result.userEmail || "",
          whatsappNumber: result.wipedNumber || "",
          adminEmail,
          previousState: `LOCKED (${result.wipedNumber || "None"})`,
          newState: "UNLOCKED / NO NUMBER",
          result: "SUCCESS",
          note: reason || "Wiped by Super Admin via Danger Zone",
        },
        request.headers.authorization
      );

      response.json({
        success: true,
        message: `WhatsApp number (+${result.wipedNumber || "N/A"}) removed from account ${uid}.`,
        wipedNumber: result.wipedNumber,
        uid,
      });
    } catch (error) {
      logger.error("Admin wipe number error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to wipe WhatsApp number." });
    }
  });

  app.post(`${p}/admin/stop-license`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { uid, licenseCode, reason } = request.body || {};
      if (!uid && !licenseCode) {
        return response.status(400).json({ error: "Account UID or License code is required." });
      }

      const adminEmail = request.auth?.email || ADMIN_EMAIL;
      const result = await stopActiveLicense(uid, licenseCode, adminEmail, reason || "Stopped by Super Admin", request.headers.authorization);

      // Audit Log
      await recordAdminAuditLog(
        {
          action: "LICENSE_STOPPED",
          targetUid: uid || "",
          licenseKey: result.code || licenseCode || "",
          adminEmail,
          previousState: "ACTIVE",
          newState: "ADMIN STOPPED",
          result: "SUCCESS",
          note: reason || "Stopped by Super Admin via Danger Zone",
        },
        request.headers.authorization
      );

      response.json({
        success: true,
        message: "License has been administratively stopped.",
        code: result.code,
        uid,
      });
    } catch (error) {
      logger.error("Admin stop license error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to stop license." });
    }
  });

  app.post(`${p}/admin/disable-account`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { uid, reason } = request.body || {};
      if (!uid) return response.status(400).json({ error: "Account UID is required." });

      const adminEmail = request.auth?.email || ADMIN_EMAIL;
      const result = await setUserAccountStatus(uid, { disabled: true, reason: reason || "Disabled by Super Admin", adminEmail }, request.headers.authorization);

      // Automatically disconnect active WhatsApp session
      await disconnectUserWhatsAppSession(uid).catch(() => {});

      // Audit Log
      await recordAdminAuditLog(
        {
          action: "ACCOUNT_DISABLED",
          targetUid: uid,
          adminEmail,
          previousState: "ACTIVE",
          newState: "DISABLED",
          result: "SUCCESS",
          note: reason || "Disabled by Super Admin via Danger Zone",
        },
        request.headers.authorization
      );

      response.json({
        success: true,
        message: `Account ${uid} has been administratively disabled.`,
        status: result.status,
        uid,
      });
    } catch (error) {
      logger.error("Admin disable account error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to disable account." });
    }
  });

  app.post(`${p}/admin/enable-account`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { uid } = request.body || {};
      if (!uid) return response.status(400).json({ error: "Account UID is required." });

      const adminEmail = request.auth?.email || ADMIN_EMAIL;
      const result = await setUserAccountStatus(uid, { disabled: false, adminEmail }, request.headers.authorization);

      // Audit Log
      await recordAdminAuditLog(
        {
          action: "ACCOUNT_RE_ENABLED",
          targetUid: uid,
          adminEmail,
          previousState: "DISABLED",
          newState: "ACTIVE",
          result: "SUCCESS",
          note: "Re-enabled by Super Admin via Danger Zone",
        },
        request.headers.authorization
      );

      response.json({
        success: true,
        message: `Account ${uid} has been re-enabled.`,
        status: result.status,
        uid,
      });
    } catch (error) {
      logger.error("Admin enable account error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to re-enable account." });
    }
  });

  app.post(`${p}/admin/disconnect-session`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { uid } = request.body || {};
      if (!uid) return response.status(400).json({ error: "Account UID is required." });

      const adminEmail = request.auth?.email || ADMIN_EMAIL;
      const result = await disconnectUserWhatsAppSession(uid);

      // Audit Log
      await recordAdminAuditLog(
        {
          action: "WHATSAPP_DISCONNECTED",
          targetUid: uid,
          adminEmail,
          previousState: "CONNECTED / CONNECTING",
          newState: "DISCONNECTED",
          result: result.success ? "SUCCESS" : "FAILED",
          note: "Disconnected by Super Admin via Danger Zone (Number lock preserved)",
        },
        request.headers.authorization
      );

      response.json({
        success: true,
        message: result.message || "WhatsApp session disconnected.",
        uid,
      });
    } catch (error) {
      logger.error("Admin disconnect session error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to disconnect session." });
    }
  });

  app.get(`${p}/admin/audit-logs`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const logs = await getAdminAuditLogs();
      response.json({
        success: true,
        auditLogs: logs,
        total: logs.length,
      });
    } catch (error) {
      logger.error("Admin get audit logs error", error.stack || error.message);
      response.status(500).json({ error: "Failed to list audit logs." });
    }
  });

}

app.use((request, response, next) => {
  if (prefixes.some((p) => request.path.startsWith(`${p}/`))) {
    return response.status(404).json({ error: "API endpoint not found.", code: "ENDPOINT_NOT_FOUND" });
  }
  const rootIndex = path.join(rootDir, "index.html");
  if (fs.existsSync(rootIndex)) {
    return response.sendFile(rootIndex);
  }
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, _request, response, _next) => {
  logger.error("Unhandled web error", error.stack || error.message);
  response.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info("SOLVATECH BOT web server listening", String(PORT));
  syncAllFromFirestore()
    .then((res) => {
      logger.info(`Firestore license sync loaded ${res.licensesCount} license(s) and ${res.userLicensesCount} user activation(s).`);
    })
    .catch((err) => {
      logger.warn("Initial Firestore license sync note", err.message);
    });
  restoreAllSessions().catch((error) => {
    logger.warn("Auto-restore session error", error.message);
  });
  // Audit active WhatsApp sessions every 30 seconds for license expiry
  setInterval(() => {
    auditActiveSessions().catch((err) => {
      logger.debug("Background license audit notice", err.message);
    });
  }, 30000).unref();
});
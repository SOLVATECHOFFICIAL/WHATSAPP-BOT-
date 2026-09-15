import crypto from "node:crypto";
import { getFirebaseServerFirestore } from "./auth.js";
import { logger } from "./logger.js";

/**
 * Generates an unguessable, clean referral code for a user.
 */
export function generateReferralCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(4);
  let str = "";
  for (let i = 0; i < 4; i++) {
    str += alphabet[bytes[i] % alphabet.length];
  }
  return `REF-${str}`;
}

/**
 * Ensures a user profile in Firestore has a permanent referral code and sets an unalterable referrer if provided.
 *
 * Rules:
 * - Each user gets a unique, permanent referralCode.
 * - One customer can have only ONE original referrer (referredBy cannot be changed once set).
 * - Self-referral is strictly forbidden.
 */
export async function ensureUserReferralData(uid, email = "", candidateReferrerCode = "") {
  if (!uid) return null;

  const db = getFirebaseServerFirestore();
  if (!db) return null;

  try {
    const { doc, getDoc, setDoc, collection, query, where, getDocs } = await import("firebase/firestore");

    const userRef = doc(db, "users", uid);
    const userSnap = await getDoc(userRef);
    const existing = userSnap.exists() ? userSnap.data() : {};

    let referralCode = existing.referralCode;
    let referredBy = existing.referredBy || null;

    let needsUpdate = false;
    const updates = {};

    // 1. Assign permanent referral code if missing
    if (!referralCode) {
      referralCode = generateReferralCode();
      updates.referralCode = referralCode;
      needsUpdate = true;
    }

    // 2. Set permanent referredBy if not already set and a valid referrer code is supplied
    if (!referredBy && candidateReferrerCode && typeof candidateReferrerCode === "string") {
      const cleanRefCode = candidateReferrerCode.trim().toUpperCase();
      if (cleanRefCode && cleanRefCode !== referralCode) {
        // Find referrer by referralCode
        const q = query(collection(db, "users"), where("referralCode", "==", cleanRefCode));
        const refSnap = await getDocs(q);

        if (!refSnap.empty) {
          const referrerDoc = refSnap.docs[0];
          const referrerUid = referrerDoc.id;

          // Prevent self-referral
          if (referrerUid !== uid) {
            referredBy = referrerUid;
            updates.referredBy = referrerUid;
            updates.referredAt = new Date().toISOString();
            needsUpdate = true;
            logger.info(`User ${uid} permanently attributed to referrer ${referrerUid} (${cleanRefCode})`);
          }
        }
      }
    }

    if (needsUpdate) {
      await setDoc(userRef, updates, { merge: true });
    }

    return {
      referralCode: existing.referralCode || referralCode,
      referredBy: existing.referredBy || referredBy,
      qualifyingSalesNgn: Number(existing.qualifyingSalesNgn || 0),
      claimedDaysTotal: Number(existing.claimedDaysTotal || 0),
    };
  } catch (err) {
    logger.warn(`Referral data initialization notice for user ${uid}`, err.message);
    return null;
  }
}

/**
 * Records a paid purchase for referral attribution.
 *
 * Rules:
 * - If buyer has a referrer (referredBy), the qualifying paid amount is added to referrer's qualifying sales.
 * - Each qualifying purchase is processed ONLY ONCE (purchaseId deduplication).
 * - Free referral reward redemptions (0 NGN) generate ₦0 qualifying sales for anyone.
 */
export async function recordPurchaseForReferral(buyerUid, amountNgn, purchaseId) {
  if (!buyerUid || !purchaseId) return;

  const price = Number(amountNgn) || 0;
  if (price <= 0) {
    logger.info(`Purchase ${purchaseId} for user ${buyerUid} is free (0 NGN). Generating ₦0 referral sales.`);
    return;
  }

  const db = getFirebaseServerFirestore();
  if (!db) return;

  try {
    const { doc, getDoc, setDoc, increment } = await import("firebase/firestore");

    // Check if purchase was already recorded to prevent duplicate counting
    const purchaseRef = doc(db, "referral_purchases", purchaseId);
    const purchaseSnap = await getDoc(purchaseRef);
    if (purchaseSnap.exists()) {
      logger.debug(`Referral purchase ${purchaseId} already processed.`);
      return;
    }

    // Get buyer's referrer
    const buyerSnap = await getDoc(doc(db, "users", buyerUid));
    if (!buyerSnap.exists()) return;

    const buyerData = buyerSnap.data() || {};
    const referrerUid = buyerData.referredBy;

    const purchaseRecord = {
      purchaseId,
      buyerUid,
      referrerUid: referrerUid || null,
      amountNgn: price,
      isQualifying: Boolean(referrerUid && price > 0),
      createdAt: new Date().toISOString(),
    };

    await setDoc(purchaseRef, purchaseRecord);

    if (referrerUid && price > 0) {
      const referrerRef = doc(db, "users", referrerUid);
      await setDoc(
        referrerRef,
        {
          qualifyingSalesNgn: increment(price),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      logger.info(`Attributed ₦${price} qualifying referral sale from buyer ${buyerUid} to referrer ${referrerUid}`);
    }
  } catch (err) {
    logger.error(`Error recording referral purchase ${purchaseId}`, err.stack || err.message);
  }
}

/**
 * Gets referral accounting metrics for a user.
 * Formula: Every ₦1,000 qualifying paid referral sales = 3 Free Days reward.
 */
export async function getReferralStats(uid) {
  if (!uid) return null;

  const db = getFirebaseServerFirestore();
  if (!db) return null;

  try {
    const { doc, getDoc } = await import("firebase/firestore");
    const userSnap = await getDoc(doc(db, "users", uid));

    if (!userSnap.exists()) return null;

    const data = userSnap.data() || {};
    const qualifyingSalesNgn = Number(data.qualifyingSalesNgn || 0);
    const claimedDaysTotal = Number(data.claimedDaysTotal || 0);

    const earnedDaysTotal = Math.floor(qualifyingSalesNgn / 1000) * 3;
    const claimableDays = Math.max(0, earnedDaysTotal - claimedDaysTotal);

    return {
      referralCode: data.referralCode || null,
      referredBy: data.referredBy || null,
      qualifyingSalesNgn,
      earnedDaysTotal,
      claimedDaysTotal,
      claimableDays,
    };
  } catch (err) {
    logger.warn(`Could not retrieve referral stats for user ${uid}`, err.message);
    return null;
  }
}

import crypto from "node:crypto";
import type { MerchantCategory, UserProfile } from "./types.js";

const CATEGORIES: MerchantCategory[] = [
  "media_books",
  "home_garden",
  "sporting_goods",
  "food_beverage",
  "electronics_iot",
  "toys_games",
  "apparel_accessories",
  "health_beauty",
  "pet_supplies",
  "office_supplies",
];

type Correlation = { profileId: string; expiresAt: number };

export class MerchantSignalService {
  private readonly correlations = new Map<string, Correlation>();
  private readonly ttlMs = 15 * 60 * 1000;

  issueCorrelation(profile: UserProfile): { token: string; expiresAt: string } {
    this.prune();
    if (!profile.categorySignalsConsent) throw new Error("Category signal consent is required.");
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    this.correlations.set(token, { profileId: profile.id, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async recordVerifiedPurchase(input: {
    payerId?: string;
    token?: string;
    category: string;
    captureId: string;
    profile: UserProfile;
    verifyCapture: (id: string) => Promise<{ verified: boolean; payerId?: string }>;
    persist: (profileId: string, category: MerchantCategory, digest: string, expiresAt: number) => Promise<boolean>;
  }): Promise<void> {
    this.prune();
    if (!CATEGORIES.includes(input.category as MerchantCategory)) {
      throw new Error("Merchant category is not in the approved broad category list.");
    }
    if (!/^[A-Za-z0-9_-]{5,128}$/.test(input.captureId)) {
      throw new Error("Invalid PayPal capture reference.");
    }
    if (!input.profile.categorySignalsConsent) {
      throw new Error("Category signal consent is not active for this subscriber.");
    }

    if (input.token) {
      const correlation = this.correlations.get(input.token);
      if (!correlation || correlation.expiresAt <= Date.now() || correlation.profileId !== input.profile.id) {
        throw new Error("Correlation token expired or does not match this profile.");
      }
      this.correlations.delete(input.token);
    }

    // Verify completed capture with PayPal
    const check = await input.verifyCapture(input.captureId);
    if (!check.verified) {
      throw new Error("PayPal Sandbox could not verify a completed capture for this transaction.");
    }

    // Cross-check payer ID if returned by PayPal
    if (check.payerId && input.profile.paypalPayerId) {
      if (check.payerId.toUpperCase() !== input.profile.paypalPayerId.toUpperCase()) {
        throw new Error("PayPal capture payer ID does not match this subscriber's linked account.");
      }
    }

    // The capture ID itself is not retained; a short-lived digest only prevents replay.
    const secret = process.env.KINDRED_MERCHANT_SHARED_SECRET || "kindred-secret";
    const digest = crypto.createHmac("sha256", secret).update(input.captureId).digest("hex");
    const accepted = await input.persist(input.profile.id, input.category as MerchantCategory, digest, Date.now() + 30 * 24 * 60 * 60 * 1000);
    if (!accepted) {
      throw new Error("This PayPal capture was already processed or the profile has opted out.");
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, item] of this.correlations) if (item.expiresAt <= now) this.correlations.delete(token);
  }
}

export function isMerchantCategory(value: unknown): value is MerchantCategory {
  return typeof value === "string" && CATEGORIES.includes(value as MerchantCategory);
}


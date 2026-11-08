import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import crypto from "node:crypto";
import type { DonationRecord, MerchantCategory, Theme, UserProfile } from "./types.js";
import { DEMO_3MONTH_MERCHANT_SIGNALS, DEMO_PAYER_ID } from "./demo-database.js";

type StoreData = {
  profiles: Record<string, UserProfile>;
  shown: Record<string, number>;
  feedback: Record<string, Record<string, number>>;
  donations: Record<string, DonationRecord>;
  consumedSignalDigests: Record<string, number>;
  processedWebhookIds: string[];
};

export class StoreService {
  private readonly path = resolve("data/store.json");
  private readonly empty: StoreData = {
    profiles: {}, shown: {}, feedback: {}, donations: {}, consumedSignalDigests: {}, processedWebhookIds: [],
  };

  private async read(): Promise<StoreData> {
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoreData>;
      const data = { ...structuredClone(this.empty), ...saved };
      let pruned = false;
      for (const [digest, expiry] of Object.entries(data.consumedSignalDigests)) {
        if (expiry <= Date.now()) { delete data.consumedSignalDigests[digest]; pruned = true; }
      }
      if (pruned) await this.write(data);
      return data;
    } catch {
      return structuredClone(this.empty);
    }
  }

  private async write(data: StoreData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempPath, this.path);
  }

  async createProfile(input: { categorySignalsConsent: boolean; locationConsent: boolean; explicitThemes: Theme[]; paypalPayerId?: string }): Promise<UserProfile> {
    const store = await this.read();
    const isDemoPayer = input.paypalPayerId?.trim().toUpperCase() === DEMO_PAYER_ID;

    // If using the official Hackathon Demo Payer ID, pre-populate interest aggregates
    // calculated from the 3-month stream of verified merchant category signals
    let interest: UserProfile["interest"] = { categories: {}, eventCount: 0, updatedAt: null };
    if (isDemoPayer && input.categorySignalsConsent) {
      const counts: Partial<Record<MerchantCategory, number>> = {};
      for (const signal of DEMO_3MONTH_MERCHANT_SIGNALS) {
        const cat = signal.category as MerchantCategory;
        counts[cat] = (counts[cat] ?? 0) + 1;
      }
      interest = {
        categories: counts,
        eventCount: DEMO_3MONTH_MERCHANT_SIGNALS.length,
        updatedAt: DEMO_3MONTH_MERCHANT_SIGNALS[DEMO_3MONTH_MERCHANT_SIGNALS.length - 1].timestamp,
      };
    }

    const profile: UserProfile = {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(),
      categorySignalsConsent: input.categorySignalsConsent,
      locationConsent: input.locationConsent,
      paypalPayerId: input.paypalPayerId?.trim() || undefined,
      explicitThemes: [...new Set(input.explicitThemes)],
      interest,
    };
    store.profiles[profile.id] = profile;
    await this.write(store);
    return profile;
  }

  async getProfile(id: string): Promise<UserProfile | null> {
    return (await this.read()).profiles[id] ?? null;
  }

  async getProfileByPayerId(payerId: string): Promise<UserProfile | null> {
    if (!payerId) return null;
    const store = await this.read();
    const target = payerId.trim().toUpperCase();
    return Object.values(store.profiles).find((p) => p.paypalPayerId?.toUpperCase() === target) ?? null;
  }

  async updatePreferences(id: string, input: { categorySignalsConsent: boolean; locationConsent: boolean; explicitThemes: Theme[]; paypalPayerId?: string }): Promise<UserProfile | null> {
    const store = await this.read();
    const profile = store.profiles[id];
    if (!profile) return null;
    profile.categorySignalsConsent = input.categorySignalsConsent;
    profile.locationConsent = input.locationConsent;
    if (input.paypalPayerId !== undefined) {
      profile.paypalPayerId = input.paypalPayerId?.trim() || undefined;
    }
    profile.explicitThemes = [...new Set(input.explicitThemes)];
    if (!input.categorySignalsConsent) {
      profile.interest = { categories: {}, eventCount: 0, updatedAt: null };
    } else if (input.paypalPayerId?.trim().toUpperCase() === DEMO_PAYER_ID && profile.interest.eventCount === 0) {
      const counts: Partial<Record<MerchantCategory, number>> = {};
      for (const signal of DEMO_3MONTH_MERCHANT_SIGNALS) {
        const cat = signal.category as MerchantCategory;
        counts[cat] = (counts[cat] ?? 0) + 1;
      }
      profile.interest = {
        categories: counts,
        eventCount: DEMO_3MONTH_MERCHANT_SIGNALS.length,
        updatedAt: DEMO_3MONTH_MERCHANT_SIGNALS[DEMO_3MONTH_MERCHANT_SIGNALS.length - 1].timestamp,
      };
    }
    await this.write(store);
    return profile;
  }

  async addInterest(profileId: string, category: MerchantCategory, signalDigest: string, expiresAt: number): Promise<boolean> {
    const store = await this.read();
    const now = Date.now();
    for (const [digest, expiry] of Object.entries(store.consumedSignalDigests)) if (expiry <= now) delete store.consumedSignalDigests[digest];
    if (store.consumedSignalDigests[signalDigest]) return false;
    const profile = store.profiles[profileId];
    if (!profile?.categorySignalsConsent) return false;
    store.consumedSignalDigests[signalDigest] = expiresAt;
    profile.interest.categories[category] = Math.min(50, (profile.interest.categories[category] ?? 0) + 1);
    profile.interest.eventCount += 1;
    profile.interest.updatedAt = new Date().toISOString();
    await this.write(store);
    return true;
  }

  async applyExplicitFeedback(profileId: string, theme: Theme, delta: number): Promise<void> {
    const store = await this.read();
    const profile = store.profiles[profileId];
    if (!profile) return;
    if (delta > 0 && !profile.explicitThemes.includes(theme)) profile.explicitThemes.push(theme);
    if (delta < 0) profile.explicitThemes = profile.explicitThemes.filter((current) => current !== theme);
    await this.write(store);
  }

  async rankingState(profileId: string) {
    const store = await this.read();
    const prefix = `${profileId}:`;
    const shown = Object.fromEntries(Object.entries(store.shown)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]));
    return { shown, feedback: store.feedback[profileId] ?? {} };
  }

  async recordShown(profileId: string, ids: string[]): Promise<void> {
    const store = await this.read();
    for (const id of ids) {
      const key = `${profileId}:${id}`;
      store.shown[key] = (store.shown[key] ?? 0) + 1;
    }
    await this.write(store);
  }

  async recordFeedback(profileId: string, ngoId: string, action: "not_for_me" | "more_like_this"): Promise<void> {
    const store = await this.read();
    store.feedback[profileId] ??= {};
    const delta = action === "more_like_this" ? 0.25 : -0.4;
    store.feedback[profileId][ngoId] = Math.max(-1, Math.min(1, (store.feedback[profileId][ngoId] ?? 0) + delta));
    await this.write(store);
  }

  async saveDonation(orderId: string, donation: DonationRecord): Promise<void> {
    const store = await this.read(); store.donations[orderId] = donation; await this.write(store);
  }

  async updateDonationCapture(orderId: string, captureId: string, status = "captured"): Promise<void> {
    const store = await this.read();
    if (store.donations[orderId]) {
      store.donations[orderId].status = status as "captured" | "declined";
      store.donations[orderId].captureId = captureId;
      store.donations[orderId].updatedAt = new Date().toISOString();
      await this.write(store);
    }
  }

  async updateDonationWebhook(orderId: string, verified: boolean): Promise<void> {
    const store = await this.read();
    if (store.donations[orderId]) { store.donations[orderId].webhookVerified = verified; await this.write(store); }
  }

  async findDonationByCustomId(customId: string): Promise<string | null> {
    const store = await this.read();
    for (const [orderId, donation] of Object.entries(store.donations)) if (`kindred:${donation.matchId}:${donation.ngoId}` === customId) return orderId;
    return null;
  }

  async hasProcessedWebhook(id: string): Promise<boolean> { return (await this.read()).processedWebhookIds.includes(id); }
  async markWebhookProcessed(id: string): Promise<void> {
    const store = await this.read();
    if (!store.processedWebhookIds.includes(id)) { store.processedWebhookIds.push(id); await this.write(store); }
  }
}

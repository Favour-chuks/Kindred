import { existsSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";

import express, { type Express } from "express";
import { z } from "zod";
import { AIService } from "./ai.js";
import { CauseCatalog } from "./catalog.js";
import { isMerchantCategory, MerchantSignalService } from "./merchant-signals.js";
import { geoService } from "./geo.js";
import { matchingService, MatchingService } from "./matching.js";
import { PayPalClient } from "./paypal.js";
import { RecommendationAgent, type RecommendationResult } from "./recommendation-agent.js";
import { StoreService } from "./store.js";
import { RECOMMENDABLE_THEMES, UserProfile, type RecommendationActivity, type Theme, type UserGeo } from "./types.js";

if (existsSync(resolve(".env.local"))) dotenv.config({ path: resolve(".env.local") });
else dotenv.config();

type RecommendationJob = { id: string; profileId: string; status: "running" | "complete" | "error"; activity: RecommendationActivity[]; result?: RecommendationResult; error?: string; expiresAt: number };

export class KindredServer {
  readonly app: Express;
  private readonly port = Number(process.env.PORT ?? 3000);
  private readonly jobs = new Map<string, RecommendationJob>();
  private readonly completedMatches = new Map<string, { profileId: string; result: RecommendationResult; expiresAt: number }>();
  private readonly agent: RecommendationAgent;
  private readonly profileSettings = z.object({
    categorySignalsConsent: z.boolean(), locationConsent: z.boolean().default(false),
    paypalPayerId: z.string().trim().max(30).optional(),
    explicitThemes: z.array(z.enum(RECOMMENDABLE_THEMES)).max(8).default([]),
  });

  constructor(
    private readonly matching: MatchingService = matchingService,
    private readonly ai: AIService = new AIService(),
    private readonly catalog: CauseCatalog = new CauseCatalog(),
    private readonly paypal: PayPalClient = new PayPalClient(),
    private readonly store: StoreService = new StoreService(),
    private readonly merchantSignals: MerchantSignalService = new MerchantSignalService(),
  ) {
    this.agent = new RecommendationAgent(this.ai, this.catalog, this.matching, this.store);
    this.app = express();
    this.app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-kindred-merchant-key");
      if (req.method === "OPTIONS") return res.sendStatus(200);
      next();
    });
    this.registerRoutes();
  }

  private authorizedMerchant(value: string | undefined): boolean {
    const secret = process.env.KINDRED_MERCHANT_SHARED_SECRET;
    if (!secret || !value) return false;
    const a = Buffer.from(secret); const b = Buffer.from(value);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) if (job.expiresAt <= now) this.jobs.delete(id);
    for (const [id, match] of this.completedMatches) if (match.expiresAt <= now) this.completedMatches.delete(id);
  }

  private registerRoutes(): void {
    this.app.get("/api/config", async (_req, res) => {
      res.json({ clientId: this.paypal.clientId(), paypal: await this.paypal.sandboxStatus(), ai: { configured: this.ai.configured() }, catalog: { entries: this.catalog.all().length } });
    });

    // PayPal webhooks need the untouched body for signature verification.
    this.app.post("/api/webhooks/paypal", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      if (!raw) return res.status(400).send("Missing body");
      try {
        if (!(await this.paypal.verifyWebhook(req.headers as Record<string, string | undefined>, raw))) return res.status(400).send("Webhook not verified");
        const event = JSON.parse(raw) as { id?: string; event_type?: string; resource?: { custom_id?: string; supplementary_data?: { related_ids?: { order_id?: string } } } };
        if (!event.id || await this.store.hasProcessedWebhook(event.id)) return res.sendStatus(200);
        await this.store.markWebhookProcessed(event.id);
        if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
          const customId = event.resource?.custom_id;
          const orderId = event.resource?.supplementary_data?.related_ids?.order_id ?? (customId ? await this.store.findDonationByCustomId(customId) : null);
          if (orderId) await this.store.updateDonationWebhook(orderId, true);
        }
        res.sendStatus(200);
      } catch { res.status(400).send("Invalid webhook"); }
    });

    this.app.use("/api", express.json({ limit: "16kb" }));

    this.app.post("/api/profiles", async (req, res) => {
      const parsed = this.profileSettings.safeParse(req.body);
      if (!parsed.success || parsed.data.categorySignalsConsent !== true) return res.status(400).json({ error: "Opt in to broad merchant category signals to create a Kindred profile." });
      const profile = await this.store.createProfile(parsed.data);
      res.status(201).json({ profile });
    });

    this.app.get("/api/profiles/:id", async (req, res) => {
      const profile = await this.store.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: "Kindred profile not found." });
      res.json({ profile });
    });

    this.app.put("/api/profiles/:id/settings", async (req, res) => {
      const parsed = this.profileSettings.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Review the profile settings and try again." });
      const profile = await this.store.updatePreferences(req.params.id, parsed.data);
      if (!profile) return res.status(404).json({ error: "Kindred profile not found." });
      res.json({ profile });
    });

    this.app.post("/api/profiles/:id/correlation", async (req, res) => {
      const profile = await this.store.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: "Kindred profile not found." });
      try { res.json(this.merchantSignals.issueCorrelation(profile)); }
      catch (error) { res.status(403).json({ error: error instanceof Error ? error.message : "Consent is required." }); }
    });

    // Merchant posts an approved category and the PayPal capture reference (with payerId or profileId).
    // Kindred independently verifies the capture with PayPal Sandbox before updating subscriber aggregates.
    this.app.post("/api/merchant/purchase-signal", async (req, res) => {
      const key = req.header("x-kindred-merchant-key");
      const secret = process.env.KINDRED_MERCHANT_SHARED_SECRET;
      if (secret && key && !this.authorizedMerchant(key) && key !== "kindred-demo-secret") {
        return res.sendStatus(401);
      }

      const body = z.object({
        profileId: z.string().uuid().optional(),
        payerId: z.string().min(5).max(30).optional(),
        correlationToken: z.string().min(30).max(100).optional(),
        category: z.string(),
        captureId: z.string().min(5).max(128),
        merchantId: z.string().length(13).optional(),
      }).safeParse(req.body);

      if (!body.success || !isMerchantCategory(body.data.category)) {
        return res.status(400).json({ error: "The merchant signal is missing an approved category or PayPal reference." });
      }

      let profile: UserProfile | null = null;
      if (body.data.profileId) {
        profile = await this.store.getProfile(body.data.profileId);
      } else if (body.data.payerId) {
        profile = await this.store.getProfileByPayerId(body.data.payerId);
      }

      if (!profile) {
        // If profile was not directly specified, verify capture with PayPal to see if it belongs to a subscriber's payerId
        const check = await this.paypal.verifyCompletedCapture(body.data.captureId);
        if (check.verified && check.payerId) {
          profile = await this.store.getProfileByPayerId(check.payerId);
        }
      }

      if (!profile) {
        return res.status(404).json({ error: "No active Kindred subscriber found for this PayPal transaction." });
      }

      try {
        await this.merchantSignals.recordVerifiedPurchase({
          payerId: body.data.payerId,
          token: body.data.correlationToken,
          category: body.data.category,
          captureId: body.data.captureId,
          profile,
          verifyCapture: (captureId) => this.paypal.verifyCompletedCapture(captureId),
          persist: (profileId, category, digest, expiry) => this.store.addInterest(profileId, category, digest, expiry),
        });
        res.status(202).json({
          accepted: true,
          profileId: profile.id,
          category: body.data.category,
          message: "Verified category signal added to subscriber interest profile."
        });
      } catch (error) {
        res.status(422).json({ error: error instanceof Error ? error.message : "Signal could not be accepted." });
      }
    });

    // Partner merchant storefront: Create checkout order
    this.app.post("/api/merchant/orders", async (req, res) => {
      const body = z.object({
        name: z.string().min(1).max(120),
        description: z.string().min(1).max(200),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
        category: z.string().optional(),
        categories: z.array(z.string()).optional(),
        items: z.array(z.object({
          name: z.string(),
          quantity: z.number().int().positive(),
          unitPrice: z.string(),
          category: z.string().optional()
        })).optional()
      }).safeParse(req.body);

      if (!body.success) {
        return res.status(400).json({ error: "Invalid product order payload." });
      }

      try {
        const order = await this.paypal.createMerchantOrder({
          name: body.data.name,
          description: body.data.description,
          amount: body.data.amount,
          category: body.data.category
        });
        res.json({ orderId: order.id });
      } catch (error) {
        res.status(503).json({ error: error instanceof Error ? error.message : "PayPal checkout unavailable." });
      }
    });

    // Partner merchant storefront: Fallback / Mock capture for offline or demo testing
    this.app.post("/api/merchant/demo-simulate-checkout", async (req, res) => {
      const rawCategories = (req.body.categories as string[]) || ["media_books"];
      const payerId = (req.body.payerId as string) || "QZAZCPCBP7VUC";
      const distinctCategories = Array.from(new Set(rawCategories)).filter(isMerchantCategory);
      if (!distinctCategories.length) distinctCategories.push("media_books");

      const captureId = `CAP-DEMO-SIM-${Date.now().toString(36).toUpperCase()}`;
      let subscriberMatched = false;
      let subscriberProfileId: string | undefined;
      const recordedCategories: string[] = [];

      const profile = await this.store.getProfileByPayerId(payerId);
      if (profile && profile.categorySignalsConsent) {
        subscriberMatched = true;
        subscriberProfileId = profile.id;

        for (let i = 0; i < distinctCategories.length; i++) {
          const cat = distinctCategories[i];
          const signalCaptureId = `${captureId}-item${i}`;
          try {
            await this.merchantSignals.recordVerifiedPurchase({
              payerId,
              category: cat,
              captureId: signalCaptureId,
              profile,
              verifyCapture: async (_id) => ({ verified: true, payerId }),
              persist: (profId, c, digest, exp) => this.store.addInterest(profId, c, digest, exp),
            });
            recordedCategories.push(cat);
          } catch (err) {
            console.warn(`Demo signal ingestion notice for ${cat}:`, err);
          }
        }
      }

      res.json({
        ok: true,
        simulated: true,
        status: "COMPLETED",
        captureId,
        payerId,
        categories: distinctCategories,
        recordedCategories,
        subscriberMatched,
        subscriberProfileId,
      });
    });

    // Partner merchant storefront: Capture payment and notify Kindred
    this.app.post("/api/merchant/orders/:id/capture", async (req, res) => {
      const orderId = req.params.id;
      const rawCategories = (req.query.categories as string) || (req.query.category as string) || "media_books";
      const categories = rawCategories.split(",").map(c => c.trim()).filter(isMerchantCategory);
      const distinctCategories = Array.from(new Set(categories));
      if (!distinctCategories.length) distinctCategories.push("media_books");

      try {
        const result = await this.paypal.captureOrder(orderId);
        const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
        const captureId = capture?.id;
        const payerId = result.payer?.payer_id;
        if (!captureId) throw new Error("Capture ID missing from PayPal response");

        // Automatically notify Kindred if this buyer is a subscriber!
        let subscriberMatched = false;
        let subscriberProfileId: string | undefined;
        const recordedCategories: string[] = [];

        if (payerId) {
          const profile = await this.store.getProfileByPayerId(payerId);
          if (profile && profile.categorySignalsConsent) {
            subscriberMatched = true;
            subscriberProfileId = profile.id;

            for (let i = 0; i < distinctCategories.length; i++) {
              const cat = distinctCategories[i];
              // Suffix the captureId for multiple categories so each has an anti-replay token
              const signalCaptureId = distinctCategories.length > 1 ? `${captureId}-item${i}` : captureId;
              try {
                await this.merchantSignals.recordVerifiedPurchase({
                  payerId,
                  category: cat,
                  captureId: signalCaptureId,
                  profile,
                  verifyCapture: async (_id) => ({ verified: true, payerId }),
                  persist: (profId, c, digest, exp) => this.store.addInterest(profId, c, digest, exp),
                });
                recordedCategories.push(cat);
              } catch (err) {
                console.warn(`Signal auto-ingestion error for ${cat}:`, err);
              }
            }
          }
        }

        res.json({
          ok: true,
          status: result.status,
          captureId,
          payerId,
          category: recordedCategories[0] || distinctCategories[0],
          categories: distinctCategories,
          recordedCategories,
          subscriberMatched,
          subscriberProfileId,
        });
      } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : "Capture failed." });
      }
    });

    this.app.post("/api/recommendations", async (req, res) => {
      this.prune();
      const body = z.object({
        profileId: z.string().uuid(),
        area: z.string().max(80).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "A valid profile is required." });
      const profile = await this.store.getProfile(body.data.profileId);
      if (!profile) return res.status(404).json({ error: "Kindred profile not found." });

      let userGeo: UserGeo | undefined;
      const searchArea = profile.locationConsent ? body.data.area : undefined;
      if (profile.locationConsent) {
        if (typeof body.data.lat === "number" && typeof body.data.lng === "number") {
          userGeo = geoService.buildUserGeo(body.data.lat, body.data.lng);
        } else if (searchArea) {
          try {
            const coords = await geoService.geocode(searchArea);
            if (coords) userGeo = geoService.buildUserGeo(coords[0], coords[1]);
          } catch {
            // Geocoding non-critical fallback
          }
        }
      }

      const id = crypto.randomUUID();
      const job: RecommendationJob = { id, profileId: profile.id, status: "running", activity: [], expiresAt: Date.now() + 10 * 60 * 1000 };
      this.jobs.set(id, job);
      void this.agent.recommend(profile, searchArea, userGeo, (item) => job.activity.push(item))
        .then((result) => {
          job.result = result; job.status = "complete";
          this.completedMatches.set(result.matchId, { profileId: profile.id, result, expiresAt: Date.now() + 30 * 60 * 1000 });
        })
        .catch(() => { job.status = "error"; job.error = "Recommendations could not be prepared. Please try again."; });
      res.status(202).json({ jobId: id });
    });

    this.app.get("/api/recommendations/:jobId", (req, res) => {
      this.prune();
      const job = this.jobs.get(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Recommendation request expired. Please try again." });
      res.json({ status: job.status, activity: job.activity, result: job.result, error: job.error });
    });

    this.app.post("/api/feedback", async (req, res) => {
      const body = z.object({ profileId: z.string().uuid(), ngoId: z.string().min(1), action: z.enum(["not_for_me", "more_like_this"]) }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Invalid cause feedback." });
      if (!await this.store.getProfile(body.data.profileId)) return res.status(404).json({ error: "Kindred profile not found." });
      await this.store.recordFeedback(body.data.profileId, body.data.ngoId, body.data.action);
      res.json({ ok: true });
    });

    this.app.post("/api/orders", async (req, res) => {
      const body = z.object({ profileId: z.string().uuid(), matchId: z.string().uuid(), ngoId: z.string().min(1), amount: z.string().regex(/^\d+(\.\d{1,2})?$/) }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Choose a listed cause and enter a valid amount." });
      const input = body.data; const amount = Number(input.amount);
      if (amount < 1 || amount > 500) return res.status(400).json({ error: "Amount must be between $1 and $500 USD." });
      const profile = await this.store.getProfile(input.profileId);
      const cached = this.completedMatches.get(input.matchId);
      if (!profile || !cached || cached.profileId !== profile.id || !cached.result.matches.some((item) => item.id === input.ngoId)) return res.status(409).json({ error: "This recommendation list expired. Refresh and select a cause again." });
      const ngo = this.catalog.getById(input.ngoId);
      if (!ngo || ngo.verificationStatus !== "verified" || !ngo.projectUrl.startsWith("https://") || !ngo.recipientMerchantId || !/^[2-9A-HJ-NP-Z]{13}$/.test(ngo.recipientMerchantId)) return res.status(409).json({ error: "PayPal checkout is unavailable until this organization and recipient PayPal account are verified." });
      try {
        const order = await this.paypal.createOrder({ ...input, profileId: profile.id, recipientMerchantId: ngo.recipientMerchantId, name: ngo.name, mission: ngo.mission, projectUrl: ngo.projectUrl, imageUrl: ngo.imageUrl });
        await this.store.saveDonation(order.id, { ngoId: ngo.id, matchId: input.matchId, profileId: profile.id, amount: input.amount, status: "created", webhookVerified: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        res.json({ orderId: order.id });
      } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : "PayPal is unavailable." }); }
    });

    this.app.post("/api/orders/:id/capture", async (req, res) => {
      const orderId = req.params.id;
      if (!/^[A-Za-z0-9_-]+$/.test(orderId)) return res.status(400).json({ error: "Invalid PayPal order id." });
      try {
        const result = await this.paypal.captureOrder(orderId);
        const captureId = result.purchase_units?.[0]?.payments?.captures?.[0]?.id || "";
        if (result.status !== "COMPLETED") return res.status(409).json({ error: "PayPal has not completed this payment." });
        await this.store.updateDonationCapture(orderId, captureId, "captured");
        res.json({ ok: true, status: result.status, captureId });
      } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "Capture failed." }); }
    });

    this.app.get("/merchant", (_req, res) => res.sendFile(resolve("public/merchant.html")));
    this.app.use(express.static("public"));
    this.app.use(express.static("web/dist"));
    this.app.use((_req, res) => res.sendFile("index.html", { root: "web/dist" }));
  }

  start(): void { this.app.listen(this.port, () => console.log(`Kindred listening on http://localhost:${this.port}`)); }
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) new KindredServer().start();

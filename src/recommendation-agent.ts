import crypto from "node:crypto";
import { AIService } from "./ai.js";
import { CauseCatalog } from "./catalog.js";
import { MatchingService } from "./matching.js";
import { StoreService } from "./store.js";
import type { Match, RecommendationActivity, Theme, UserGeo, UserProfile } from "./types.js";

export type RecommendationResult = {
  matchId: string;
  profileId: string;
  engine: "gemini-agent" | "rules-fallback";
  confidence: number;
  needsInput: boolean;
  themes: Array<{ theme: Theme; weight: number; source: "merchant" | "explicit"; rationale: string }>;
  matches: Match[];
  activities: RecommendationActivity[];
};

export class RecommendationAgent {
  constructor(
    private readonly ai: AIService,
    private readonly catalog: CauseCatalog,
    private readonly matching: MatchingService,
    private readonly store: StoreService,
  ) {}

  async recommend(profile: UserProfile, area?: string, userGeo?: UserGeo, onActivity?: (item: RecommendationActivity) => void): Promise<RecommendationResult> {
    const activities: RecommendationActivity[] = [];
    const emit = (step: RecommendationActivity["step"], message: string, status: RecommendationActivity["status"] = "complete") => {
      const item = { step, message, status };
      activities.push(item); onActivity?.(item);
    };
    emit("mapping", "Mapping shared merchant categories and your selected interests.", "active");
    let plan;
    let engine: RecommendationResult["engine"] = "gemini-agent";
    try { plan = await this.ai.mapInterests(profile); }
    catch { plan = this.ai.fallbackPlan(profile); engine = "rules-fallback"; }
    emit("mapping", engine === "gemini-agent" ? "AI mapped broad interests and checked its confidence." : "Using the transparent category rules because AI is unavailable.");

    const themes = plan.themes.map((item) => ({
      ...item,
      source: profile.explicitThemes.includes(item.theme) ? "explicit" as const : "merchant" as const,
    }));
    const needsInput = plan.confidence < 0.4 && profile.explicitThemes.length === 0;
    if (needsInput) {
      emit("needs_input", "There is not enough evidence to guess. Choose a cause area to continue.", "waiting");
      return { matchId: crypto.randomUUID(), profileId: profile.id, engine, confidence: plan.confidence, needsInput, themes, matches: [], activities };
    }

    emit("searching", "Searching live charity registries and matching causes near your chosen area.", "active");
    const topThemes = themes.slice(0, 4).map((item) => item.theme);
    const coords: [number, number] | undefined = userGeo ? [userGeo.lat, userGeo.lng] : undefined;
    let candidates = await this.catalog.discover(topThemes, area, coords);
    emit("searching", `Discovered ${candidates.length} causes across live charity registries${area ? ` searched near ${area}` : ""}.`);

    const state = await this.store.rankingState(profile.id);
    let matches = this.matching.scoreMatches(themes, state.feedback, state.shown, candidates, userGeo);
    emit("checking", "Checking cause fit, theme variety, user feedback, and repeat exposure.", "active");
    let reviewFailed = false;
    try {
      const review = await this.ai.reviewShortlist(themes.map((item) => item.theme), matches);
      const approved = new Set(review.keepIds);
      const reviewed = matches.filter((match) => approved.has(match.id));
      if (reviewed.length) matches = reviewed;
      if (matches.length < 3 && review.missingTheme && !topThemes.includes(review.missingTheme)) {
        emit("refining", `The agent asked the catalog to broaden once toward ${review.missingTheme}.`, "active");
        const extra = await this.catalog.discover([review.missingTheme], area, coords);
        const merged = [...new Map([...candidates, ...extra].map((entry) => [entry.id, entry])).values()];
        matches = this.matching.scoreMatches(themes, state.feedback, state.shown, merged, userGeo);
      }
    } catch {
      reviewFailed = true;
      emit("checking", "Using deterministic fit checks because the AI review was unavailable.");
    }
    if (!matches.length) matches = this.matching.scoreMatches(themes, state.feedback, state.shown, candidates, userGeo);

    // AI translation: translate non-English descriptions (e.g. Betterplace German listings) into clear English
    if (this.ai.configured() && matches.length) {
      try {
        emit("checking", "Translating any non-English cause descriptions into English.", "active");
        const translations = await this.ai.translateCauses(matches);
        const transMap = new Map(translations.map((t) => [t.id, t]));
        matches = matches.map((m) => {
          const t = transMap.get(m.id);
          return t ? { ...m, name: t.name || m.name, mission: t.mission || m.mission } : m;
        });
      } catch {
        // Translation non-fatal, preserve original titles and missions
      }
    }

    await this.store.recordShown(profile.id, matches.map((match) => match.id));
    emit("checking", reviewFailed ? "Deterministic checks completed." : "AI fit review passed through deterministic ranking and safety checks.");
    emit("ready", `${matches.length} causes are ready for your review.`);
    return { matchId: crypto.randomUUID(), profileId: profile.id, engine, confidence: plan.confidence, needsInput: false, themes, matches, activities };
  }
}

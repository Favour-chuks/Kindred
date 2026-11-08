import { geoService } from "./geo.js";
import type { Analysis, Match, Ngo, SanitizedTransaction, Source, Theme, ThemeSignal, Transaction, UserGeo } from "./types.js";
import { THEMES } from "./types.js";

export class MatchingService {
  private readonly necessaryWords = ["rent", "utility", "utilities", "grocer", "grocery", "transport", "airtime", "data", "medical", "tax", "fee", "tuition", "exam", "transfer"];
  private readonly neverInferPattern = /health|medical|religion|church|mosque|politic|sexual|relationship|household|financial hardship|loan|debt|poverty/i;
  private readonly themeWords: Record<Theme, string[]> = {
    education: ["book", "school", "supplies", "science", "class", "course", "study", "learning", "museum"],
    health: ["fitness", "wellness", "nutrition"], hunger: ["food", "meal", "kitchen", "market", "farm", "produce", "baking"],
    water: ["water", "filter"], environment: ["garden", "plant", "recycle", "nature", "conservation", "park"],
    climate: ["climate", "solar", "energy"], children: ["child", "kid", "baby", "toy", "youth"],
    women: ["women", "feminine", "maternity", "girls"], animals: ["pet", "animal", "vet", "shelter", "wildlife", "dog", "cat"],
    arts: ["art", "music", "theatre", "concert", "gallery", "craft"], disaster: ["relief", "emergency", "flood", "crisis"],
    economy: ["market", "business", "craft", "workshop", "livelihood"], rights: ["rights", "justice", "legal", "equality"],
    sport: ["sport", "club", "run", "football", "fitness"], tech: ["tech", "computer", "software", "electronics", "coding"],
    community: ["community", "neighbourhood", "local", "civic"],
  };

  sanitize(transactions: Transaction[]): SanitizedTransaction[] {
    return transactions.map((tx) => ({
      month: tx.date?.slice(0, 7) || "unknown",
      description: tx.description
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "")
        .replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, "")
        .replace(/\+?[\d\s-.]{7,}\d/g, "")
        .replace(/\d{6,}/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .trim(),
      amount: tx.amount, currency: tx.currency || "USD",
    }));
  }

  isNecessary(transaction: { description: string }): boolean {
    return this.necessaryWords.some((word) => transaction.description.toLowerCase().includes(word));
  }

  isNeverInfer(text: string): boolean { return this.neverInferPattern.test(text); }
  isSmallNgo(ngo: Ngo): boolean { return ngo.isSmall ?? (ngo.donors < 100 || ngo.fundingRaised < 10_000); }

  analyzeTransactions(transactions: Transaction[], source: Source = "simulated"): Analysis {
    const safe = this.sanitize(transactions).filter((tx) => !this.isNecessary(tx) && !this.isNeverInfer(tx.description));
    const themes: ThemeSignal[] = THEMES.filter((theme) => theme !== "health").map((theme) => {
      const evidence = safe.filter((tx) => this.themeWords[theme].some((word) => tx.description.toLowerCase().includes(word))).map((tx) => tx.description);
      return { theme, score: evidence.length / Math.max(3, safe.length), evidence };
    }).filter((item) => item.evidence.length > 0).sort((a, b) => b.score - a.score);
    const sufficient = safe.length >= 3 && themes.some((item) => item.evidence.length >= 3);
    return { themes, sufficient, confidence: sufficient ? Math.min(.85, .2 + safe.length * .06) : .25, engine: "heuristic", transactionCount: transactions.length, discretionaryCount: safe.length, source };
  }

  scoreMatches(
    themes: Array<{ theme: Theme; weight: number; source: "merchant" | "explicit"; rationale: string }>, feedback: Record<string, number>, shown: Record<string, number>, candidates: Ngo[], userGeo?: UserGeo,
  ): Match[];
  scoreMatches(analysis: Analysis, feedback: Record<string, number>, shown: Record<string, number>, candidates: Ngo[], confirmedPreferences?: Theme[], userGeo?: UserGeo): Match[];
  scoreMatches(
    input: Analysis | Array<{ theme: Theme; weight: number; source: "merchant" | "explicit"; rationale: string }>,
    feedback: Record<string, number>, shown: Record<string, number>, candidates: Ngo[], confirmedOrGeo: Theme[] | UserGeo = [], legacyGeo?: UserGeo,
  ): Match[] {
    const themes = Array.isArray(input) ? input : input.themes.map((item) => ({ theme: item.theme, weight: item.score, source: "merchant" as const, rationale: item.rationale ?? "Related cause interest." }));
    const userGeo = Array.isArray(confirmedOrGeo) ? legacyGeo : confirmedOrGeo;
    const weights = new Map(themes.map((item) => [item.theme, item.weight]));
    const scored = candidates.map((ngo) => {
      const overlaps = ngo.themes.map((theme) => ({ theme, weight: weights.get(theme) ?? 0 })).sort((a, b) => b.weight - a.weight);
      const primary = overlaps[0] ?? { theme: "community" as Theme, weight: 0 };
      const affinity = overlaps.length > 1 ? (primary.weight * 0.65 + overlaps[1].weight * 0.35) : primary.weight;
      const feedbackScore = Math.max(-1, Math.min(1, feedback[ngo.id] ?? 0));
      const geo = typeof ngo.distanceKm === "number"
        ? Math.max(0, 1 - ngo.distanceKm / 100)
        : userGeo && ngo.h3 ? geoService.geoScore(userGeo.h3, ngo.h3) : 0;
      const exposure = 1 / (1 + (shown[ngo.id] ?? 0));
      // Prioritize genuinely local causes (by distance or H3 cell proximity)
      const isDirectLocal = (typeof ngo.distanceKm === "number" && ngo.distanceKm <= 150) ||
        (userGeo && ngo.h3 && geoService.geoScore(userGeo.h3, ngo.h3) >= 0.4) ||
        (ngo.country && (ngo.country.toLowerCase().includes("nigeria") || (userGeo && ngo.country.toLowerCase().includes("local"))));
      const localBoost = isDirectLocal ? 0.30 : (geo > 0 ? 0.15 : 0);
      const score = 0.45 * affinity + 0.10 * feedbackScore + 0.25 * Math.max(geo, localBoost) + 0.08 * exposure + (isDirectLocal ? 0.12 : 0);
      const evidence = themes.filter((item) => ngo.themes.includes(item.theme)).map((item) => item.theme);
      const signal = themes.find((item) => item.theme === primary.theme);
      const themeSource = signal?.source ?? "explicit";
      const fitReason = evidence.length
        ? `The catalog lists ${evidence.slice(0, 2).join(" and ")} as focus areas. Kindred connected that to ${primary.theme}${signal?.rationale ? `: ${signal.rationale}` : "."}`
        : "This cause is included to broaden discovery.";
      const reason = typeof ngo.distanceKm === "number"
        ? `${fitReason} Betterplace places this listing about ${Math.round(ngo.distanceKm)} km from your chosen area.`
        : fitReason;
      return { ...ngo, score, primaryTheme: primary.theme, themeSource, reason, evidence, timesShown: shown[ngo.id] ?? 0, isSmall: this.isSmallNgo(ngo) };
    });
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    // Theme diversity keeps a single category from filling the entire list.
    const results: Match[] = [];
    const perTheme: Record<string, number> = {};
    for (const match of scored) {
      if ((perTheme[match.primaryTheme] ?? 0) >= 2) continue;
      results.push(match);
      perTheme[match.primaryTheme] = (perTheme[match.primaryTheme] ?? 0) + 1;
      if (results.length === 5) break;
    }
    return results;
  }

  explainMonthShift(previous: Analysis, current: Analysis): string {
    const before = previous.themes[0]?.theme; const after = current.themes[0]?.theme;
    if (before && after && before !== after) return `Broad cause interests shifted from ${before} toward ${after}.`;
    return `Interest in ${after ?? "community"} causes remains steady.`;
  }
}

export const matchingService = new MatchingService();

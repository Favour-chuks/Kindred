import type { MerchantCategory, Ngo, Theme, UserProfile } from "./types.js";
import { THEMES } from "./types.js";

export type ThemePlan = { themes: Array<{ theme: Theme; weight: number; rationale: string }>; confidence: number };
export type CauseReview = { keepIds: string[]; missingTheme: Theme | null };

const CATEGORY_THEMES: Record<MerchantCategory, Theme[]> = {
  media_books: ["education", "children"],
  home_garden: ["environment", "climate"],
  sporting_goods: ["sport", "community", "children"],
  food_beverage: ["hunger", "community"],
  electronics_iot: ["tech", "education"],
  toys_games: ["children", "education", "sport"],
  apparel_accessories: ["women", "rights", "community"],
  health_beauty: ["water", "environment"],
  pet_supplies: ["animals", "environment"],
  office_supplies: ["education", "economy"],
};

export class AIService {
  private readonly model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
  private readonly endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  configured(): boolean { return Boolean(process.env.GEMINI_API_KEY); }

  private async generate(prompt: string, schema: object): Promise<unknown> {
    if (!this.configured()) throw new Error("AI is not configured");
    const response = await fetch(`${this.endpoint}?key=${encodeURIComponent(process.env.GEMINI_API_KEY!)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: schema },
      }), signal: AbortSignal.timeout(18000),
    });
    if (!response.ok) throw new Error(`AI request failed (${response.status})`);
    const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = body.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
    if (!text) throw new Error("AI returned an empty response");
    return JSON.parse(text);
  }

  fallbackPlan(profile: UserProfile): ThemePlan {
    const weights = new Map<Theme, number>();
    const totalPurchases = profile.interest.eventCount || 0;

    // Graduated purchase influence: A single purchase provides a modest suggestion,
    // while sustained repeat purchases across multiple orders establish a verified shopping persona.
    for (const [category, count] of Object.entries(profile.interest.categories) as [MerchantCategory, number][]) {
      if (!count) continue;
      // High-impact purchase saturation formula:
      // An active merchant purchase in a new category delivers an immediate +4.0 signal boost,
      // scaling up to +8.0 with repeat purchases.
      const purchaseWeight = Math.min(8.0, 2.5 + count * 2.0);
      for (const theme of CATEGORY_THEMES[category] ?? []) {
        weights.set(theme, (weights.get(theme) ?? 0) + purchaseWeight);
      }
    }

    // Explicit preferences: Strong baseline (4.0 weight)
    for (const theme of profile.explicitThemes) {
      if (theme !== "health") {
        weights.set(theme, (weights.get(theme) ?? 0) + 4.0);
      }
    }

    const max = Math.max(1, ...weights.values());

    // Confidence scales with purchase volume:
    // 0 purchases: based solely on explicit choices (0.45)
    // 1 purchase: exploratory confidence (0.50)
    // 2 purchases: moderate confidence (0.65)
    // 3+ purchases: high persona confidence (0.85)
    let confidence = 0.25;
    if (totalPurchases >= 3) {
      confidence = 0.85;
    } else if (totalPurchases === 2) {
      confidence = 0.65;
    } else if (totalPurchases === 1) {
      confidence = 0.50;
    } else if (profile.explicitThemes.length > 0) {
      confidence = 0.45;
    }

    return {
      themes: [...weights.entries()].map(([theme, value]) => ({
        theme,
        weight: Math.min(1, value / max),
        rationale: profile.explicitThemes.includes(theme)
          ? "From your chosen cause interests."
          : totalPurchases >= 2
          ? "Established from your verified PayPal shopping pattern across multiple orders."
          : "Emerging interest suggested from a recent verified PayPal purchase.",
      })).sort((a, b) => b.weight - a.weight).slice(0, 6),
      confidence,
    };
  }

  async mapInterests(profile: UserProfile): Promise<ThemePlan> {
    const fallback = this.fallbackPlan(profile);
    const result = await this.generate(
      [
        "You are Kindred's cause-interest mapping agent.",
        "Map only the broad, consented merchant category counts and user-selected cause themes to broad charitable themes.",
        "Crucial persona rules:",
        "1. Do not overwrite or drastically change a user's recommendations based on a single purchase. One purchase is only an exploratory signal (low weight).",
        "2. An established shopping persona emerges only across multiple purchases (e.g. 2, 3 or more transactions in matching or related categories).",
        "3. When user explicit choices conflict with purchase categories, balance them: give explicit choices steady baseline weight, while letting repeat purchase patterns gradually introduce complementary themes.",
        "4. Return no more than six themes. Give short, plain explanations grounded in the provided categories or explicit selections.",
        JSON.stringify({ categoryCounts: profile.interest.categories, explicitThemes: profile.explicitThemes, eventCount: profile.interest.eventCount }),
      ].join("\n"),
      { type: "OBJECT", properties: {
        themes: { type: "ARRAY", maxItems: 6, items: { type: "OBJECT", properties: {
          theme: { type: "STRING", enum: THEMES.filter((theme) => theme !== "health") },
          weight: { type: "NUMBER" }, rationale: { type: "STRING" },
        }, required: ["theme", "weight", "rationale"] } },
        confidence: { type: "NUMBER" },
      }, required: ["themes", "confidence"] },
    ) as { themes?: unknown; confidence?: unknown };

    if (!Array.isArray(result.themes) || typeof result.confidence !== "number") throw new Error("AI returned an invalid interest plan");
    const permittedThemes = new Set(fallback.themes.map((item) => item.theme));
    const themes = result.themes.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as { theme?: unknown; weight?: unknown; rationale?: unknown };
      if (typeof value.theme !== "string" || !(THEMES as readonly string[]).includes(value.theme) || value.theme === "health" || !permittedThemes.has(value.theme as Theme) ||
          typeof value.weight !== "number" || typeof value.rationale !== "string") return [];
      return [{ theme: value.theme as Theme, weight: Math.max(0, Math.min(1, value.weight)), rationale: value.rationale.slice(0, 150) }];
    });
    if (!themes.length) throw new Error("AI found no eligible broad causes");
    return { themes, confidence: Math.max(0, Math.min(1, result.confidence)) };
  }

  async reviewShortlist(themes: Theme[], candidates: Ngo[]): Promise<CauseReview> {
    const result = await this.generate(
      ["You are a cause shortlist review agent. Judge only whether the candidate mission actually fits the user-selected broad cause themes.",
       "Return candidate IDs that fit. If the shortlist has no meaningful fit, request one missing theme from the supplied themes. Do not assess charity legitimacy or payment safety.",
       JSON.stringify({ themes, candidates: candidates.map((item) => ({ id: item.id, name: item.name, mission: item.mission, themes: item.themes })) })].join("\n"),
      { type: "OBJECT", properties: {
        keepIds: { type: "ARRAY", maxItems: 5, items: { type: "STRING" } },
        missingTheme: { type: "STRING", enum: ["none", ...themes] },
      }, required: ["keepIds", "missingTheme"] },
    ) as { keepIds?: unknown; missingTheme?: unknown };
    if (!Array.isArray(result.keepIds)) throw new Error("AI returned an invalid shortlist review");
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const keepIds = result.keepIds.filter((id): id is string => typeof id === "string" && candidateIds.has(id)).slice(0, 5);
    const missingTheme = typeof result.missingTheme === "string" && (THEMES as readonly string[]).includes(result.missingTheme)
      ? result.missingTheme as Theme : null;
    return { keepIds, missingTheme };
  }

  /**
   * Translates non-English titles or missions (e.g., Betterplace German project descriptions)
   * into natural, fluent English using Gemini while preserving English titles and proper nouns.
   */
  async translateCauses(causes: Ngo[]): Promise<Array<{ id: string; name: string; mission: string }>> {
    if (!this.configured() || !causes.length) {
      return causes.map((c) => ({ id: c.id, name: c.name, mission: c.mission }));
    }
    try {
      const result = await this.generate(
        [
          "You are an expert translator for a charitable donation platform.",
          "Inspect the following charity titles and mission descriptions.",
          "If a title or mission is in German, French, or any language other than English, translate it into natural, inspiring, fluent English.",
          "If it is already in English, leave it completely unchanged.",
          "Keep proper nouns, project names, and geographic city names intact (e.g., Lagos, Oshodi, Nigeria).",
          JSON.stringify(causes.map((c) => ({ id: c.id, name: c.name, mission: c.mission }))),
        ].join("\n"),
        {
          type: "OBJECT",
          properties: {
            translations: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  id: { type: "STRING" },
                  name: { type: "STRING" },
                  mission: { type: "STRING" },
                },
                required: ["id", "name", "mission"],
              },
            },
          },
          required: ["translations"],
        },
      ) as { translations?: Array<{ id: string; name: string; mission: string }> };

      if (!Array.isArray(result?.translations)) {
        return causes.map((c) => ({ id: c.id, name: c.name, mission: c.mission }));
      }
      return result.translations;
    } catch {
      return causes.map((c) => ({ id: c.id, name: c.name, mission: c.mission }));
    }
  }
}

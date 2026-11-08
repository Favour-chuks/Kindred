import { describe, expect, it } from "vitest";
import { MatchingService } from "../src/matching.js";
import { ngos } from "../src/fixtures.js";
import type { Ngo, Transaction } from "../src/types.js";

const matching = new MatchingService();

const mockThinTransactions: Transaction[] = [
  { id: "s1", date: "2026-09-04", description: "book shop", amount: 18, currency: "USD" },
  { id: "s2", date: "2026-09-18", description: "groceries", amount: 63, currency: "USD" },
];

const mockRichTransactions: Transaction[] = [
  { id: "m1", date: "2026-09-03", description: "picture book shop", amount: 24, currency: "USD" },
  { id: "m2", date: "2026-09-06", description: "school supplies", amount: 38, currency: "USD" },
  { id: "m3", date: "2026-09-11", description: "science kit", amount: 29, currency: "USD" },
  { id: "m4", date: "2026-09-15", description: "community art class", amount: 42, currency: "USD" },
  { id: "m5", date: "2026-09-23", description: "museum ticket", amount: 18, currency: "USD" },
  { id: "m6", date: "2026-09-25", description: "groceries", amount: 74, currency: "USD" },
];

const mockChildrenEducationTransactions: Transaction[] = [
  { id: "m7", date: "2026-10-02", description: "children's book shop", amount: 21, currency: "USD" },
  { id: "m8", date: "2026-10-08", description: "school supplies", amount: 41, currency: "USD" },
  { id: "m9", date: "2026-10-14", description: "kids sports club", amount: 35, currency: "USD" },
  { id: "m10", date: "2026-10-19", description: "children science museum", amount: 27, currency: "USD" },
  { id: "m11", date: "2026-10-24", description: "groceries", amount: 81, currency: "USD" },
];

describe("Kindred Matching Spec & Privacy Tests", () => {
  // 1. Sanitizer removes emails, phones, digit runs >= 6
  it("sanitizes transactions by stripping emails, phone numbers, digit runs, and URLs", () => {
    const raw: Transaction[] = [
      {
        id: "tx-123",
        date: "2026-09-05",
        description: "Payment to bookstore john.doe@example.com order 987654321 phone +1-555-123-4567 https://store.com/receipt",
        amount: 25.5,
        currency: "USD",
      },
    ];

    const sanitized = matching.sanitize(raw);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].month).toBe("2026-09");
    expect(sanitized[0].amount).toBe(25.5);
    expect(sanitized[0].description).not.toContain("john.doe@example.com");
    expect(sanitized[0].description).not.toContain("987654321");
    expect(sanitized[0].description).not.toContain("+1-555-123-4567");
    expect(sanitized[0].description).not.toContain("https://");
    expect(sanitized[0].description).toContain("bookstore");
  });

  // 2. Necessity classifier
  it("recognizes necessities and does not use them as cause evidence", () => {
    expect(matching.isNecessary({ description: "monthly apartment rent" })).toBe(true);
    expect(matching.isNecessary({ description: "city electric utility bill" })).toBe(true);
    expect(matching.isNecessary({ description: "weekly groceries supermart" })).toBe(true);
    expect(matching.isNecessary({ description: "metro transport card" })).toBe(true);
    expect(matching.isNecessary({ description: "university tuition payment" })).toBe(true);
    expect(matching.isNecessary({ description: "exam fee registration" })).toBe(true);
    expect(matching.isNecessary({ description: "mobile airtime data recharge" })).toBe(true);

    // Discretionary
    expect(matching.isNecessary({ description: "children picture book" })).toBe(false);
    expect(matching.isNecessary({ description: "science robotics kit" })).toBe(false);

    const analysis = matching.analyzeTransactions([
      { id: "1", date: "2026-09-01", description: "groceries market", amount: 30, currency: "USD" },
      { id: "2", date: "2026-09-02", description: "apartment rent", amount: 800, currency: "USD" },
      { id: "3", date: "2026-09-03", description: "school supplies", amount: 20, currency: "USD" },
    ]);
    expect(analysis.discretionaryCount).toBe(1);
  });

  // 3. Sufficiency rules
  it("enforces sufficiency rules: sparse history fails with thin history, sufficient history passes", () => {
    const samAnalysis = matching.analyzeTransactions(mockThinTransactions);
    expect(samAnalysis.sufficient).toBe(false);
    expect(samAnalysis.confidence).toBeLessThanOrEqual(0.5);

    const richAnalysis = matching.analyzeTransactions(mockRichTransactions);
    expect(richAnalysis.sufficient).toBe(true);
    expect(richAnalysis.confidence).toBeGreaterThan(0.25);
  });

  // 4. Focus theme ranking
  it("ranks children and education above other themes when spending reflects it", () => {
    const analysis = matching.analyzeTransactions(mockChildrenEducationTransactions);

    expect(analysis.sufficient).toBe(true);
    const topThemes = analysis.themes.slice(0, 2).map((t) => t.theme);
    expect(topThemes).toContain("children");
    expect(topThemes).toContain("education");

    const matches = matching.scoreMatches(analysis, {}, {}, ngos);
    expect(matches[0].themes.some((t) => t === "children" || t === "education")).toBe(true);
  });

  // 5. Small NGO pool rule: at least 3 of 5 results are small NGOs
  it("guarantees at least 3 of 5 results are small NGOs", () => {
    const analysis = matching.analyzeTransactions(mockRichTransactions);
    const matches = matching.scoreMatches(analysis, {}, {}, ngos);

    expect(matches.length).toBeGreaterThanOrEqual(3);
    const smallCount = matches.filter((m) => matching.isSmallNgo(m)).length;
    expect(smallCount).toBeGreaterThanOrEqual(3);
  });

  // 6. No result for a theme with fewer than 3 supporting payments
  it("does not report sufficiency for a theme with fewer than 3 supporting payments", () => {
    const analysis = matching.analyzeTransactions([
      { id: "1", date: "2026-09-01", description: "science kit", amount: 20, currency: "USD" },
      { id: "2", date: "2026-09-02", description: "robotics kit", amount: 20, currency: "USD" },
    ]);
    expect(analysis.sufficient).toBe(false);
  });

  // 7. Scoring is deterministic for fixed input
  it("scoring is strictly deterministic for identical inputs", () => {
    const analysis = matching.analyzeTransactions(mockRichTransactions);
    const run1 = matching.scoreMatches(analysis, { "bright-futures": 0.2 }, { "bright-futures": 1 }, ngos);
    const run2 = matching.scoreMatches(analysis, { "bright-futures": 0.2 }, { "bright-futures": 1 }, ngos);

    expect(run1.map((m) => m.id)).toEqual(run2.map((m) => m.id));
    expect(run1.map((m) => m.score)).toEqual(run2.map((m) => m.score));
  });

  // 8. Negative feedback penalizes rejected NGOs
  it("penalizes rejected NGOs with negative feedback", () => {
    const analysis = matching.analyzeTransactions(mockRichTransactions);
    const normalMatches = matching.scoreMatches(analysis, {}, {}, ngos);
    const topId = normalMatches[0].id;

    // Apply negative feedback (e.g. -0.8) to the top NGO
    const penalizedMatches = matching.scoreMatches(analysis, { [topId]: -0.8 }, {}, ngos);
    const penalizedScore = penalizedMatches.find((m) => m.id === topId)?.score ?? 0;
    const originalScore = normalMatches.find((m) => m.id === topId)?.score ?? 0;

    expect(penalizedScore).toBeLessThan(originalScore);
  });

  // 9. NGO fields pass through unchanged and carry their source
  it("ensures NGO fields pass through untouched and carry their source and attribution", () => {
    const analysis = matching.analyzeTransactions(mockRichTransactions);
    const matches = matching.scoreMatches(analysis, {}, {}, ngos);

    for (const match of matches) {
      const original = ngos.find((n) => n.id === match.id);
      expect(original).toBeDefined();
      expect(match.name).toBe(original!.name);
      expect(match.mission).toBe(original!.mission);
      expect(match.projectUrl).toBe(original!.projectUrl);
      expect(match.country).toBe(original!.country);
      expect(match.source).toBe(original!.source);
      expect(match.vettingNote).toBe(original!.vettingNote);
    }
  });

  // 10. Max 2 NGOs per primary cause theme
  it("limits primary theme repetition to no more than 2 NGOs per theme", () => {
    const analysis = matching.analyzeTransactions(mockRichTransactions);
    const matches = matching.scoreMatches(analysis, {}, {}, ngos);

    const themeCounts: Record<string, number> = {};
    for (const match of matches) {
      themeCounts[match.primaryTheme] = (themeCounts[match.primaryTheme] ?? 0) + 1;
      expect(themeCounts[match.primaryTheme]).toBeLessThanOrEqual(2);
    }
  });

  // 11. Multi-provider suggestion from both GlobalGiving and Every.org
  it("suggests from both GlobalGiving and Every.org when both providers are present", () => {
    const analysis = matching.analyzeTransactions(mockRichTransactions);

    // Inline minimal Every.org NGO fixtures (live shape, no sample import needed)
    const everyOrgFixtures: Ngo[] = [
      {
        id: "everyorg-reading-partners",
        name: "Reading Partners",
        mission: "One-on-one literacy tutoring for students.",
        country: "Oakland, CA",
        imageUrl: "https://images.unsplash.com/photo-1497633762265-9d179a990aa6",
        projectUrl: "https://www.every.org/readingpartners",
        themes: ["education", "children"],
        donors: 78,
        fundingRaised: 8200,
        fundingGoal: 15000,
        source: "live",
        provider: "everyorg",
        vettingNote: "Verified 501(c)(3) on Every.org",
        isSmall: true,
      },
      {
        id: "everyorg-urban-canopy",
        name: "The Urban Canopy",
        mission: "Sustainable urban food production.",
        country: "Chicago, IL",
        imageUrl: "https://images.unsplash.com/photo-1542601906990-b4d3fb778b09",
        projectUrl: "https://www.every.org/theurbancanopy",
        themes: ["environment", "hunger"],
        donors: 54,
        fundingRaised: 6400,
        fundingGoal: 12000,
        source: "live",
        provider: "everyorg",
        vettingNote: "Verified 501(c)(3) on Every.org",
        isSmall: true,
      },
    ];

    const combinedNgos = [...ngos, ...everyOrgFixtures];
    const matches = matching.scoreMatches(analysis, {}, {}, combinedNgos);

    expect(matches.length).toBeGreaterThanOrEqual(3);
    const providers = new Set(matches.map((m) => m.provider));
    expect(providers.has("globalgiving")).toBe(true);
    expect(providers.has("everyorg")).toBe(true);
  });
});


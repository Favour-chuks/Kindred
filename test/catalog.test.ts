import { describe, expect, it } from "vitest";
import { CauseCatalog } from "../src/catalog.js";
import type { Ngo } from "../src/types.js";

describe("CauseCatalog & Multi-API Deduplication", () => {
  it("initializes dynamically with zero hardcoded charities", () => {
    const catalog = new CauseCatalog();
    expect(catalog.all()).toEqual([]);
  });

  it("deduplicates charities by normalized name across providers and merges attributes", () => {
    const catalog = new CauseCatalog();

    const betterplaceNgo: Ngo = {
      id: "betterplace-101",
      name: "Green Earth Foundation, Inc.",
      mission: "Short summary about planting trees in urban centres.",
      country: "Lagos, Nigeria",
      area: "Lagos",
      imageUrl: "https://example.com/green.jpg",
      projectUrl: "https://greenearth.org/projects/1",
      themes: ["environment"],
      donors: 45,
      fundingRaised: 4500,
      fundingGoal: 10000,
      source: "live",
      provider: "betterplace",
      vettingNote: "Unverified",
      isSmall: true,
      h3: "831e00fffffffff",
      latitude: 6.52,
      longitude: 3.38,
      distanceKm: 4.2,
      verificationStatus: "unverified",
    };

    const propublicaNgo: Ngo = {
      id: "propublica-998877665",
      name: "Green Earth Foundation",
      mission: "A comprehensive initiative dedicated to sustainable agriculture, urban reforestation, and climate education for low-income communities.",
      country: "Lagos, Nigeria",
      area: "Lagos",
      imageUrl: "https://images.unsplash.com/sample.jpg",
      projectUrl: "https://greenearth.org",
      themes: ["climate", "community"],
      donors: 120,
      fundingRaised: 12000,
      fundingGoal: 20000,
      source: "live",
      provider: "propublica",
      vettingNote: "IRS Form 990",
      isSmall: true,
      verificationStatus: "unverified",
    };

    const deduplicated = catalog.deduplicateCharities([betterplaceNgo, propublicaNgo]);

    expect(deduplicated).toHaveLength(1);
    const merged = deduplicated[0];
    expect(merged.name).toBe("Green Earth Foundation, Inc.");
    // Retains the richer mission text
    expect(merged.mission).toContain("comprehensive initiative");
    // Merges themes from both
    expect(merged.themes).toContain("environment");
    expect(merged.themes).toContain("climate");
    expect(merged.themes).toContain("community");
    // Retains spatial metadata
    expect(merged.distanceKm).toBe(4.2);
    expect(merged.h3).toBe("831e00fffffffff");
    // Merges highest funding numbers
    expect(merged.fundingRaised).toBe(12000);
  });

  it("deduplicates charities with exact matching IDs", () => {
    const catalog = new CauseCatalog();
    const ngoA: Ngo = {
      id: "test-cause-1",
      name: "Youth Coding Initiative",
      mission: "Teaching youth coding.",
      country: "Nigeria",
      imageUrl: "https://example.com/coding.jpg",
      projectUrl: "https://example.com",
      themes: ["tech"],
      donors: 10,
      fundingRaised: 1000,
      fundingGoal: 5000,
      source: "live",
      vettingNote: "Note",
      isSmall: true,
      verificationStatus: "unverified",
    };
    const ngoB: Ngo = {
      ...ngoA,
      mission: "Teaching youth coding and hardware engineering.",
      themes: ["tech", "education"],
    };

    const result = catalog.deduplicateCharities([ngoA, ngoB]);
    expect(result).toHaveLength(1);
    expect(result[0].themes).toContain("education");
    expect(result[0].mission).toContain("hardware engineering");
  });
});

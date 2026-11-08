import { describe, expect, it } from "vitest";
import { BetterplaceClient } from "../src/betterplace.js";
import { geoService } from "../src/geo.js";

describe("BetterplaceClient", () => {
  it("is always configured because it needs zero API keys", () => {
    const client = new BetterplaceClient();
    expect(client.configured()).toBe(true);
  });

  it("maps live or mock Betterplace project data accurately", () => {
    const client = new BetterplaceClient();
    const mockProject = {
      id: 59168,
      title: "Quality education for kids & teenagers in Kenya",
      summary: "Smiles Africa Charity provides schooling support in Nairobi.",
      country: "Kenya",
      city: "Nairobi",
      latitude: -1.292,
      longitude: 36.821,
      donated_amount_in_cents: 9375746,
      open_amount_in_cents: 749254,
      donations_count: 2493,
      donor_count: 1200,
      profile_picture: {
        links: [
          { rel: "fill_960x500", href: "https://example.com/cover.jpg" },
        ],
      },
      carrier: {
        name: "Smiles Africa Charity",
      },
      links: [
        { rel: "platform", href: "https://www.betterplace.org/en/projects/59168" },
      ],
    };

    // Access private mapProject via cast
    const ngo = (client as any).mapProject(mockProject, "education");
    expect(ngo).not.toBeNull();
    expect(ngo.id).toBe("betterplace-59168");
    expect(ngo.name).toBe("Quality education for kids & teenagers in Kenya");
    expect(ngo.country).toBe("Nairobi, Kenya");
    expect(ngo.provider).toBe("betterplace");
    expect(ngo.source).toBe("live");
    expect(ngo.fundingRaised).toBe(93757);
    expect(ngo.fundingGoal).toBe(101250);
    expect(ngo.themes).toContain("education");
    expect(ngo.h3).toBe(geoService.latLngToH3(-1.292, 36.821));
    expect(ngo.vettingNote).toContain("Smiles Africa Charity");
  });

  it("detects multiple themes from title and summary", () => {
    const client = new BetterplaceClient();
    const themes = (client as any).detectThemes(
      "Clean water and food for school children in rural Kenya",
      "Building water wells and planting trees for climate resilience",
      "community"
    );

    expect(themes).toContain("water");
    expect(themes).toContain("hunger");
    expect(themes).toContain("education");
    expect(themes).toContain("children");
    expect(themes).toContain("climate");
  });

  it("handles null or missing projects gracefully", () => {
    const client = new BetterplaceClient();
    expect((client as any).mapProject(null)).toBeNull();
    expect((client as any).mapProject({})).toBeNull();
    expect((client as any).mapProject({ id: 123 })).toBeNull();
  });

  it("getNgos fetches, deduplicates, and caches causes", async () => {
    const client = new BetterplaceClient();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 101,
              title: "Solar lamps for girls in Kenya",
              summary: "Distributing solar study lights",
              country: "Kenya",
              city: "Kisumu",
              latitude: -0.0917,
              longitude: 34.768,
              donor_count: 45,
              donated_amount_in_cents: 450000,
              open_amount_in_cents: 150000,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    try {
      const ngos = await client.getNgos(["education"]);
      expect(ngos.length).toBeGreaterThanOrEqual(1);
      expect(ngos[0].id).toBe("betterplace-101");
      expect(ngos[0].provider).toBe("betterplace");
      expect(ngos[0].isSmall).toBe(true);

      // Verify caching: second call returns same without re-fetching
      let called = false;
      globalThis.fetch = async () => {
        called = true;
        return new Response("{}", { status: 200 });
      };

      const cachedNgos = await client.getNgos(["education"]);
      expect(called).toBe(false);
      expect(cachedNgos).toBe(ngos);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

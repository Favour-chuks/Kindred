import type { Ngo, Theme } from "./types.js";
import { BetterplaceClient } from "./betterplace.js";
import { ProPublicaClient } from "./propublica.js";

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|ngo|foundation|initiative|charity|organization|trust|association|e\.v\.|corp|corporation)\b/gi, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDomain(url?: string): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    // Exclude major aggregator portals from domain deduplication
    if (host.includes("betterplace.org") || host.includes("propublica.org") || host.includes("globalgiving.org")) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

function mergeNgos(primary: Ngo, secondary: Ngo): Ngo {
  return {
    ...primary,
    // Retain the richer descriptive text
    mission: primary.mission.length >= secondary.mission.length ? primary.mission : secondary.mission,
    // Combine unique themes
    themes: [...new Set([...primary.themes, ...secondary.themes])],
    imageUrl: primary.imageUrl || secondary.imageUrl,
    // Keep spatial attributes if either source has them
    h3: primary.h3 ?? secondary.h3,
    latitude: primary.latitude ?? secondary.latitude,
    longitude: primary.longitude ?? secondary.longitude,
    distanceKm: primary.distanceKm ?? secondary.distanceKm,
    fundingRaised: Math.max(primary.fundingRaised ?? 0, secondary.fundingRaised ?? 0),
    fundingGoal: Math.max(primary.fundingGoal ?? 0, secondary.fundingGoal ?? 0),
    donors: Math.max(primary.donors ?? 0, secondary.donors ?? 0),
  };
}

export class CauseCatalog {
  private readonly liveCache = new Map<string, Ngo>();

  constructor(
    private readonly entries: Ngo[] = [],
    private readonly betterplace: BetterplaceClient = new BetterplaceClient(),
    private readonly propublica: ProPublicaClient = new ProPublicaClient(),
  ) {
    for (const entry of entries) {
      this.liveCache.set(entry.id, entry);
    }
  }

  /**
   * Discovers causes matching themes and optional location across multiple public charity APIs.
   * Fully dynamic: does not rely on hardcoded charities.
   * Handles cross-API deduplication and field merging automatically.
   */
  async discover(themes: Theme[], area?: string, coords?: [number, number]): Promise<Ngo[]> {
    const local = this.search(themes, area);

    // Concurrently fetch from live public charity APIs
    const [betterplaceResult, propublicaResult] = await Promise.allSettled([
      this.betterplace.getNgos(themes, area, coords),
      this.propublica.getNgos(themes, area),
    ]);

    const liveBetterplace = betterplaceResult.status === "fulfilled" ? betterplaceResult.value : [];
    const livePropublica = propublicaResult.status === "fulfilled" ? propublicaResult.value : [];

    // Prioritize spatial-ranked results, then aggregate
    const rawList = [...local, ...liveBetterplace, ...livePropublica];

    // Cache live causes so getById can resolve them during checkout/donation
    for (const ngo of rawList) {
      this.liveCache.set(ngo.id, ngo);
    }

    return this.deduplicateCharities(rawList);
  }

  /**
   * Deduplicates charities by ID, normalized name, and public domain.
   */
  deduplicateCharities(ngos: Ngo[]): Ngo[] {
    const byId = new Map<string, Ngo>();
    const byNormalizedName = new Map<string, Ngo>();
    const byDomain = new Map<string, Ngo>();
    const results: Ngo[] = [];

    for (const ngo of ngos) {
      const normName = normalizeName(ngo.name);
      const domain = extractDomain(ngo.projectUrl);

      // Check if duplicate exists
      const existing =
        byId.get(ngo.id) ??
        (normName ? byNormalizedName.get(normName) : undefined) ??
        (domain ? byDomain.get(domain) : undefined);

      if (existing) {
        // Merge attributes and update references
        const merged = mergeNgos(existing, ngo);
        byId.set(merged.id, merged);
        if (normName) byNormalizedName.set(normName, merged);
        if (domain) byDomain.set(domain, merged);

        const index = results.findIndex((item) => item.id === existing.id);
        if (index !== -1) {
          results[index] = merged;
        }
      } else {
        byId.set(ngo.id, ngo);
        if (normName) byNormalizedName.set(normName, ngo);
        if (domain) byDomain.set(domain, ngo);
        results.push(ngo);
      }
    }

    return results;
  }

  search(themes: Theme[], area?: string): Ngo[] {
    const areaKey = area?.trim().toLowerCase();
    return this.entries.filter((entry) => {
      const countryStr = (entry.country || "").toLowerCase();
      const areaStr = (entry.area || "").toLowerCase();
      const matchesArea = !areaKey ||
        areaKey.includes("nigeria") ||
        countryStr.includes(areaKey) || areaKey.includes(countryStr) ||
        (areaStr && (areaStr.includes(areaKey) || areaKey.includes(areaStr)));
      const matchesTheme = !themes.length || entry.themes.some((theme) => themes.includes(theme));
      return matchesArea && matchesTheme;
    }).map((entry) => ({ ...entry, themes: [...entry.themes] }));
  }

  getById(id: string): Ngo | undefined {
    return this.liveCache.get(id) ?? this.entries.find((entry) => entry.id === id);
  }

  all(): Ngo[] {
    return this.entries.map((entry) => ({ ...entry, themes: [...entry.themes] }));
  }
}

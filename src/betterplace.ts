import { geoService } from "./geo.js";
import type { Ngo, Theme } from "./types.js";

function cleanHtml(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class BetterplaceClient {
  private readonly baseUrl = "https://api.betterplace.org/en/api_v4";
  private readonly cacheMs = 60 * 60 * 1000; // 1-hour cache
  private readonly cache = new Map<string, { expiresAt: number; ngos: Ngo[] }>();

  private readonly themeKeywords: Record<Theme, string[]> = {
    education: ["education", "school", "students", "learning", "books", "literacy", "scholarship"],
    health: ["health", "clinic", "medical", "hospital", "doctor", "wellness"],
    hunger: ["hunger", "food", "nutrition", "meals", "farming", "famine"],
    water: ["water", "well", "sanitation", "clean water", "borehole"],
    environment: ["forest", "trees", "conservation", "nature", "biodiversity", "environment"],
    climate: ["climate", "solar", "renewable", "carbon", "energy"],
    children: ["children", "kids", "orphan", "youth", "childcare"],
    women: ["women", "girls", "female", "mothers", "empowerment"],
    animals: ["animals", "wildlife", "dogs", "cats", "rescue", "shelter"],
    arts: ["art", "music", "theatre", "culture", "creative"],
    disaster: ["disaster", "emergency", "flood", "earthquake", "relief"],
    economy: ["jobs", "business", "vocational", "microfinance", "livelihood"],
    rights: ["rights", "justice", "equality", "legal", "advocacy"],
    sport: ["sport", "football", "athletics", "soccer"],
    tech: ["technology", "coding", "computers", "digital"],
    community: ["community", "neighborhood", "civic", "village", "local"],
  };

  configured(): boolean {
    // The public API is unauthenticated. Betterplace documents it as deprecated
    // and may throttle or change it, so callers must have a local-catalog fallback.
    return true;
  }

  private detectThemes(title: string, summary: string, fallbackTheme: Theme): Theme[] {
    const haystack = `${title} ${summary}`.toLowerCase();
    const matched: Theme[] = [];

    for (const [theme, keywords] of Object.entries(this.themeKeywords)) {
      if (keywords.some((kw) => haystack.includes(kw))) {
        matched.push(theme as Theme);
      }
    }

    if (!matched.includes(fallbackTheme)) {
      matched.unshift(fallbackTheme);
    }

    return matched.length ? matched : [fallbackTheme];
  }

  private mapProject(project: any, fallbackTheme: Theme = "community"): Ngo | null {
    if (!project || !project.id || !project.title) return null;

    const id = String(project.id);
    const title = cleanHtml(project.title);
    const summary = cleanHtml(project.summary) || cleanHtml(project.description) || title;
    if (!title || !summary) return null;

    // Platform link
    const platformLink = project.links?.find((l: any) => l.rel === "platform")?.href;
    const projectUrl = platformLink || `https://www.betterplace.org/en/projects/${id}`;

    // Image: prefer large or limit_1240 / fill_960x500 / fill_730x380
    const picLinks: any[] = project.profile_picture?.links ?? [];
    const bestPic =
      picLinks.find((l) => l.rel === "fill_960x500")?.href ||
      picLinks.find((l) => l.rel === "fill_730x380")?.href ||
      picLinks.find((l) => l.rel === "limit_1240x646")?.href ||
      picLinks.find((l) => l.rel === "original")?.href ||
      "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?auto=format&fit=crop&w=900&q=80";

    const country = cleanHtml(project.country) || "Global";
    const city = cleanHtml(project.city);
    const locationDisplay = city && country !== "Global" ? `${city}, ${country}` : country;

    const donors = Number(project.donations_count ?? 0);
    const donatedCents = Number(project.donated_amount_in_cents ?? 0);
    const openCents = Number(project.open_amount_in_cents ?? 0);
    const fundingRaised = Math.round(donatedCents / 100);
    const fundingGoal = Math.round((donatedCents + openCents) / 100);

    const isSmall = donors < 100 || fundingRaised < 10000;
    const carrierName = cleanHtml(project.carrier?.name);
    const vettingNote = carrierName
      ? `Public project listing on Betterplace.org. Listed carrier: ${carrierName}. Kindred has not independently verified the organization or its payment recipient.`
      : "Public project listing on Betterplace.org. Kindred has not independently verified the organization or its payment recipient.";

    const themes = this.detectThemes(title, summary, fallbackTheme);

    // If native GPS coordinates are provided, compute H3 immediately!
    let h3: string | undefined;
    const lat = typeof project.latitude === "number" ? project.latitude : NaN;
    const lng = typeof project.longitude === "number" ? project.longitude : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && (lat !== 0 || lng !== 0)) {
      try {
        h3 = geoService.latLngToH3(lat, lng);
      } catch {
        // Fallback to geocoding if needed
      }
    }

    const aroundDistance = typeof project.around_distance === "number" && Number.isFinite(project.around_distance)
      ? Math.max(0, project.around_distance / 1000)
      : undefined;
    return {
      id: `betterplace-${id}`,
      name: title,
      mission: summary,
      country: locationDisplay,
      area: city || undefined,
      imageUrl: bestPic,
      projectUrl,
      themes,
      donors,
      fundingRaised,
      fundingGoal,
      source: "live",
      provider: "betterplace",
      vettingNote,
      isSmall,
      h3,
      latitude: Number.isFinite(lat) ? lat : undefined,
      longitude: Number.isFinite(lng) ? lng : undefined,
      distanceKm: aroundDistance,
      verificationStatus: "unverified",
    };
  }

  /**
   * Fetches live causes from Betterplace across user preference themes and key world regions.
   * If area/coordinates are provided, it performs a real coordinate-radius search (around=lat,lng)
   * which activates Betterplace's spatial index to return charities directly in that area.
   */
  async getNgos(themes: Theme[] = ["education", "children", "environment"], area?: string, coords?: [number, number]): Promise<Ngo[]> {
    const topThemes = themes.slice(0, 3);
    const normalizedArea = area?.trim() || "";
    const cacheKey = `${topThemes.join(",")}|${normalizedArea.toLowerCase()}|${coords ? coords.join(",") : ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.ngos;

    // Resolve geographic coordinates for Betterplace's around parameter if not passed
    let searchCoords = coords;
    if (!searchCoords && normalizedArea) {
      searchCoords = (await geoService.geocode(normalizedArea)) ?? undefined;
    }

    const queries: Array<{ q: string; fallbackTheme: Theme; useAround: boolean }> = [];
    for (const theme of topThemes) {
      if (searchCoords) {
        // Spatial search around user coordinates
        queries.push({ q: theme, fallbackTheme: theme, useAround: true });
      }
      if (normalizedArea) {
        // Keyword search with location name to catch causes mentioning the region
        queries.push({ q: `${theme} ${normalizedArea}`, fallbackTheme: theme, useAround: false });
      }
      if (!searchCoords && !normalizedArea) {
        queries.push({ q: theme, fallbackTheme: theme, useAround: false });
      }
    }

    const fetchPromises = queries.map(async (query) => {
      try {
        const url = new URL(`${this.baseUrl}/projects.json`);
        url.searchParams.set("q", query.q);
        url.searchParams.set("per_page", "12");
        url.searchParams.set("facets", "completed:false|closed:false|prohibit_donations:false");
        url.searchParams.set("order", "score:desc|completed:asc|rank:desc|last_donation_at:desc");
        if (query.useAround && searchCoords) {
          url.searchParams.set("around", `${searchCoords[0]},${searchCoords[1]}`);
          url.searchParams.set("around_distance", "150km");
        }

        const response = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(6000),
        });

        if (!response.ok) return [];

        const body = (await response.json()) as { data?: any[] };
        if (Array.isArray(body.data)) {
          return body.data
            .filter((item) => item?.closed_at == null && item?.completed_at == null && item?.donations_prohibited !== true)
            .map((item) => this.mapProject(item, query.fallbackTheme))
            .filter((n): n is Ngo => Boolean(n));
        }
      } catch (err) {
        console.warn(`Betterplace query for "${query.q}" failed (non-critical):`, err);
      }
      return [];
    });

    const queryResults = await Promise.all(fetchPromises);
    const results = queryResults.flat();

    // Deduplicate by ID
    const unique = results.filter(
      (ngo, index, self) => self.findIndex((o) => o.id === ngo.id) === index
    );

    this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheMs, ngos: unique });
    return unique;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const betterplaceClient = new BetterplaceClient();

import { latLngToCell, gridDistance } from "h3-js";
import type { Ngo } from "./types.js";

/**
 * GeoService - geographic relevance scoring via Uber H3 hexagonal grid.
 *
 * Design constraints (per DATA_AND_PRIVACY.md and MATCHING_SPEC.md):
 *  - Location is NEVER inferred from transaction descriptions or merchant names.
 *  - Location is NEVER stored in the database; it is session-only, passed per request.
 *  - The geo signal is a small optional boost (5% weight) - it can break ties but
 *    cannot override a strong cause-affinity signal.
 *  - NGO coordinates come from their own publicly-provided `country` field only.
 *  - IP geolocation is NOT used; only explicit browser-shared coordinates.
 */

// H3 resolution used throughout. Resolution 3 approx 115,000 km2 per cell,
// roughly country / large-region scale.
const H3_RESOLUTION = 3;

// Geo score decay by H3 grid distance (rings of neighbors).
// Distance 0 = same hex cell, distance >3 = effectively global (neutral, no penalty).
const GEO_SCORE_BY_DISTANCE: Record<number, number> = {
  0: 1.0,
  1: 0.7,
  2: 0.4,
  3: 0.15,
};

type NominatimResult = {
  lat: string;
  lon: string;
};

export type UserGeo = {
  lat: number;
  lng: number;
  h3: string;
  resolvedFrom: "explicit";
};

export class GeoService {
  private readonly geocodeCache = new Map<string, [number, number] | null>();
  private lastNominatimRequest = 0;
  private readonly nominatimUrl = "https://nominatim.openstreetmap.org/search";

  latLngToH3(lat: number, lng: number): string {
    return latLngToCell(lat, lng, H3_RESOLUTION);
  }

  buildUserGeo(lat: number, lng: number): UserGeo {
    return {
      lat,
      lng,
      h3: this.latLngToH3(lat, lng),
      resolvedFrom: "explicit",
    };
  }

  /**
   * Computes the geographic relevance score (0.0 to 1.0) between a user H3
   * cell and an NGO H3 cell. Returns 0.0 (neutral) when either is unknown.
   */
  geoScore(userH3: string, ngoH3: string): number {
    if (!userH3 || !ngoH3) return 0.0;
    try {
      const dist = gridDistance(userH3, ngoH3);
      if (dist === null) return 0.0;
      return GEO_SCORE_BY_DISTANCE[dist] ?? 0.0;
    } catch {
      return 0.0;
    }
  }

  async geocode(location: string): Promise<[number, number] | null> {
    const normalized = location.trim().toLowerCase();
    if (!normalized || normalized === "global" || normalized === "worldwide") {
      return null;
    }

    // Direct coordinate pair check (e.g. "6.52, 3.38" or "6.5244,3.3792")
    const coordMatch = normalized.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return [lat, lng];
      }
    }

    if (this.geocodeCache.has(normalized)) {
      return this.geocodeCache.get(normalized)!;
    }

    const now = Date.now();
    const msSinceLast = now - this.lastNominatimRequest;
    if (msSinceLast < 1100) {
      await new Promise((resolve) => setTimeout(resolve, 1100 - msSinceLast));
    }
    this.lastNominatimRequest = Date.now();

    try {
      const url = new URL(this.nominatimUrl);
      url.searchParams.set("q", location);
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", "1");

      const response = await fetch(url, {
        headers: {
          "User-Agent": "Kindred-NGO-Matcher/1.0 (hackathon project; github.com/Favour-chuks/Kindred)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        this.geocodeCache.set(normalized, null);
        return null;
      }

      const results = (await response.json()) as NominatimResult[];
      if (!results.length) {
        this.geocodeCache.set(normalized, null);
        return null;
      }

      const lat = parseFloat(results[0].lat);
      const lng = parseFloat(results[0].lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        this.geocodeCache.set(normalized, null);
        return null;
      }

      const coords: [number, number] = [lat, lng];
      this.geocodeCache.set(normalized, coords);
      return coords;
    } catch {
      this.geocodeCache.set(normalized, null);
      return null;
    }
  }

  async h3ForNgo(ngo: Ngo): Promise<string | null> {
    if (!ngo.country) return null;
    const coords = await this.geocode(ngo.country);
    if (!coords) return null;
    return this.latLngToH3(coords[0], coords[1]);
  }

  /**
   * Attaches H3 index to a batch of NGOs respecting Nominatim rate limits.
   * Returns new Ngo objects with the `h3` field set; does not mutate input.
   */
  async attachH3ToNgos(ngos: Ngo[]): Promise<Ngo[]> {
    const results: Ngo[] = [];
    for (let i = 0; i < ngos.length; i += 3) {
      const batch = ngos.slice(i, i + 3);
      const resolved = await Promise.all(
        batch.map(async (ngo) => {
          const h3 = await this.h3ForNgo(ngo);
          return h3 ? { ...ngo, h3 } : ngo;
        })
      );
      results.push(...resolved);
    }
    return results;
  }

  clearCache(): void {
    this.geocodeCache.clear();
  }
}

export const geoService = new GeoService();

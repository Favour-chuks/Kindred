import { describe, expect, it } from "vitest";
import { GeoService } from "../src/geo.js";

const geo = new GeoService();

describe("GeoService", () => {
  // 1. Same point -> same H3 -> score = 1.0
  it("scores 1.0 when user and NGO are in the same H3 cell", () => {
    const h3a = geo.latLngToH3(6.45, 3.39);  // Lagos, Nigeria
    const h3b = geo.latLngToH3(6.60, 3.20);  // Also Lagos area
    // Both should land in the same resolution-3 hex
    expect(geo.geoScore(h3a, h3b)).toBeGreaterThanOrEqual(0.7);
  });

  // 2. Same exact cell -> 1.0
  it("scores exactly 1.0 for identical H3 indices", () => {
    const h3 = geo.latLngToH3(51.5074, -0.1278); // London
    expect(geo.geoScore(h3, h3)).toBe(1.0);
  });

  // 3. Missing H3 -> 0.0 (neutral, no penalty)
  it("returns 0.0 (neutral) when either H3 is missing", () => {
    const h3 = geo.latLngToH3(51.5074, -0.1278);
    expect(geo.geoScore(h3, "")).toBe(0.0);
    expect(geo.geoScore("", h3)).toBe(0.0);
    expect(geo.geoScore("", "")).toBe(0.0);
  });

  // 4. Very distant points -> 0.0
  it("returns 0.0 for very distant locations (different continents)", () => {
    const london = geo.latLngToH3(51.5074, -0.1278);
    const sydney = geo.latLngToH3(-33.8688, 151.2093);
    expect(geo.geoScore(london, sydney)).toBe(0.0);
  });

  // 5. Score decay: nearer should score higher
  it("applies distance decay so closer NGOs score higher than distant ones", () => {
    const userH3 = geo.latLngToH3(48.8566, 2.3522);  // Paris
    const nearH3  = geo.latLngToH3(51.5074, -0.1278); // London (2 rings away at res 3)
    const farH3   = geo.latLngToH3(-33.8688, 151.2093); // Sydney (global)

    const nearScore = geo.geoScore(userH3, nearH3);
    const farScore  = geo.geoScore(userH3, farH3);
    expect(nearScore).toBeGreaterThan(farScore);
  });

  // 6. Score is always in [0, 1]
  it("always returns a score between 0 and 1 inclusive", () => {
    const pairs: [number, number, number, number][] = [
      [6.45, 3.39, 6.45, 3.39],     // Lagos self
      [51.5, -0.1, 48.8, 2.35],     // London-Paris
      [40.7, -74.0, -33.9, 151.2],  // NY-Sydney
    ];
    for (const [lat1, lng1, lat2, lng2] of pairs) {
      const h3a = geo.latLngToH3(lat1, lng1);
      const h3b = geo.latLngToH3(lat2, lng2);
      const score = geo.geoScore(h3a, h3b);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  // 7. buildUserGeo constructs a valid UserGeo object
  it("buildUserGeo returns an object with valid h3 and explicit resolvedFrom", () => {
    const ug = geo.buildUserGeo(6.45, 3.39);
    expect(ug.lat).toBe(6.45);
    expect(ug.lng).toBe(3.39);
    expect(typeof ug.h3).toBe("string");
    expect(ug.h3.length).toBeGreaterThan(0);
    expect(ug.resolvedFrom).toBe("explicit");
  });

  // 8. Geo scoring is a pure function (deterministic)
  it("returns the same score for the same inputs on repeated calls", () => {
    const h3a = geo.latLngToH3(6.45, 3.39);
    const h3b = geo.latLngToH3(9.06, 7.50);  // Abuja
    const score1 = geo.geoScore(h3a, h3b);
    const score2 = geo.geoScore(h3a, h3b);
    expect(score1).toBe(score2);
  });
});

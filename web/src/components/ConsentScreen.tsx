import { Theme } from "src/types";
import { useKindred } from "@/context/KindredContext";
import { ArrowRight, ShieldCheck, MapPin, Heart, Sparkles, Navigation, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import React, { useState, useMemo } from "react";

const THEMES: Theme[] = [
  "education", "hunger", "environment", "climate",
  "children", "women", "animals", "arts",
  "sport", "tech", "community", "water"
];

/**
 * Semantic neighbours for each theme.
 * When a theme is selected, its neighbours get a soft nudge highlight
 * to surface potentially overlooked but related causes.
 */
const RELATED: Partial<Record<Theme, Theme[]>> = {
  education:   ["children", "women", "tech", "community"],
  hunger:      ["community", "children", "water"],
  environment: ["climate", "animals", "water"],
  climate:     ["environment", "water", "tech"],
  children:    ["education", "women", "hunger", "community"],
  women:       ["education", "children", "community", "arts"],
  animals:     ["environment", "water"],
  arts:        ["community", "women", "education"],
  sport:       ["children", "community", "women"],
  tech:        ["education", "climate", "community"],
  community:   ["education", "hunger", "arts", "sport", "women"],
  water:       ["hunger", "environment", "climate", "animals"],
};

type Step = "welcome" | "interests" | "location";

export const ConsentScreen = () => {
  const {
    profile, busy, notice,
    categoryConsent, setCategoryConsent,
    locationConsent, setLocationConsent,
    paypalPayerId, setPaypalPayerId,
    area, setArea,
    explicitThemes, toggleTheme,
    createProfile, updateSettings
  } = useKindred();

  const [step, setStep] = useState<Step>("welcome");
  const [geoLocating, setGeoLocating] = useState(false);
  const [geoError, setGeoError] = useState("");
  const isValidPayerId = !categoryConsent || (paypalPayerId.trim().length > 0 && /^[A-Z0-9]{13}$/i.test(paypalPayerId.trim()));
  const canProceedStep1 = categoryConsent && isValidPayerId;

  const handleUseLiveLocation = () => {
    if (!navigator.geolocation) {
      setGeoError("Geolocation is not supported by your browser.");
      return;
    }
    setGeoLocating(true);
    setGeoError("");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          // Use OpenStreetMap reverse geocoding to resolve a friendly city/locality name
          const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`, {
            headers: { "Accept-Language": "en" }
          });
          const data = await res.json();
          const city = data.address?.city || data.address?.town || data.address?.state || data.address?.county || "";
          const country = data.address?.country || "";
          const resolved = [city, country].filter(Boolean).join(", ");
          if (resolved) {
            setArea(resolved);
          } else {
            setArea(`${latitude.toFixed(2)}, ${longitude.toFixed(2)}`);
          }
        } catch {
          setArea(`${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)}`);
        } finally {
          setGeoLocating(false);
        }
      },
      (err) => {
        setGeoLocating(false);
        if (err.code === 1) {
          setGeoError("Location permission denied. You can still type your city manually.");
        } else {
          setGeoError("Could not retrieve your live location. Please type your city.");
        }
      },
      { timeout: 10000, enableHighAccuracy: false }
    );
  };

  /** All themes that are semantically related to at least one selected theme,
   *  but are not themselves selected yet. */
  const nudgedThemes = useMemo<Set<Theme>>(() => {
    const result = new Set<Theme>();
    for (const selected of explicitThemes) {
      for (const neighbour of RELATED[selected] ?? []) {
        if (!explicitThemes.includes(neighbour)) result.add(neighbour);
      }
    }
    return result;
  }, [explicitThemes]);

  const STEPS: Step[] = ["welcome", "interests", "location"];
  const stepIndex = STEPS.indexOf(step);

  return (
    <section className="cs-shell">

      {/* ── Step 1: Welcome & consent ── */}
      {step === "welcome" && (
        <div className="cs-card">
          <p className="cs-eyebrow">Step 1 of 3</p>
          <h1 className="cs-heading">Good causes,<br /><em>closer to you.</em></h1>
          <p className="cs-body">
            Kindred maps broad merchant purchase categories to cause
            recommendations — it never reads your PayPal account history or
            sees item names or amounts.
          </p>

          <label className="cs-consent-row">
            <input
              type="checkbox"
              checked={categoryConsent}
              onChange={(e) => setCategoryConsent(e.target.checked)}
            />
            <span>
              <strong>Allow participating merchant categories</strong>
              <small>Only a broad category (e.g. "books" or "food") is shared after payment is verified. No amounts or item details.</small>
            </span>
          </label>

          {categoryConsent && (
            <div className="cs-payer-box">
              <label htmlFor="cs-payer-id" className="cs-payer-label">
                <strong>Link PayPal Sandbox Account (Payer ID) <span style={{ color: "hsl(var(--destructive))" }}>*</span></strong>
                <small>Required to match your checkout signals from partner stores like Verdant Goods.</small>
              </label>
              <div className="cs-payer-row">
                <input
                  id="cs-payer-id"
                  className={`cs-payer-input ${!isValidPayerId ? "cs-payer-invalid" : ""}`}
                  value={paypalPayerId}
                  onChange={(e) => setPaypalPayerId(e.target.value.trim())}
                  placeholder="e.g. QZAZCPCBP7VUC (13 characters)"
                  maxLength={25}
                />
                <button
                  type="button"
                  className="cs-demo-btn"
                  onClick={() => setPaypalPayerId("QZAZCPCBP7VUC")}
                  title="Click to fill with demo sandbox buyer ID"
                >
                  Use Demo ID
                </button>
              </div>
              {!isValidPayerId && (
                <p className="cs-payer-error">
                  Please enter a valid 13-character PayPal Payer ID (or click "Use Demo ID").
                </p>
              )}
            </div>
          )}

          <Button
            className="cs-cta"
            disabled={!canProceedStep1}
            onClick={() => setStep("interests")}
          >
            Continue <ArrowRight size={16} />
          </Button>

          <p className="cs-privacy">
            <ShieldCheck size={14} />
            You can change these choices or withdraw consent at any time.
          </p>
        </div>
      )}

      {/* ── Step 2: Cause interests ── */}
      {step === "interests" && (
        <div className="cs-card">
          <p className="cs-eyebrow">Step 2 of 3</p>
          <h1 className="cs-heading">What matters<br /><em>most to you?</em></h1>
          <p className="cs-body">
            Pick any causes you already care about. These guide early
            recommendations before merchant signals arrive. All optional.
          </p>

          <div className="cs-theme-grid">
            {THEMES.map((theme) => {
              const isOn = explicitThemes.includes(theme);
              const isNudged = !isOn && nudgedThemes.has(theme);
              return (
                <button
                  key={theme}
                  className={[
                    "cs-theme-chip",
                    isOn      ? "cs-theme-chip-on"    : "",
                    isNudged  ? "cs-theme-chip-nudge" : "",
                  ].join(" ").trim()}
                  onClick={() => toggleTheme(theme)}
                  type="button"
                  title={isNudged ? `Related to: ${explicitThemes.filter(s => RELATED[s]?.includes(theme)).join(", ")}` : undefined}
                >
                  {isOn && <Heart size={12} className="cs-chip-icon" fill="currentColor" />}
                  {isNudged && <Sparkles size={11} className="cs-chip-icon cs-chip-nudge-icon" />}
                  {theme}
                  {isNudged && <span className="cs-nudge-label">related</span>}
                </button>
              );
            })}
          </div>

          {explicitThemes.length > 0 && (
            <p className="cs-selection-note">{explicitThemes.length} selected</p>
          )}

          <div className="cs-btn-row">
            <Button variant="ghost" onClick={() => setStep("welcome")}>Back</Button>
            <Button className="cs-cta-sm" onClick={() => setStep("location")}>
              {explicitThemes.length ? "Continue" : "Skip for now"} <ArrowRight size={16} />
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 3: Location ── */}
      {step === "location" && (
        <div className="cs-card">
          <p className="cs-eyebrow">Step 3 of 3</p>
          <h1 className="cs-heading">Near you,<br /><em>or anywhere.</em></h1>
          <p className="cs-body">
            Adding a city helps surface local causes first. Kindred does not
            request your device location — you type it yourself.
          </p>

          <label className="cs-location-toggle">
            <input
              type="checkbox"
              checked={locationConsent}
              onChange={(e) => setLocationConsent(e.target.checked)}
            />
            <MapPin size={16} />
            <span>Include a location</span>
          </label>

          {locationConsent && (
            <div className="cs-location-field">
              <div className="cs-location-header">
                <label htmlFor="cs-area-input">Your city or area</label>
                <button
                  type="button"
                  className="cs-live-geo-btn"
                  onClick={handleUseLiveLocation}
                  disabled={geoLocating}
                >
                  {geoLocating ? (
                    <>
                      <Loader2 size={13} className="animate-spin" />
                      <span>Detecting…</span>
                    </>
                  ) : (
                    <>
                      <Navigation size={13} />
                      <span>Use current location</span>
                    </>
                  )}
                </button>
              </div>
              <input
                id="cs-area-input"
                value={area}
                onChange={(e) => setArea(e.target.value)}
                placeholder="e.g. Lagos, London, Nairobi"
                maxLength={80}
              />
              {geoError && <p className="cs-geo-error">{geoError}</p>}
            </div>
          )}

          {notice && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          <div className="cs-btn-row">
            <Button variant="ghost" onClick={() => setStep("interests")}>Back</Button>
            <Button
              className="cs-cta-sm"
              disabled={busy}
              onClick={() => void (profile ? updateSettings() : createProfile())}
            >
              {busy ? "Saving…" : profile ? "Save and find causes" : "Find my causes"}
              <ArrowRight size={16} />
            </Button>
          </div>

          <p className="cs-privacy">
            <ShieldCheck size={14} />
            Your choices stay private and can be changed at any time.
          </p>
        </div>
      )}
    </section>
  );
};
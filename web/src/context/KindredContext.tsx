import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Match, RecommendationActivity, Theme, UserProfile } from "../../../src/types";

type Screen = "consent" | "activity" | "results";
type JobStatus = { status: "running" | "complete" | "error"; activity: RecommendationActivity[]; result?: {
  matchId: string; profileId: string; engine: "gemini-agent" | "rules-fallback"; confidence: number;
  needsInput: boolean; themes: Array<{ theme: Theme; weight: number; source: "merchant" | "explicit"; rationale: string }>; matches: Match[];
}; error?: string };

export interface KindredContextValue {
  profile: UserProfile | null;
  screen: Screen;
  busy: boolean;
  notice: string;
  area: string;
  setArea: (value: string) => void;
  locationCoords: { lat: number; lng: number } | null;
  setLocationCoords: (coords: { lat: number; lng: number } | null) => void;
  categoryConsent: boolean;
  setCategoryConsent: (value: boolean) => void;
  locationConsent: boolean;
  setLocationConsent: (value: boolean) => void;
  paypalPayerId: string;
  setPaypalPayerId: (value: string) => void;
  explicitThemes: Theme[];
  toggleTheme: (theme: Theme) => void;
  activities: RecommendationActivity[];
  data: JobStatus["result"] | null;
  selectedCause: Match | null;
  selectCause: (cause: Match | null) => void;
  donationAmount: string;
  setDonationAmount: (amount: string) => void;
  feedbackNotes: Record<string, string>;
  createProfile: () => Promise<void>;
  updateSettings: () => Promise<void>;
  requestRecommendations: () => Promise<void>;
  sendFeedback: (ngoId: string, action: "not_for_me" | "more_like_this") => Promise<void>;
  startOver: () => void;
}

const Context = createContext<KindredContextValue | null>(null);
const PROFILE_KEY = "kindred.profileId";

export function KindredProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [screen, setScreen] = useState<Screen>("consent");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [area, setArea] = useState("");
  const [locationCoords, setLocationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [categoryConsent, setCategoryConsent] = useState(false);
  const [locationConsent, setLocationConsent] = useState(false);
  const [paypalPayerId, setPaypalPayerId] = useState("");
  const [explicitThemes, setExplicitThemes] = useState<Theme[]>([]);
  const [activities, setActivities] = useState<RecommendationActivity[]>([]);
  const [data, setData] = useState<JobStatus["result"] | null>(null);
  const [selectedCause, setSelectedCause] = useState<Match | null>(null);
  const [donationAmount, setDonationAmount] = useState("25.00");
  const [feedbackNotes, setFeedbackNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    const id = localStorage.getItem(PROFILE_KEY);
    if (!id) return;
    let active = true;
    void fetch(`/api/profiles/${id}`).then((response) => response.ok ? response.json() as Promise<{ profile: UserProfile }> : null)
      .then((body) => {
        if (!active || !body) return;
        setProfile(body.profile);
        setCategoryConsent(body.profile.categorySignalsConsent);
        setLocationConsent(body.profile.locationConsent);
        setPaypalPayerId(body.profile.paypalPayerId || "");
        setExplicitThemes(body.profile.explicitThemes);
      }).catch(() => { if (active) localStorage.removeItem(PROFILE_KEY); });
    return () => { active = false; };
  }, []);

  const api = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, init);
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Kindred could not complete that request.");
    return body;
  }, []);

  const toggleTheme = useCallback((theme: Theme) => {
    setExplicitThemes((current) => current.includes(theme) ? current.filter((item) => item !== theme) : current.length < 8 ? [...current, theme] : current);
  }, []);

  const requestRecommendations = useCallback(async () => {
    if (!profile) return;
    setBusy(true); setNotice(""); setData(null); setActivities([]); setScreen("activity");
    try {
      const started = await api<{ jobId: string }>("/api/recommendations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: profile.id,
          area: locationConsent ? area.trim() || undefined : undefined,
          lat: locationConsent ? locationCoords?.lat : undefined,
          lng: locationConsent ? locationCoords?.lng : undefined,
        }),
      });
      let snapshot: JobStatus;
      do {
        await new Promise((resolve) => setTimeout(resolve, 350));
        snapshot = await api<JobStatus>(`/api/recommendations/${started.jobId}`);
        setActivities(snapshot.activity);
      } while (snapshot.status === "running");
      if (snapshot.status === "error" || !snapshot.result) throw new Error(snapshot.error ?? "Recommendations could not be prepared.");
      setData(snapshot.result); setSelectedCause(null); setScreen("results");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Recommendations could not be prepared.");
      setScreen("consent");
    } finally { setBusy(false); }
  }, [api, area, locationConsent, locationCoords, profile]);

  const createProfile = useCallback(async () => {
    setBusy(true); setNotice("");
    try {
      const response = await api<{ profile: UserProfile }>("/api/profiles", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categorySignalsConsent: categoryConsent, locationConsent, paypalPayerId: paypalPayerId.trim() || undefined, explicitThemes }),
      });
      setProfile(response.profile); localStorage.setItem(PROFILE_KEY, response.profile.id);
      await requestRecommendationsWith(response.profile);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Kindred profile could not be created."); }
    finally { setBusy(false); }

    async function requestRecommendationsWith(newProfile: UserProfile) {
      setScreen("activity"); setActivities([]);
      const started = await api<{ jobId: string }>("/api/recommendations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: newProfile.id,
          area: locationConsent ? area.trim() || undefined : undefined,
          lat: locationConsent ? locationCoords?.lat : undefined,
          lng: locationConsent ? locationCoords?.lng : undefined,
        }),
      });
      let snapshot: JobStatus;
      do {
        await new Promise((resolve) => setTimeout(resolve, 350));
        snapshot = await api<JobStatus>(`/api/recommendations/${started.jobId}`);
        setActivities(snapshot.activity);
      } while (snapshot.status === "running");
      if (snapshot.status === "error" || !snapshot.result) throw new Error(snapshot.error ?? "Recommendations could not be prepared.");
      setData(snapshot.result); setSelectedCause(null); setScreen("results");
    }
  }, [api, area, categoryConsent, explicitThemes, locationConsent, locationCoords]);

  const updateSettings = useCallback(async () => {
    if (!profile) return;
    setBusy(true); setNotice("");
    try {
      const response = await api<{ profile: UserProfile }>(`/api/profiles/${profile.id}/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categorySignalsConsent: categoryConsent, locationConsent, paypalPayerId: paypalPayerId.trim() || undefined, explicitThemes }),
      });
      setProfile(response.profile);
      if (!categoryConsent) { localStorage.removeItem(PROFILE_KEY); setProfile(null); setData(null); setScreen("consent"); return; }
      await requestRecommendations();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Settings could not be saved."); }
    finally { setBusy(false); }
  }, [api, categoryConsent, explicitThemes, locationConsent, profile, requestRecommendations]);

  const sendFeedback = useCallback(async (ngoId: string, action: "not_for_me" | "more_like_this") => {
    if (!profile) return;
    try {
      await api("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileId: profile.id, ngoId, action }) });
      setFeedbackNotes((current) => ({ ...current, [ngoId]: action === "not_for_me" ? "Noted. This cause will be de-emphasized." : "Noted. This cause is a stronger fit for you." }));
    } catch (error) { setNotice(error instanceof Error ? error.message : "Feedback could not be recorded."); }
  }, [api, profile]);

  const startOver = useCallback(() => { setScreen("consent"); setData(null); setNotice(""); setLocationCoords(null); }, []);
  const selectCause = useCallback((cause: Match | null) => setSelectedCause(cause), []);

  const value = useMemo<KindredContextValue>(() => ({
    profile, screen, busy, notice, area, setArea, locationCoords, setLocationCoords, categoryConsent, setCategoryConsent, locationConsent,
    setLocationConsent, paypalPayerId, setPaypalPayerId, explicitThemes, toggleTheme, activities, data, selectedCause, selectCause, donationAmount, setDonationAmount, feedbackNotes, createProfile,
    updateSettings, requestRecommendations, sendFeedback, startOver,
  }), [profile, screen, busy, notice, area, locationCoords, categoryConsent, locationConsent, paypalPayerId, explicitThemes, toggleTheme, activities, data, selectedCause, selectCause, donationAmount, feedbackNotes, createProfile, updateSettings, requestRecommendations, sendFeedback, startOver]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useKindred(): KindredContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("useKindred must be used within KindredProvider");
  return value;
}

export const THEMES = [
  "education", "health", "hunger", "water", "environment", "climate",
  "children", "women", "animals", "arts", "disaster", "economy",
  "rights", "sport", "tech", "community",
] as const;

export type Theme = (typeof THEMES)[number];
export const RECOMMENDABLE_THEMES = [
  "education", "hunger", "water", "environment", "climate", "children", "women",
  "animals", "arts", "disaster", "economy", "rights", "sport", "tech", "community",
] as const;
export type Source = "curated" | "example" | "live" | "simulated" | "user-provided" | "sample";
export type MerchantCategory =
  | "media_books"
  | "home_garden"
  | "sporting_goods"
  | "food_beverage"
  | "electronics_iot"
  | "toys_games"
  | "apparel_accessories"
  | "health_beauty"
  | "pet_supplies"
  | "office_supplies";

export type InterestProfile = {
  categories: Partial<Record<MerchantCategory, number>>;
  eventCount: number;
  updatedAt: string | null;
};

export type UserProfile = {
  id: string;
  createdAt: string;
  categorySignalsConsent: boolean;
  locationConsent: boolean;
  paypalPayerId?: string;
  explicitThemes: Theme[];
  interest: InterestProfile;
};

// Exact coordinates are request-scoped. They are never written to the store.
export type UserGeo = { lat: number; lng: number; h3: string; resolvedFrom: "explicit" };

// Compatibility types for the retired CSV/provider modules retained outside the active app flow.
export type Transaction = { id: string; date: string; description: string; amount: number; currency: string };
export type SanitizedTransaction = { month: string; description: string; amount: number; currency: string };
export type NgoProvider = "globalgiving" | "everyorg" | "betterplace" | "propublica" | "sample";
export type TraitLevel = "low" | "medium" | "high" | "insufficient";
export type TraitScore = { level: TraitLevel; confidence: number; evidence: string[] };
export type ThemeSignal = { theme: Theme; score: number; evidence: string[]; rationale?: string };
export type Analysis = {
  themes: ThemeSignal[]; sufficient: boolean; confidence: number; engine: "heuristic" | "gemini";
  transactionCount: number; discretionaryCount: number; source: Source; traits?: Record<string, TraitScore>;
};

export type Ngo = {
  id: string;
  name: string;
  mission: string;
  country: string;
  area?: string;
  imageUrl: string;
  projectUrl: string;
  provider?: NgoProvider;
  recipientMerchantId?: string;
  themes: Theme[];
  donors: number;
  fundingRaised: number;
  fundingGoal: number;
  source: Source;
  vettingNote: string;
  verificationStatus?: "verified" | "unverified";
  lastReviewed?: string | null;
  isSmall?: boolean;
  ein?: string;
  h3?: string;
  latitude?: number;
  longitude?: number;
  distanceKm?: number;
};

export type Match = Ngo & {
  score: number;
  primaryTheme: Theme;
  themeSource?: "merchant" | "explicit";
  reason: string;
  evidence: string[];
  timesShown: number;
};

export type RecommendationActivity = {
  step: "mapping" | "searching" | "checking" | "refining" | "ready" | "needs_input";
  message: string;
  status: "complete" | "active" | "waiting";
};

export type MatchResponse = {
  matchId: string;
  profileId: string;
  engine: "gemini-agent" | "rules-fallback";
  confidence: number;
  needsInput: boolean;
  themes: Array<{ theme: Theme; weight: number; source: "merchant" | "explicit"; rationale: string }>;
  matches: Match[];
  activities: RecommendationActivity[];
};

export type DonationRecord = {
  ngoId: string;
  matchId: string;
  profileId: string;
  amount: string;
  status: "created" | "captured" | "declined";
  captureId?: string;
  webhookVerified: boolean;
  createdAt: string;
  updatedAt: string;
};

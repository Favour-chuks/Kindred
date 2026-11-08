import { useKindred } from "@/context/KindredContext";
import { Sparkles, Sprout, ArrowLeft, ExternalLink, ChevronDown, ShoppingBag } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Badge } from "@/components/ui/badge";
import { VerifiedDonationPanel } from "./VerifiedDonationPanel";
import React, { useState } from "react";
import type { Match } from "src/types";

function CauseCard({ match, index, onGive, feedbackNote, onFeedback }: {
  match: Match;
  index: number;
  onGive: () => void;
  feedbackNote?: string;
  onFeedback: (action: "more_like_this" | "not_for_me") => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="rc-card">
      {/* Image strip */}
      <div className="rc-image">
        {match.imageUrl
          ? <img src={match.imageUrl} alt="" loading="lazy" />
          : <div className="rc-image-fallback" aria-hidden="true"><Sprout size={36} /></div>
        }
        <span className="rc-index">{String(index + 1).padStart(2, "0")}</span>
      </div>

      {/* Content */}
      <div className="rc-content">
        <div className="rc-meta">
          <span className="rc-location">{match.area ? `${match.area}, ` : ""}{match.country}</span>
          {typeof match.distanceKm === "number" && (
            <Badge variant="outline" className="rc-dist-badge">~{Math.round(match.distanceKm)} km</Badge>
          )}

          {match.themeSource === "merchant" ? (
            <span className="rc-merchant-signal-badge" title="Shaped by verified PayPal merchant purchase categories">
              <span className="rc-pulse-dot" />
              <ShoppingBag size={11} className="rc-pulse-icon" />
              <span>Merchant Signal</span>
            </span>
          ) : (
            <span className="rc-preference-signal-badge" title="Matched from your chosen cause preferences">
              <span>🎯 Your Preference</span>
            </span>
          )}
        </div>

        <h2 className="rc-name">{match.name}</h2>
        <p className="rc-mission">{match.mission}</p>

        {/* Theme tags */}
        <div className="rc-tags">
          {match.themes.slice(0, 3).map((t) => (
            <span key={t} className="rc-tag">{t}</span>
          ))}
        </div>

        {/* Expandable reason */}
        <button
          className="rc-why-toggle"
          onClick={() => setExpanded((p) => !p)}
          aria-expanded={expanded}
          type="button"
        >
          Why this appeared <ChevronDown size={14} className={`rc-chevron ${expanded ? "rc-chevron-open" : ""}`} />
        </button>
        {expanded && (
          <div className="rc-why-body">
            <p>{match.reason}</p>
            {match.vettingNote && <p className="rc-vetting">{match.vettingNote}</p>}
          </div>
        )}

        {/* Actions */}
        <div className="rc-actions">
          {feedbackNote
            ? <span className="rc-feedback-note">{feedbackNote}</span>
            : (
              <div className="rc-feedback-btns">
                <button type="button" className="rc-fb-btn" onClick={() => onFeedback("more_like_this")}>More like this</button>
                <button type="button" className="rc-fb-btn" onClick={() => onFeedback("not_for_me")}>Not for me</button>
              </div>
            )
          }

          <div className="rc-primary-actions">
            {match.projectUrl && (
              <a className="rc-visit" href={match.projectUrl} target="_blank" rel="noreferrer">
                Visit <ExternalLink size={12} />
              </a>
            )}
            {match.verificationStatus === "verified" && match.recipientMerchantId && (
              <Button size="sm" onClick={onGive}>Give with PayPal</Button>
            )}
          </div>
        </div>

        {(!match.recipientMerchantId || match.verificationStatus !== "verified") && (
          <p className="rc-unverified-note">PayPal checkout unavailable until this listing is independently verified.</p>
        )}
      </div>
    </article>
  );
}

export const ResultsScreen = () => {
  const { data, busy, feedbackNotes, sendFeedback, requestRecommendations, startOver, notice, selectCause, profile } = useKindred();

  if (!data) return (
    <section className="rs-shell">
      <div className="rs-loading">
        <Sparkles size={28} className="rs-loading-icon" />
        <p>Preparing your recommendations…</p>
      </div>
    </section>
  );

  return (
    <section className="rs-shell">
      {/* Heading */}
      <div className="rs-heading">
        <div>
          <p className="rs-eyebrow">Your Kindred shortlist</p>
          <h1 className="rs-title">Causes that connect<br /><em>with what matters.</em></h1>
        </div>
        <div className="rs-badges">
          <Badge variant="secondary">{data.engine === "gemini-agent" ? "AI agent" : "Rules fallback"}</Badge>
          <Badge variant="outline">{Math.round(data.confidence * 100)}% confidence</Badge>
        </div>
      </div>

      {/* What shaped this list — collapsed by default on mobile */}
      {data.themes.length > 0 && (() => {
        const merchantThemes = data.themes.filter((t) => t.source === "merchant");
        const explicitThemes = data.themes.filter((t) => t.source === "explicit");
        const merchantCategories = profile?.interest?.categories ?? {};
        const merchantSignalCount = Object.values(merchantCategories).reduce((sum, n) => sum + (n ?? 0), 0);
        return (
          <>
            {merchantSignalCount > 0 && (
              <div className="rs-merchant-banner">
                <ShoppingBag size={15} />
                <span>
                  <strong>{merchantSignalCount} merchant purchase signal{merchantSignalCount !== 1 ? "s" : ""}</strong> from your PayPal activity shaped these results
                </span>
              </div>
            )}
            <div className="rs-signal-bar">
              <Sparkles size={16} />
              <span>
                <strong>Shaped by:</strong>{" "}
                {data.themes.slice(0, 4).map((t, i) => (
                  <React.Fragment key={t.theme}>
                    {i > 0 && ", "}
                    {t.source === "merchant" ? (
                      <span className="rs-theme-merchant" title={`From merchant category signal: ${t.rationale}`}>
                        🏪 {t.theme}
                      </span>
                    ) : (
                      <span className="rs-theme-explicit" title={t.rationale}>{t.theme}</span>
                    )}
                  </React.Fragment>
                ))}
              </span>
              {merchantThemes.length > 0 && (
                <span className="rs-signal-source-note">· {merchantThemes.length} from PayPal</span>
              )}
            </div>
          </>
        );
      })()}

      {/* Needs more input */}
      {data.needsInput && (
        <Alert className="rs-alert">
          <Sparkles />
          <AlertTitle>Not enough evidence yet</AlertTitle>
          <AlertDescription>
            Choose one or more cause areas so Kindred has a starting point.
          </AlertDescription>
          <Button variant="outline" size="sm" className="mt-3" onClick={startOver}>Choose cause areas</Button>
        </Alert>
      )}

      {notice && (
        <Alert variant="destructive" className="rs-alert">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {/* Cause list */}
      {!data.needsInput && (
        <div className="rs-list">
          {data.matches.map((match, index) => (
            <CauseCard
              key={match.id}
              match={match}
              index={index}
              feedbackNote={feedbackNotes[match.id]}
              onGive={() => selectCause(match)}
              onFeedback={(action) => void sendFeedback(match.id, action)}
            />
          ))}
          {!data.matches.length && (
            <div className="rs-empty">
              <Sprout size={40} />
              <h2>No matching listings yet</h2>
              <p>Try a broader area or add another cause interest.</p>
            </div>
          )}
        </div>
      )}

      {/* Donation panel */}
      <VerifiedDonationPanel />

      {/* Footer controls */}
      <div className="rs-footer">
        <Button variant="outline" onClick={startOver}>
          <ArrowLeft size={16} /> Edit my choices
        </Button>
        <Button disabled={busy} onClick={() => void requestRecommendations()}>
          Refresh <Sparkles size={16} />
        </Button>
      </div>

      {/* How it works — collapsed */}
      <details className="rs-trace">
        <summary>How Kindred made these recommendations</summary>
        <ol>
          <li>The agent maps allowed cause themes from broad merchant categories and your interests.</li>
          <li>A catalog search finds causes by theme and, when opted in, by area.</li>
          <li>An AI fit review can request one bounded refinement.</li>
          <li>Deterministic ranking applies your feedback; PayPal checkout stays blocked until the recipient is verified.</li>
        </ol>
      </details>
    </section>
  );
};

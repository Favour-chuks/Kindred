import { useKindred } from "@/context/KindredContext";
import { Check, Sparkles, Circle, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";

export const ActivityScreen = () => {
  const { activities, busy, notice, startOver } = useKindred();
  const latest = activities.at(-1);
  const progress = busy ? Math.min(90, 15 + activities.length * 17) : 100;

  return (
    <section className="ac-shell">
      <div className="ac-card" aria-live="polite">

        {/* Header */}
        <div className="ac-header">
          <div className="ac-spinner-wrap">
            {busy
              ? <Loader2 size={28} className="ac-spinner" />
              : <Check size={28} className="ac-check" />
            }
          </div>
          <div>
            <p className="ac-eyebrow">Kindred is working</p>
            <h2 className="ac-heading">
              {busy ? "Finding your cause matches…" : "Done! Preparing your results."}
            </h2>
          </div>
        </div>

        {/* Progress bar */}
        <div className="ac-progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="ac-progress-fill" style={{ width: `${progress}%` }} />
        </div>

        {/* Activity steps */}
        {activities.length > 0 && (
          <ol className="ac-list">
            {activities.map((item, index) => (
              <li key={`${item.step}-${index}`} className={`ac-item ${item.status === "active" ? "ac-item-active" : item.status === "complete" ? "ac-item-done" : ""}`}>
                <span className="ac-item-icon">
                  {item.status === "complete" ? <Check size={13} /> : item.status === "active" ? <Sparkles size={13} /> : <Circle size={13} />}
                </span>
                <span className="ac-item-text">{item.message}</span>
                {index === activities.length - 1 && item.status === "active" && (
                  <span className="ac-live-badge">Live</span>
                )}
              </li>
            ))}
          </ol>
        )}

        {!activities.length && busy && (
          <p className="ac-starting">Starting the recommendation agent…</p>
        )}

        {latest?.status === "waiting" && (
          <p className="ac-waiting-note">
            The agent needs a little more context. We'll ask you to choose after.
          </p>
        )}

        {notice && (
          <Alert variant="destructive" className="mt-5">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {!busy && notice && (
          <Button variant="outline" className="mt-3" onClick={startOver}>
            Back to choices
          </Button>
        )}
      </div>
    </section>
  );
};

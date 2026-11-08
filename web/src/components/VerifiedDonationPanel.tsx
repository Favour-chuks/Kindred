import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Heart, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useKindred } from "../context/KindredContext";

export function VerifiedDonationPanel() {
  const { selectedCause, profile, data, donationAmount, setDonationAmount, selectCause } = useKindred();
  const host = useRef<HTMLDivElement>(null);
  const sdk = useRef<PaypalSdk | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "ineligible">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const config = await fetch("/api/config").then((response) => response.json()) as { clientId?: string | null; paypal?: { connected?: boolean } };
        if (!config.clientId || !config.paypal?.connected) throw new Error("PayPal Sandbox is not configured.");
        if (!window.paypal) await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://www.sandbox.paypal.com/web-sdk/v6/core";
          script.async = true; script.onload = () => resolve(); script.onerror = () => reject(new Error("PayPal could not load."));
          document.head.appendChild(script);
        });
        if (!window.paypal) throw new Error("PayPal is unavailable.");
        sdk.current = await window.paypal.createInstance({ clientId: config.clientId, components: ["paypal-payments"], pageType: "checkout" });
        if (active) setState("ready");
      } catch (error) {
        if (active) { setState("unavailable"); setMessage(error instanceof Error ? error.message : "PayPal is unavailable."); }
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedCause || !profile || !data || !host.current || !sdk.current || (state !== "ready" && state !== "ineligible")) return;
    const element = host.current;
    let active = true;
    element.replaceChildren();
    const amount = Number(donationAmount);
    if (!Number.isFinite(amount) || amount < 1 || amount > 500) { setState("ineligible"); return; }
    void sdk.current.findEligibleMethods({ currencyCode: "USD", amount: amount.toFixed(2) }).then((methods) => {
      if (!active) return;
      if (!methods.isEligible("paypal")) { setState("ineligible"); return; }
      setState("ready");
      const button = document.createElement("paypal-button");
      button.setAttribute("type", "pay"); button.setAttribute("class", "paypal-gold");
      const session = sdk.current!.createPayPalOneTimePaymentSession({
        onApprove: async ({ orderId }) => {
          setMessage("Confirming payment with PayPal…");
          const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST" });
          const result = await response.json() as { ok?: boolean; error?: string; captureId?: string };
          if (!response.ok || !result.ok) throw new Error(result.error ?? "PayPal did not complete the payment.");
          setMessage(`Payment captured by the selected PayPal recipient. Reference: ${result.captureId ?? orderId}`);
        },
        onCancel: () => setMessage("You cancelled checkout. Your cause selection is still saved."),
        onError: (error) => setMessage(error instanceof Error ? error.message : "PayPal checkout could not complete."),
      });
      button.addEventListener("click", () => {
        const createOrder = fetch("/api/orders", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: profile.id, matchId: data.matchId, ngoId: selectedCause.id, amount: amount.toFixed(2) }),
        }).then(async (response) => {
          const result = await response.json() as { orderId?: string; error?: string };
          if (!response.ok || !result.orderId) throw new Error(result.error ?? "PayPal order could not be created.");
          return { orderId: result.orderId };
        });
        void session.start({ presentationMode: "auto" }, createOrder).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "PayPal checkout could not start."));
      });
      element.replaceChildren(button);
    }).catch(() => setState("unavailable"));
    return () => { active = false; element.replaceChildren(); };
  }, [data, donationAmount, profile, selectedCause, state]);

  if (!selectedCause) return null;
  return <section className="verified-gift-panel" aria-live="polite">
    <div className="verified-gift-heading"><Heart /><div><span className="section-kicker">Separate giving step</span><h2>Give to {selectedCause.name}</h2><p>PayPal checkout is addressed to this organization's reviewed PayPal merchant account.</p></div><Button variant="ghost" onClick={() => selectCause(null)}>Close</Button></div>
    <div className="verified-gift-form">
      <div className="donation-amounts">{[10, 25, 50].map((value) => <Button key={value} variant={donationAmount === value.toFixed(2) ? "default" : "outline"} onClick={() => setDonationAmount(value.toFixed(2))}>${value}</Button>)}
        <label className="gift-custom-amount"><span>$</span><input aria-label="Custom donation amount" inputMode="decimal" value={donationAmount} onChange={(event) => setDonationAmount(event.target.value.replace(/[^\d.]/g, ""))} /></label>
      </div>
      {state === "loading" && <p className="payment-loading"><Loader2 /> Preparing PayPal checkout…</p>}
      {state === "unavailable" && <Alert variant="destructive"><AlertCircle /><AlertDescription>{message || "PayPal is unavailable."}</AlertDescription></Alert>}
      {state === "ineligible" && <Alert variant="destructive"><AlertDescription>Choose an amount from $1 to $500 USD and confirm PayPal is available.</AlertDescription></Alert>}
      {state === "ready" && <div ref={host} className="paypal-host"><span className="payment-loading">Loading PayPal…</span></div>}
      {message && state === "ready" && <p className="gift-status"><CheckCircle2 />{message}</p>}
    </div>
  </section>;
}

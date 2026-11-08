import { Sprout, Store } from "lucide-react";

export const BrandHeader = () => {
  return (
    <header className="topbar">
      <div className="brand-mark"><Sprout /> kindred</div>
      <div style={{ display: "flex", alignItems: "center", justifyItems: "flex-end", gap: "14px" }}>
        <span className="topbar-note">Thoughtful giving, shaped by your interests</span>
        
        <a
          href="/merchant"
          target="_blank"
          rel="noreferrer"
          className="topbar-partner-link"
          title="Open sample partner merchant store with real PayPal Sandbox checkout"
        >
          <Store size={13} />
          <span>Partner Store</span>
        </a>
      </div>
    </header>
  );
};

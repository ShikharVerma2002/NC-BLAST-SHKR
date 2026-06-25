// ┌───────────────────────────────────────────────────────────────────────┐
// │  apps/judge/src/components/PinModal.tsx                                │
// │                                                                         │
// │  Reusable 4-digit PIN entry modal with on-screen keypad.                │
// │  Mirrors standalone NC BLAST PinModal (index.html:15889+).              │
// │                                                                         │
// │  Used by:                                                               │
// │  - Judge submit flow when a tournament has a PIN configured             │
// │  - Any future flow that needs a 4-digit confirm gate                    │
// └───────────────────────────────────────────────────────────────────────┘
import { useState } from "react";

interface PinModalProps {
  /** Big bold title at the top of the modal. */
  title: string;
  /** Optional smaller subtitle line beneath the title. */
  subtitle?: string;
  /** Called with the 4-digit PIN string when the user confirms. */
  onSubmit: (pin: string) => void;
  /** Called when the user taps Cancel. */
  onCancel: () => void;
  /** Optional error message rendered between the dots and keypad. */
  error?: string | null;
  /** When true, disables all buttons and shows "Checking…" on the confirm. */
  loading?: boolean;
}

export function PinModal({ title, subtitle, onSubmit, onCancel, error, loading }: PinModalProps) {
  const [digits, setDigits] = useState<[string, string, string, string]>(["", "", "", ""]);

  /** Append the next digit to the first empty slot (left-to-right fill). */
  const pressDigit = (d: number): void => {
    setDigits((prev) => {
      const filled = prev.filter((x) => x !== "").length;
      if (filled >= 4) return prev;
      const next: [string, string, string, string] = [...prev];
      next[filled] = String(d);
      return next;
    });
  };

  /** Erase the right-most non-empty digit. */
  const pressBack = (): void => {
    setDigits((prev) => {
      const next: [string, string, string, string] = [...prev];
      for (let i = 3; i >= 0; i--) {
        if (next[i] !== "") {
          next[i] = "";
          break;
        }
      }
      return next;
    });
  };

  const pin = digits.join("");
  const ready = pin.length === 4;

  const handleSubmit = (): void => {
    if (ready && !loading) onSubmit(pin);
  };

  // Keypad layout: 1-9 across the top, then [empty, 0, ⌫] on the bottom row.
  // The empty cell preserves grid alignment without rendering a button.
  const keys: Array<number | "" | "⌫"> = [1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.8)", zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 24px" }}>
      <div style={{ background: "var(--surface)", borderRadius: 20, padding: "24px 20px 20px", maxWidth: 300, width: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.4)", border: "1px solid var(--border)" }}>
        <p style={{ fontSize: 17, fontWeight: 900, color: "var(--text-primary)", margin: "0 0 4px", textAlign: "center" }}>{title}</p>
        {subtitle && <p style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", margin: "0 0 20px", lineHeight: 1.5 }}>{subtitle}</p>}
        {!subtitle && <div style={{ height: 16 }} />}

        {/* Dot display — one circle per digit slot, filled when entered. */}
        <div style={{ display: "flex", gap: 14, justifyContent: "center", marginBottom: 16 }}>
          {digits.map((d, i) => (
            <div
              key={i}
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: d ? "#EA580C" : "var(--border2)",
                transition: "background 0.1s",
                border: error ? "2px solid #EF4444" : "none",
              }}
            />
          ))}
        </div>

        {error && <p style={{ fontSize: 12, color: "#EF4444", textAlign: "center", marginBottom: 12, fontWeight: 600 }}>{error}</p>}

        {/* Keypad — 3-column grid, 4 rows. Row 4 has [empty, 0, ⌫]. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
          {keys.map((k, i) => {
            const isEmpty = k === "";
            const isBack = k === "⌫";
            return (
              <button
                key={i}
                type="button"
                onClick={isEmpty ? undefined : isBack ? pressBack : (): void => pressDigit(k as number)}
                disabled={loading || isEmpty}
                style={{
                  height: 52,
                  borderRadius: 12,
                  border: isBack ? "2px solid var(--border2)" : "2px solid var(--border)",
                  background: isEmpty ? "transparent" : isBack ? "var(--surface2)" : "var(--surface3)",
                  color: isBack ? "var(--text-secondary)" : "var(--text-primary)",
                  fontSize: isBack ? 20 : 22,
                  fontWeight: 700,
                  fontFamily: "'Outfit',sans-serif",
                  cursor: isEmpty || loading ? "default" : "pointer",
                  opacity: isEmpty ? 0 : 1,
                }}
              >
                {k}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!ready || loading}
          style={{
            display: "block",
            width: "100%",
            padding: "13px 0",
            borderRadius: 12,
            border: "none",
            background: ready && !loading ? "#EA580C" : "var(--surface3)",
            color: ready && !loading ? "#fff" : "var(--text-disabled)",
            fontSize: 15,
            fontWeight: 800,
            fontFamily: "'Outfit',sans-serif",
            cursor: ready && !loading ? "pointer" : "not-allowed",
            marginBottom: 8,
          }}
        >
          {loading ? "Checking…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          style={{
            display: "block",
            width: "100%",
            padding: "9px 0",
            borderRadius: 12,
            border: "2px solid var(--border)",
            background: "none",
            color: "var(--text-muted)",
            fontSize: 13,
            fontWeight: 700,
            fontFamily: "'Outfit',sans-serif",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

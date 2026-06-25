/* eslint-disable react/jsx-key */
// ┌───────────────────────────────────────────────────────────────────────┐
// │  apps/judge/src/components/ShuffleTimer.tsx                            │
// │                                                                         │
// │  60-second between-shuffle countdown shown in tournament mode when      │
// │  both players have used all 3 of their combos in a single set OR        │
// │  immediately after side-pick on a new set. Mirrors the standalone       │
// │  index.html ShuffleTimerInner — same visual stopwatch, hold-to-pause,   │
// │  expired full-screen state, and "Players Ready" early-dismiss button.   │
// │                                                                         │
// │  States:                                                                │
// │    "active"  — mid-set shuffle (both decks empty, no set won)           │
// │    "newset"  — start of a new set after side-pick                       │
// │  The mode only differs in what the dismiss handler does after — that's  │
// │  managed by the parent (MatchScreen) since it owns shuf/used arrays.    │
// └───────────────────────────────────────────────────────────────────────┘
import { useEffect, useRef, useState } from "react";
import type { MatchConfig } from "@ncblast/shared";

interface ShuffleTimerProps {
  onDismiss: () => void;
  p1: string | null;
  p2: string | null;
  sets: [number, number];
  pts: [number, number];
  need: number;
  curSet: number;
  config: MatchConfig;
  swapped: boolean;
}

/** 60-second total countdown — same as standalone. */
const TOTAL = 60;

export function ShuffleTimer({ onDismiss, p1, p2, sets, pts, need, curSet, config, swapped }: ShuffleTimerProps) {
  const [seconds, setSeconds] = useState(TOTAL);
  const [expired, setExpired] = useState(false);
  const [paused, setPaused] = useState(false);
  // pausedRef mirrors paused state for the interval callback (avoids stale-closure
  // bugs when the user pauses then resumes — the interval keeps the same closure
  // for its lifetime).
  const pausedRef = useRef(false);

  const pauseTimer = (): void => { pausedRef.current = true; setPaused(true); };
  const resumeTimer = (): void => { pausedRef.current = false; setPaused(false); };

  useEffect(() => {
    const interval = setInterval(() => {
      if (pausedRef.current) return;
      setSeconds((s) => {
        if (s <= 1) {
          clearInterval(interval);
          setExpired(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // ── Geometry for the analog stopwatch SVG ─────────────────────────────
  const fraction = seconds / TOTAL;
  const handDeg = (1 - fraction) * 360 - 90;
  const R = 90;
  const WCX = 110;
  const WCY = 130;
  const elapsed = 1 - fraction;
  const arcAngle = elapsed * 2 * Math.PI;
  const startX = WCX + R * Math.cos(-Math.PI / 2);
  const startY = WCY + R * Math.sin(-Math.PI / 2);
  const endX = WCX + R * Math.cos(-Math.PI / 2 + arcAngle);
  const endY = WCY + R * Math.sin(-Math.PI / 2 + arcAngle);
  const largeArc = elapsed > 0.5 ? 1 : 0;

  // ── EXPIRED state — full-screen red, single Continue button ───────────
  if (expired) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#DC2626", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 600, padding: "24px" }}>
        <p style={{ fontSize: 48, fontWeight: 900, color: "#fff", textAlign: "center", lineHeight: 1.1, marginBottom: 16 }}>⏱️</p>
        <p style={{ fontSize: 28, fontWeight: 900, color: "#fff", textAlign: "center", lineHeight: 1.2, marginBottom: 12, letterSpacing: 1 }}>SHUFFLE TIME</p>
        <p style={{ fontSize: 28, fontWeight: 900, color: "#fff", textAlign: "center", lineHeight: 1.2, marginBottom: 40, letterSpacing: 1 }}>EXPIRED</p>
        <button
          type="button"
          onClick={onDismiss}
          style={{ padding: "16px 40px", borderRadius: 16, border: "3px solid rgba(255,255,255,0.5)", background: "rgba(255,255,255,0.15)", color: "#fff", fontSize: 18, fontWeight: 800, fontFamily: "'Outfit',sans-serif", cursor: "pointer" }}
        >
          Continue →
        </button>
      </div>
    );
  }

  // ── Active state ───────────────────────────────────────────────────────
  // Hold-to-pause: pressing the stopwatch (mouse or touch) pauses the
  // countdown; releasing resumes. onMouseLeave also resumes so dragging
  // the cursor off doesn't strand the timer in paused state.
  const holdEvents = {
    onMouseDown: pauseTimer,
    onMouseUp: resumeTimer,
    onMouseLeave: resumeTimer,
    onTouchStart: (e: React.TouchEvent): void => { e.preventDefault(); pauseTimer(); },
    onTouchEnd: resumeTimer,
  };

  // Match-state-summary local computation (respects the swapped flag so the
  // visual order matches what's currently displayed on the battle screen).
  const isBO3plus = config.bo > 1;
  const ptLimit = config.pts > 0 ? config.pts : null;
  const leftName = swapped ? p2 : p1;
  const rightName = swapped ? p1 : p2;
  const leftSets = swapped ? sets[1] : sets[0];
  const rightSets = swapped ? sets[0] : sets[1];
  const leftPts = swapped ? pts[1] : pts[0];
  const rightPts = swapped ? pts[0] : pts[1];
  const leftColor = swapped ? "#EF4444" : "#3B82F6";
  const rightColor = swapped ? "#3B82F6" : "#EF4444";

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-solid)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 600, padding: "24px", gap: 0 }}>
      <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: 3, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 12 }}>Shuffle Order Selection</p>

      {/* Match state summary — visible during shuffle so judges can answer
          questions like "what's the score?" without needing to back out. */}
      {p1 && p2 && (
        <div style={{ width: "100%", maxWidth: 340, marginBottom: 16, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 14, overflow: "hidden" }}>
          {isBO3plus && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px 6px", borderBottom: "1px solid var(--border2)" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: leftColor, flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 }}>{leftName}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 22, fontWeight: 900, color: leftColor, minWidth: 24, textAlign: "center" }}>{leftSets}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", letterSpacing: 1 }}>SETS</span>
                <span style={{ fontSize: 22, fontWeight: 900, color: rightColor, minWidth: 24, textAlign: "center" }}>{rightSets}</span>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: rightColor, flex: 1, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 }}>{rightName}</span>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: isBO3plus ? "8px 14px 10px" : "10px 14px" }}>
            {!isBO3plus && <span style={{ fontSize: 11, fontWeight: 700, color: leftColor, flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 }}>{leftName}</span>}
            {isBO3plus && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", flex: 1, textAlign: "left" }}>Set {curSet}</span>}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 28, fontWeight: 900, color: leftColor, minWidth: 28, textAlign: "center" }}>{leftPts}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", letterSpacing: 1 }}>{ptLimit ? "PTS" : "–"}</span>
              <span style={{ fontSize: 28, fontWeight: 900, color: rightColor, minWidth: 28, textAlign: "center" }}>{rightPts}</span>
            </div>
            {!isBO3plus && <span style={{ fontSize: 11, fontWeight: 700, color: rightColor, flex: 1, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 }}>{rightName}</span>}
            {isBO3plus && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", flex: 1, textAlign: "right" }}>First to {ptLimit || "∞"}</span>}
          </div>
          <div style={{ background: "var(--bg-tint, rgba(0,0,0,0.03))", borderTop: "1px solid var(--border2)", padding: "5px 14px", textAlign: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-faint)", letterSpacing: 0.3 }}>
              {isBO3plus ? `First to ${need} set${need > 1 ? "s" : ""} wins the match` : "First to reach point limit wins"}
            </span>
          </div>
        </div>
      )}

      {/* Stopwatch SVG — hold to pause, release to resume. */}
      <div {...holdEvents} style={{ cursor: "pointer", userSelect: "none", WebkitUserSelect: "none", touchAction: "none" }}>
        <svg width="220" height="240" viewBox="0 0 220 260" style={{ marginBottom: 0, display: "block" }}>
          {/* Watch body */}
          <circle cx="110" cy="130" r="96" fill={paused ? "#FEF9C3" : "var(--surface)"} stroke={paused ? "#CA8A04" : "var(--border2)"} strokeWidth="4" />
          {/* Crown / button at top */}
          <rect x="96" y="28" width="28" height="12" rx="6" fill="var(--border2)" />
          <rect x="104" y="22" width="12" height="10" rx="4" fill="var(--border2)" />
          {/* Tick marks — major every 5, minor for the rest */}
          {Array.from({ length: 60 }).map((_, i) => {
            const angle = (i / 60) * 2 * Math.PI - Math.PI / 2;
            const isMajor = i % 5 === 0;
            const r1 = isMajor ? 78 : 82;
            const r2 = 90;
            return (
              <line
                key={i}
                x1={110 + r1 * Math.cos(angle)}
                y1={130 + r1 * Math.sin(angle)}
                x2={110 + r2 * Math.cos(angle)}
                y2={130 + r2 * Math.sin(angle)}
                stroke={isMajor ? "var(--text-secondary)" : "var(--border2)"}
                strokeWidth={isMajor ? 2 : 1}
              />
            );
          })}
          {/* Elapsed arc — red sweep that grows clockwise as time runs out. */}
          {elapsed > 0 && elapsed < 1 && (
            <path
              d={`M ${startX} ${startY} A ${R} ${R} 0 ${largeArc} 1 ${endX} ${endY}`}
              fill="none"
              stroke={paused ? "#CA8A04" : "#EF4444"}
              strokeWidth="6"
              strokeLinecap="round"
              opacity="0.35"
            />
          )}
          {elapsed >= 1 && (
            <circle cx="110" cy="130" r={R} fill="none" stroke="#EF4444" strokeWidth="6" opacity="0.35" />
          )}
          {/* Center pivot */}
          <circle cx="110" cy="130" r="5" fill="var(--text-secondary)" />
          {/* Second hand — turns grey when paused. */}
          <line
            x1="110"
            y1="130"
            x2={110 + 78 * Math.cos((handDeg * Math.PI) / 180)}
            y2={130 + 78 * Math.sin((handDeg * Math.PI) / 180)}
            stroke={paused ? "#94A3B8" : "#EF4444"}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          {/* Counter-weight tail */}
          <line
            x1="110"
            y1="130"
            x2={110 - 18 * Math.cos((handDeg * Math.PI) / 180)}
            y2={130 - 18 * Math.sin((handDeg * Math.PI) / 180)}
            stroke={paused ? "#94A3B8" : "#EF4444"}
            strokeWidth="3"
            strokeLinecap="round"
          />
          {/* Pause icon overlay shown during paused state. */}
          {paused && (
            <g>
              <rect x="98" y="117" width="9" height="26" rx="3" fill="#CA8A04" opacity="0.9" />
              <rect x="113" y="117" width="9" height="26" rx="3" fill="#CA8A04" opacity="0.9" />
            </g>
          )}
        </svg>

        {/* Countdown number — same hold target as the stopwatch SVG. */}
        <p
          {...holdEvents}
          style={{ fontSize: 64, fontWeight: 900, color: paused ? "#CA8A04" : "var(--text-primary)", lineHeight: 1, marginBottom: 4, fontVariantNumeric: "tabular-nums", textAlign: "center", cursor: "pointer", userSelect: "none", WebkitUserSelect: "none" }}
        >
          {seconds}
        </p>
      </div>

      <p style={{ fontSize: 13, fontWeight: 600, color: paused ? "#CA8A04" : "var(--text-muted)", marginBottom: 4, marginTop: 4 }}>
        {paused ? "⏸ Paused — release to resume" : "seconds remaining"}
      </p>
      <p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-faint)", marginBottom: 32, letterSpacing: 0.5 }}>Hold clock to pause</p>

      <button
        type="button"
        onClick={onDismiss}
        style={{ padding: "16px 40px", borderRadius: 16, border: "none", background: "#22C55E", color: "#fff", fontSize: 18, fontWeight: 800, fontFamily: "'Outfit',sans-serif", cursor: "pointer", boxShadow: "0 4px 16px rgba(34,197,94,0.35)" }}
      >
        ✓ Players Ready
      </button>
    </div>
  );
}

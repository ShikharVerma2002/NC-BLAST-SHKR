import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { S } from "../styles";
import { IC } from "../components/Icons";
import { normalizeChallongeSlug } from "../utils";

/**
 * Player entry. Currently: bracket embed via Challonge's public module URL.
 * Stubs scaffolded for combo prereg, live standings, top-cut cutline calc.
 */
export function PlayerScreen() {
  const nav = useNavigate();
  const [slug, setSlug] = useState("");
  const [embedSlug, setEmbedSlug] = useState<string | null>(null);

  const showBracket = (): void => {
    const s = normalizeChallongeSlug(slug);
    if (!s) return;
    setEmbedSlug(s);
  };

  const stubs: Array<{ title: string; body: string; emoji: string }> = [
    { emoji: "🛠️", title: "Combo Preregistration", body: "Lock in your 3 combos before you arrive — your judge loads them instantly." },
    { emoji: "📈", title: "Live Standings", body: "Real-time tournament standings pulled from Challonge." },
    { emoji: "🎯", title: "Top Cut Calculator", body: "Going into round 5: exactly how many points you need to make cut." },
  ];

  return (
    <div style={{ ...S.current.page, height: "100dvh", overflowY: "auto", paddingBottom: 80 }}>
      <button style={{ ...S.current.back, marginBottom: 8 }} onClick={() => nav("/")}>
        {IC.back} Back
      </button>
      <h1 style={{ ...S.current.title, color: "#EA580C" }}>🎯 Player</h1>
      <p style={S.current.sub}>View the bracket and check standings</p>

      {/* Bracket view — functional today via Challonge's public embed. */}
      <div style={{ ...S.current.card, borderLeft: "4px solid #EA580C", padding: "14px 16px" }}>
        <h2 style={{ ...S.current.label, color: "#EA580C", fontSize: 14 }}>View Bracket</h2>
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
          Paste the full Challonge URL or just the slug (e.g. <code style={{ background: "var(--surface2)", padding: "1px 5px", borderRadius: 4 }}>ncbl.challonge.com/blastTEST</code>).
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
          <input
            type="text"
            autoComplete="off"
            value={slug}
            onChange={e => setSlug(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") showBracket(); }}
            placeholder="Challonge URL or slug"
            style={{ flex: 1, padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", outline: "none" }}
          />
          <button
            type="button"
            onClick={showBracket}
            disabled={!normalizeChallongeSlug(slug)}
            style={{ padding: "0 16px", borderRadius: 8, border: "none", background: normalizeChallongeSlug(slug) ? "#EA580C" : "#CBD5E1", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: normalizeChallongeSlug(slug) ? "pointer" : "not-allowed" }}
          >
            Show
          </button>
        </div>
        {slug.trim() && (() => {
          const derived = normalizeChallongeSlug(slug);
          return derived && derived !== slug.trim() ? (
            <p style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 10, fontFamily: "'JetBrains Mono', monospace" }}>
              → slug: <strong style={{ color: "#EA580C" }}>{derived}</strong>
            </p>
          ) : null;
        })()}
        {embedSlug && (
          <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: "#fff" }}>
            {/*
              Challonge's public module — works without auth for public
              tournaments. Their embed URL format: /{slug}/module
            */}
            <iframe
              title={`Challonge bracket for ${embedSlug}`}
              src={`https://challonge.com/${encodeURIComponent(embedSlug)}/module`}
              style={{ width: "100%", height: 500, border: "none" }}
              allowTransparency
            />
          </div>
        )}
      </div>

      <div style={{ height: 16 }} />

      <h2 style={{ ...S.current.label, color: "var(--text-muted)", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginTop: 12 }}>
        Coming soon
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {stubs.map(s => (
          <div
            key={s.title}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px dashed var(--border)",
              background: "var(--surface2)",
              opacity: 0.7,
            }}
          >
            <span style={{ fontSize: 22 }}>{s.emoji}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>{s.title}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{s.body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { S } from "../styles";
import { IC } from "../components/Icons";
import { setPin } from "../pin";
import { normalizeChallongeSlug } from "../utils";

/**
 * Organizer entry. PIN management is fully functional today — the rest
 * (tournament creation, manual bracket edits, approval queue, stream overlay
 * controls) are scaffolded placeholders for future builds.
 */
export function OrganizerScreen() {
  const nav = useNavigate();
  const [orgMaster, setOrgMaster] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [orgPin, setOrgPin] = useState("");
  const [orgStatus, setOrgStatus] = useState<null | "loading" | { ok: boolean; msg: string }>(null);

  const submit = async (): Promise<void> => {
    setOrgStatus("loading");
    const slug = normalizeChallongeSlug(orgSlug);
    if (!slug) {
      setOrgStatus({ ok: false, msg: "Couldn't read a tournament slug from that URL." });
      return;
    }
    const result = await setPin(orgMaster.trim(), slug, orgPin.trim());
    if (result.ok) {
      setOrgStatus({ ok: true, msg: `✓ PIN set for "${slug}"` });
      setOrgPin("");
    } else {
      setOrgStatus({ ok: false, msg: result.message });
    }
  };

  const stubs: Array<{ title: string; body: string; emoji: string }> = [
    { emoji: "🏆", title: "Create Tournament", body: "Spin up a new Challonge bracket and push it to judges instantly." },
    { emoji: "📋", title: "Call Next Matches", body: "See open matches, assign to a judge, notify them on their tablet." },
    { emoji: "🛠️", title: "Manual Override", body: "Edit bracket standings or correct a submitted score before it's final." },
    { emoji: "✅", title: "Approval Queue", body: "Optionally review every match result before it posts to Challonge." },
    { emoji: "📺", title: "Stream Overlay Controls", body: "Switch which match the overlay is showing, push announcements." },
  ];

  const ready = orgMaster.trim() && normalizeChallongeSlug(orgSlug) && orgPin.length >= 4 && orgStatus !== "loading";

  return (
    <div style={{ ...S.current.page, height: "100dvh", overflowY: "auto", paddingBottom: 80 }}>
      <button style={{ ...S.current.back, marginBottom: 8 }} onClick={() => nav("/")}>
        {IC.back} Back
      </button>
      <h1 style={{ ...S.current.title, color: "#7C3AED" }}>🎛️ Organizer</h1>
      <p style={S.current.sub}>Tournament management for event runners</p>

      {/* PIN management — the one organizer feature that's fully built. */}
      <div style={{ ...S.current.card, borderLeft: "4px solid #7C3AED", padding: "14px 16px" }}>
        <h2 style={{ ...S.current.label, color: "#7C3AED", fontSize: 14 }}>Set Tournament PIN</h2>
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
          Required before judges can submit match results for a Challonge tournament.
          Ask your admin for the master key.
        </p>
        <input
          type="password"
          autoComplete="off"
          value={orgMaster}
          onChange={e => { setOrgMaster(e.target.value); setOrgStatus(null); }}
          placeholder="Master key"
          style={{ width: "100%", padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", marginBottom: 8, outline: "none", boxSizing: "border-box" }}
        />
        <input
          type="text"
          autoComplete="off"
          value={orgSlug}
          onChange={e => { setOrgSlug(e.target.value); setOrgStatus(null); }}
          placeholder="Challonge URL or slug"
          style={{ width: "100%", padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", marginBottom: 4, outline: "none", boxSizing: "border-box" }}
        />
        {orgSlug.trim() && (() => {
          const derived = normalizeChallongeSlug(orgSlug);
          return derived ? (
            <p style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 8, fontFamily: "'JetBrains Mono', monospace" }}>
              → slug: <strong style={{ color: "#7C3AED" }}>{derived}</strong>
            </p>
          ) : (
            <p style={{ fontSize: 10, color: "#DC2626", marginBottom: 8 }}>
              Couldn't parse a slug from that input.
            </p>
          );
        })()}
        <input
          type="tel"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          value={orgPin}
          onChange={e => { setOrgPin(e.target.value.replace(/[^0-9]/g, "")); setOrgStatus(null); }}
          placeholder="PIN (4-8 digits)"
          style={{ width: "100%", padding: "12px 12px", fontSize: 18, letterSpacing: 3, textAlign: "center", borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, marginBottom: 10, outline: "none", boxSizing: "border-box" }}
        />
        {orgStatus && orgStatus !== "loading" && (
          <p style={{ fontSize: 12, fontWeight: 600, textAlign: "center", marginBottom: 10, color: orgStatus.ok ? "#15803D" : "#DC2626" }}>
            {orgStatus.msg}
          </p>
        )}
        <button
          type="button"
          disabled={!ready}
          onClick={() => void submit()}
          style={{ display: "block", width: "100%", padding: "12px 0", borderRadius: 10, border: "none", background: !ready ? "#CBD5E1" : "#7C3AED", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: !ready ? "not-allowed" : "pointer" }}
        >
          {orgStatus === "loading" ? "Saving…" : "Set Tournament PIN"}
        </button>
      </div>

      <div style={{ height: 16 }} />

      {/* Coming-soon stubs. Each is a design hook so we know where these go. */}
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

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { WORKER_BASE_URL } from "@ncblast/shared";
import type { Combo } from "@ncblast/shared";
import { S } from "../styles";
import { IC } from "../components/Icons";
import { normalizeChallongeSlug } from "../utils";
import { DEFAULT_PARTS } from "../data/parts";
import { submitPreregCombos, getPreregCombos } from "../orgClient";

interface StandingRow {
  id: number;
  name: string;
  wins: number;
  losses: number;
  points: number;
}

interface StandingsFetch {
  standings: StandingRow[];
  totalComplete: number;
  totalMatches: number;
}

/**
 * Player entry. Live bracket embed + standings + top-cut calculator.
 * Combo prereg stub remains for the next phase.
 */
export function PlayerScreen() {
  const nav = useNavigate();
  const [slug, setSlug] = useState("");
  const [embedSlug, setEmbedSlug] = useState<string | null>(null);

  // Standings fetch state.
  const [standings, setStandings] = useState<null | "loading" | StandingsFetch | { error: string }>(null);

  // Top-cut calculator inputs (shown only after standings load).
  const [cutSize, setCutSize] = useState(8);
  const [remainingRounds, setRemainingRounds] = useState(2);
  const [winPoints, setWinPoints] = useState(3); // points per win (Swiss default varies)

  const showBracket = (): void => {
    const s = normalizeChallongeSlug(slug);
    if (!s) return;
    setEmbedSlug(s);
  };

  const loadStandings = async (): Promise<void> => {
    const s = normalizeChallongeSlug(slug);
    if (!s) return;
    setStandings("loading");
    try {
      const res = await fetch(`${WORKER_BASE_URL}/standings?slug=${encodeURIComponent(s)}`, {
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = Array.isArray(data?.errors) && data.errors.length ? String(data.errors[0]) : `HTTP ${res.status}`;
        setStandings({ error: msg });
        return;
      }
      setStandings(data as StandingsFetch);
    } catch (err) {
      setStandings({ error: (err as Error).message || "Network error" });
    }
  };

  // Top-cut calculator logic:
  //   For each player, compute the max possible wins they could reach if they
  //   win out: currentWins + remainingRounds. The nth-place player (n = cutSize)
  //   currently has winsAtCutline wins; anyone with fewer wins than
  //   (winsAtCutline - remainingRounds) is mathematically eliminated from cut
  //   even if they win out. Anyone strictly above that threshold can still make it.
  //   Report each player's "wins needed to guarantee cut" (win X more) as
  //   (winsAtCutline + 1) - currentWins, clamped to [0, remainingRounds+1].
  const standingsReady = standings && typeof standings === "object" && "standings" in standings;
  const rows = standingsReady ? (standings as StandingsFetch).standings : [];
  const cutline = rows.length >= cutSize ? rows[cutSize - 1] : null;
  const winsAtCutline = cutline ? cutline.wins : 0;

  const cutRow = (r: StandingRow, i: number) => {
    const maxPossibleWins = r.wins + remainingRounds;
    const mathematicallyOut = rows.length >= cutSize && maxPossibleWins < winsAtCutline;
    const winsNeededToGuarantee = Math.max(0, (winsAtCutline + 1) - r.wins);
    const canGuarantee = winsNeededToGuarantee <= remainingRounds;
    const inCutCurrent = i < cutSize;
    const pctNeeded = winsNeededToGuarantee * winPoints;
    return { maxPossibleWins, mathematicallyOut, winsNeededToGuarantee, canGuarantee, inCutCurrent, pctNeeded };
  };

  return (
    <div style={{ ...S.current.page, height: "100dvh", overflowY: "auto", paddingBottom: 80 }}>
      <button style={{ ...S.current.back, marginBottom: 8 }} onClick={() => nav("/")}>
        {IC.back} Home
      </button>
      <h1 style={{ ...S.current.title, color: "#EA580C" }}>🎯 Player</h1>
      <p style={S.current.sub}>View the bracket and check standings</p>

      {/* Slug input shared across Bracket + Standings tools. */}
      <div style={{ ...S.current.card, borderLeft: "4px solid #EA580C", padding: "14px 16px" }}>
        <h2 style={{ ...S.current.label, color: "#EA580C", fontSize: 14 }}>Tournament</h2>
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
        </div>
        {slug.trim() && (() => {
          const derived = normalizeChallongeSlug(slug);
          return derived && derived !== slug.trim() ? (
            <p style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 10, fontFamily: "'JetBrains Mono', monospace" }}>
              → slug: <strong style={{ color: "#EA580C" }}>{derived}</strong>
            </p>
          ) : null;
        })()}
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button
            type="button"
            onClick={showBracket}
            disabled={!normalizeChallongeSlug(slug)}
            style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: normalizeChallongeSlug(slug) ? "#EA580C" : "#CBD5E1", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: normalizeChallongeSlug(slug) ? "pointer" : "not-allowed" }}
          >
            Show Bracket
          </button>
          <button
            type="button"
            onClick={() => void loadStandings()}
            disabled={!normalizeChallongeSlug(slug) || standings === "loading"}
            style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: normalizeChallongeSlug(slug) && standings !== "loading" ? "#1D4ED8" : "#CBD5E1", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: normalizeChallongeSlug(slug) && standings !== "loading" ? "pointer" : "not-allowed" }}
          >
            {standings === "loading" ? "Loading…" : "Load Standings"}
          </button>
        </div>
      </div>

      {/* Bracket embed. */}
      {embedSlug && (
        <>
          <div style={{ height: 12 }} />
          <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: "#fff" }}>
            <iframe
              title={`Challonge bracket for ${embedSlug}`}
              src={`https://challonge.com/${encodeURIComponent(embedSlug)}/module`}
              style={{ width: "100%", height: 500, border: "none" }}
              allowTransparency
            />
          </div>
        </>
      )}

      {/* Standings + Top Cut. */}
      {standings && (
        <>
          <div style={{ height: 12 }} />
          <div style={{ ...S.current.card, borderLeft: "4px solid #1D4ED8", padding: "14px 16px" }}>
            <h2 style={{ ...S.current.label, color: "#1D4ED8", fontSize: 14 }}>Standings</h2>
            {standings === "loading" && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>Loading…</p>
            )}
            {typeof standings === "object" && "error" in standings && (
              <p style={{ fontSize: 12, color: "#DC2626", fontWeight: 600 }}>{standings.error}</p>
            )}
            {standingsReady && (
              <>
                <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
                  {(standings as StandingsFetch).totalComplete} of {(standings as StandingsFetch).totalMatches} matches complete
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {rows.map((r, i) => {
                    const info = cutRow(r, i);
                    const bg = info.inCutCurrent
                      ? "#F0FDF4"
                      : info.mathematicallyOut
                      ? "var(--surface2)"
                      : "var(--surface)";
                    const border = info.inCutCurrent
                      ? "#86EFAC"
                      : info.mathematicallyOut
                      ? "var(--border)"
                      : "#E2E8F0";
                    return (
                      <div
                        key={r.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px 12px",
                          borderRadius: 8,
                          background: bg,
                          border: `1px solid ${border}`,
                          opacity: info.mathematicallyOut ? 0.5 : 1,
                        }}
                      >
                        <div style={{ minWidth: 24, fontWeight: 800, color: "var(--text-muted)", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
                          #{i + 1}
                        </div>
                        <div style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.name}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" }}>
                          {r.wins}–{r.losses} · {r.points}p
                        </div>
                        {info.mathematicallyOut && (
                          <span style={{ fontSize: 9, fontWeight: 700, color: "#DC2626", textTransform: "uppercase", letterSpacing: 0.5 }}>
                            Out
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {standingsReady && (
            <>
              <div style={{ height: 12 }} />
              <div style={{ ...S.current.card, borderLeft: "4px solid #F59E0B", padding: "14px 16px" }}>
                <h2 style={{ ...S.current.label, color: "#F59E0B", fontSize: 14 }}>Top Cut Calculator</h2>
                <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
                  Adjust cut size and remaining rounds. Green rows are currently in cut; grey rows are mathematically eliminated. "Out" means even winning all remaining rounds wouldn't catch the cutline.
                </p>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <label style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase" }}>Cut Size</div>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={rows.length || 64}
                      value={cutSize}
                      onChange={e => setCutSize(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      style={{ width: "100%", padding: "8px 10px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace", outline: "none", boxSizing: "border-box" }}
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase" }}>Rounds Left</div>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={10}
                      value={remainingRounds}
                      onChange={e => setRemainingRounds(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      style={{ width: "100%", padding: "8px 10px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace", outline: "none", boxSizing: "border-box" }}
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase" }}>Pts / Win</div>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={10}
                      value={winPoints}
                      onChange={e => setWinPoints(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      style={{ width: "100%", padding: "8px 10px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace", outline: "none", boxSizing: "border-box" }}
                    />
                  </label>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                  <strong>Cutline (#{cutSize}):</strong>{" "}
                  {cutline ? (
                    <>
                      {cutline.name} at {cutline.wins}–{cutline.losses}
                    </>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>Not enough players yet</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
                  To guarantee a seat at #{cutSize} or better, a player currently below it needs at least one more win than the cutline player.
                </div>
              </div>
            </>
          )}
        </>
      )}

      <div style={{ height: 16 }} />

      {/* Combo preregistration — player types their combos once, judge pulls them. */}
      <ComboPreregCard
        slug={normalizeChallongeSlug(slug) || ""}
      />
    </div>
  );
}

// ─── Combo preregistration card ────────────────────────────────────────────

function ComboPreregCard({ slug }: { slug: string }) {
  const [playerName, setPlayerName] = useState("");
  const [combos, setCombos] = useState<Combo[]>([
    { blade: null, ratchet: null, bit: null },
    { blade: null, ratchet: null, bit: null },
    { blade: null, ratchet: null, bit: null },
  ]);
  const [status, setStatus] = useState<null | "loading" | { ok: boolean; msg: string }>(null);
  const [loadedExisting, setLoadedExisting] = useState(false);

  const setComboField = (i: number, field: keyof Combo, v: string): void => {
    setCombos(prev => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: v || null };
      return next;
    });
    setStatus(null);
  };

  // Try to load any existing prereg for this (slug, player) to show the user
  // what they previously submitted.
  const loadExisting = async (): Promise<void> => {
    if (!slug || !playerName.trim()) return;
    const result = await getPreregCombos(slug, playerName.trim());
    if (result.ok && result.combos && result.combos.length === 3) {
      setCombos(result.combos);
      setLoadedExisting(true);
      setStatus({ ok: true, msg: "Loaded your existing preregistered combos." });
    } else if (result.ok) {
      setLoadedExisting(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!slug) {
      setStatus({ ok: false, msg: "Enter a tournament slug above first." });
      return;
    }
    if (!playerName.trim()) {
      setStatus({ ok: false, msg: "Enter your player name (must match the bracket)." });
      return;
    }
    const incomplete = combos.some(c => !c.blade || !c.ratchet || !c.bit);
    if (incomplete) {
      setStatus({ ok: false, msg: "Fill in all 3 parts for each of the 3 combos." });
      return;
    }
    setStatus("loading");
    const result = await submitPreregCombos(slug, playerName.trim(), combos);
    if (result.ok) {
      setStatus({ ok: true, msg: "✓ Prereg saved. Your judge will load these when your match starts." });
    } else {
      setStatus({ ok: false, msg: result.message });
    }
  };

  const canSubmit = !!slug && playerName.trim() && combos.every(c => c.blade && c.ratchet && c.bit) && status !== "loading";

  return (
    <div style={{ ...S.current.card, borderLeft: "4px solid #A16207", padding: "14px 16px" }}>
      <h2 style={{ ...S.current.label, color: "#A16207", fontSize: 14 }}>Preregister Combos</h2>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
        Submit your 3 combos before the event. Your judge can load them instantly when your match starts instead of having you build them on their tablet.
      </p>
      {!slug && (
        <p style={{ fontSize: 11, color: "#DC2626", fontWeight: 600, marginBottom: 10 }}>
          ↑ Enter a tournament slug above first.
        </p>
      )}
      <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase" }}>Your Player Name</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          type="text"
          autoComplete="off"
          value={playerName}
          onChange={e => { setPlayerName(e.target.value); setStatus(null); setLoadedExisting(false); }}
          placeholder="Must match the Challonge bracket name"
          style={{ flex: 1, padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", outline: "none" }}
        />
        <button
          type="button"
          onClick={() => void loadExisting()}
          disabled={!playerName.trim() || !slug}
          style={{ padding: "0 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", fontSize: 11, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: playerName.trim() && slug ? "pointer" : "not-allowed" }}
          title="Load existing prereg if you've submitted before"
        >
          Load
        </button>
      </div>
      {/* 3 combos × 3 fields with datalists for autocomplete. */}
      <datalist id="prereg-blades">
        {DEFAULT_PARTS.blades.map(b => <option key={b} value={b} />)}
      </datalist>
      <datalist id="prereg-ratchets">
        {DEFAULT_PARTS.ratchets.map(r => <option key={r} value={r} />)}
      </datalist>
      <datalist id="prereg-bits">
        {DEFAULT_PARTS.bits.map(b => <option key={b} value={b} />)}
      </datalist>
      {combos.map((c, i) => (
        <div key={i} style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface2)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Combo {i + 1}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <input list="prereg-blades" placeholder="Blade" value={c.blade || ""} onChange={e => setComboField(i, "blade", e.target.value)} style={{ padding: "8px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", outline: "none" }} />
            <input list="prereg-ratchets" placeholder="Ratchet (e.g. 1-60)" value={c.ratchet || ""} onChange={e => setComboField(i, "ratchet", e.target.value)} style={{ padding: "8px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", outline: "none" }} />
            <input list="prereg-bits" placeholder="Bit" value={c.bit || ""} onChange={e => setComboField(i, "bit", e.target.value)} style={{ padding: "8px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", outline: "none" }} />
          </div>
        </div>
      ))}
      {status && status !== "loading" && (
        <p style={{ fontSize: 12, fontWeight: 600, textAlign: "center", marginBottom: 10, color: status.ok ? "#15803D" : "#DC2626" }}>
          {status.msg}
        </p>
      )}
      {loadedExisting && (
        <p style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginBottom: 6, fontStyle: "italic" }}>
          Editing your existing prereg — submitting will overwrite it.
        </p>
      )}
      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void submit()}
        style={{ display: "block", width: "100%", padding: "12px 0", borderRadius: 10, border: "none", background: canSubmit ? "#A16207" : "#CBD5E1", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: canSubmit ? "pointer" : "not-allowed" }}
      >
        {status === "loading" ? "Saving…" : "Submit Prereg"}
      </button>
    </div>
  );
}

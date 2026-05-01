import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { WORKER_BASE_URL } from "@ncblast/shared";
import { S } from "../styles";
import { IC } from "../components/Icons";
import { setPin, getCachedMasterKey, clearCachedMasterKey, verifyMasterKey } from "../pin";
import { normalizeChallongeSlug } from "../utils";
import { createTournament, setApprovalMode, listPendingApprovals, decideApproval, type PendingSubmission } from "../orgClient";

/**
 * Organizer entry. Master-key login gate at top; once validated the key is
 * cached in sessionStorage so subsequent actions (PIN set, future features)
 * don't require re-entry. PIN management is the only fully functional feature
 * today — the rest are scaffolded placeholders.
 */
export function OrganizerScreen() {
  const nav = useNavigate();

  // Login state — cached key makes the gate a no-op on return visits this session.
  const [cachedKey, setCachedKey] = useState<string | null>(getCachedMasterKey());
  const [loginInput, setLoginInput] = useState("");
  const [loginStatus, setLoginStatus] = useState<null | "loading" | string>(null);

  const login = async (): Promise<void> => {
    setLoginStatus("loading");
    const result = await verifyMasterKey(loginInput.trim());
    if (result.ok) {
      setCachedKey(loginInput.trim());
      setLoginInput("");
      setLoginStatus(null);
    } else {
      setLoginStatus(result.message);
    }
  };

  const logout = (): void => {
    clearCachedMasterKey();
    setCachedKey(null);
  };

  // PIN management state.
  const [orgSlug, setOrgSlug] = useState("");
  const [orgPin, setOrgPin] = useState("");
  const [orgStatus, setOrgStatus] = useState<null | "loading" | { ok: boolean; msg: string }>(null);

  const submit = async (): Promise<void> => {
    if (!cachedKey) return;
    setOrgStatus("loading");
    const slug = normalizeChallongeSlug(orgSlug);
    if (!slug) {
      setOrgStatus({ ok: false, msg: "Couldn't read a tournament slug from that URL." });
      return;
    }
    const result = await setPin(cachedKey, slug, orgPin.trim());
    if (result.ok) {
      setOrgStatus({ ok: true, msg: `✓ PIN set for "${slug}"` });
      setOrgPin("");
    } else {
      // If the cached key was rejected (rotated, etc.), fall back to login.
      if (result.message.toLowerCase().includes("master key")) {
        clearCachedMasterKey();
        setCachedKey(null);
      }
      setOrgStatus({ ok: false, msg: result.message });
    }
  };

  const stubs: Array<{ title: string; body: string; emoji: string }> = [
    { emoji: "📋", title: "Call Next Matches", body: "See open matches, assign to a judge, notify them on their tablet." },
    { emoji: "🛠️", title: "Manual Override", body: "Edit bracket standings or correct a submitted score before it's final." },
  ];

  const pinReady = !!cachedKey && normalizeChallongeSlug(orgSlug) && orgPin.length >= 4 && orgStatus !== "loading";

  return (
    <div style={{ ...S.current.page, height: "100dvh", overflowY: "auto", paddingBottom: 80 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <button style={{ ...S.current.back, marginBottom: 0 }} onClick={() => nav("/")}>
          {IC.back} Home
        </button>
        {cachedKey && (
          <button
            type="button"
            onClick={logout}
            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "underline", fontFamily: "'Outfit', sans-serif" }}
          >
            Log out
          </button>
        )}
      </div>
      <h1 style={{ ...S.current.title, color: "#7C3AED" }}>🎛️ Organizer</h1>
      <p style={S.current.sub}>Tournament management for event runners</p>

      {/* Login gate — shown until the master key is validated this session. */}
      {!cachedKey && (
        <div style={{ ...S.current.card, borderLeft: "4px solid #7C3AED", padding: "14px 16px" }}>
          <h2 style={{ ...S.current.label, color: "#7C3AED", fontSize: 14 }}>Organizer Login</h2>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
            Enter the master key once per session. It's cached until you close this tab.
          </p>
          <input
            type="password"
            autoComplete="off"
            value={loginInput}
            onChange={e => { setLoginInput(e.target.value); setLoginStatus(null); }}
            onKeyDown={e => { if (e.key === "Enter" && loginInput.trim() && loginStatus !== "loading") void login(); }}
            placeholder="Master key"
            autoFocus
            style={{ width: "100%", padding: "12px 12px", fontSize: 14, borderRadius: 8, border: `2px solid ${loginStatus && loginStatus !== "loading" ? "#DC2626" : "var(--border)"}`, background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", marginBottom: 10, outline: "none", boxSizing: "border-box" }}
          />
          {loginStatus && loginStatus !== "loading" && (
            <p style={{ fontSize: 12, color: "#DC2626", fontWeight: 600, marginBottom: 10, textAlign: "center" }}>{loginStatus}</p>
          )}
          <button
            type="button"
            disabled={!loginInput.trim() || loginStatus === "loading"}
            onClick={() => void login()}
            style={{ display: "block", width: "100%", padding: "12px 0", borderRadius: 10, border: "none", background: (!loginInput.trim() || loginStatus === "loading") ? "#CBD5E1" : "#7C3AED", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: (!loginInput.trim() || loginStatus === "loading") ? "not-allowed" : "pointer" }}
          >
            {loginStatus === "loading" ? "Checking…" : "Unlock Organizer Tools"}
          </button>
        </div>
      )}

      {/* PIN management — gated behind login. */}
      {cachedKey && (
        <>
          <div style={{ ...S.current.card, borderLeft: "4px solid #7C3AED", padding: "14px 16px" }}>
            <h2 style={{ ...S.current.label, color: "#7C3AED", fontSize: 14 }}>Set Tournament PIN</h2>
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
              Required before judges can submit match results for a Challonge tournament.
            </p>
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
              disabled={!pinReady}
              onClick={() => void submit()}
              style={{ display: "block", width: "100%", padding: "12px 0", borderRadius: 10, border: "none", background: !pinReady ? "#CBD5E1" : "#7C3AED", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: !pinReady ? "not-allowed" : "pointer" }}
            >
              {orgStatus === "loading" ? "Saving…" : "Set Tournament PIN"}
            </button>
          </div>

          <div style={{ height: 12 }} />

          {/* Tournament creation — create a new Challonge tournament through the Worker. */}
          <CreateTournamentCard masterKey={cachedKey} />

          <div style={{ height: 12 }} />

          {/* Approval queue — gate match submissions behind organizer review. */}
          <ApprovalQueueCard masterKey={cachedKey} />

          <div style={{ height: 12 }} />

          {/* Stream overlay controls — surface slot picker from organizer's vantage. */}
          <StreamOverlayControls />
        </>
      )}

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

// ─── Stream overlay controls (organizer view) ───────────────────────────────

interface SlotState {
  slot: number;
  state: Record<string, unknown> | null;
  etag: string | null;
}

function StreamOverlayControls() {
  const [slots, setSlots] = useState<SlotState[]>([
    { slot: 1, state: null, etag: null },
    { slot: 2, state: null, etag: null },
    { slot: 3, state: null, etag: null },
    { slot: 4, state: null, etag: null },
  ]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll each slot's current state every 5s. Not a long-poll — we just want
  // periodic refresh for the organizer dashboard.
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const next: SlotState[] = [];
      for (const s of slots) {
        try {
          const res = await fetch(`${WORKER_BASE_URL}/overlay/state?slot=${s.slot}`, {
            signal: AbortSignal.timeout(4000),
          });
          if (res.ok) {
            const data = await res.json() as { state?: Record<string, unknown> | null; etag?: string | null };
            next.push({ slot: s.slot, state: data.state ?? null, etag: data.etag ?? null });
          } else {
            next.push({ ...s, state: null, etag: null });
          }
        } catch {
          next.push({ ...s, state: null, etag: null });
        }
      }
      if (!cancelled) setSlots(next);
    };
    void refresh();
    tickRef.current = setInterval(() => { void refresh(); }, 5000);
    return () => {
      cancelled = true;
      if (tickRef.current !== null) clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overlayUrl = (slot: number): string => {
    // Derive the overlay URL by swapping the judge hostname for the overlay one
    // when deployed to Cloudflare Pages siblings. Falls back to a path hint.
    const host = typeof window !== "undefined" ? window.location.host : "";
    if (host.includes("ncblast-judge")) {
      return `https://${host.replace("ncblast-judge", "ncblast-overlay")}/?slot=${slot}`;
    }
    return `/overlay?slot=${slot}`;
  };

  return (
    <div style={{ ...S.current.card, borderLeft: "4px solid #1D4ED8", padding: "14px 16px" }}>
      <h2 style={{ ...S.current.label, color: "#1D4ED8", fontSize: 14 }}>Stream Overlay Slots</h2>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
        Live view of what each overlay slot is broadcasting. Judges push to a slot from the battle screen's 📡 menu.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {slots.map(s => {
          const state = s.state;
          const p1 = state && typeof state.p1 === "string" ? state.p1 : null;
          const p2 = state && typeof state.p2 === "string" ? state.p2 : null;
          const pts = state && Array.isArray(state.pts) ? state.pts as [number, number] : null;
          const sets = state && Array.isArray(state.sets) ? state.sets as [number, number] : null;
          const judge = state && typeof state.judge === "string" ? state.judge : null;
          const tournamentName = state && typeof state.tournamentName === "string" ? state.tournamentName : null;
          const hasState = !!p1 && !!p2;

          return (
            <div
              key={s.slot}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 10,
                border: `2px solid ${hasState ? "#1D4ED840" : "var(--border)"}`,
                background: hasState ? "#1D4ED80D" : "var(--surface2)",
              }}
            >
              <div style={{ minWidth: 36, textAlign: "center", fontSize: 14, fontWeight: 800, color: hasState ? "#1D4ED8" : "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                T{s.slot}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {hasState ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p1} <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>vs</span> {p2}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      {pts ? `pts ${pts[0]}–${pts[1]}` : ""}
                      {sets ? ` · sets ${sets[0]}–${sets[1]}` : ""}
                      {judge ? ` · ⚖️ ${judge}` : ""}
                      {tournamentName ? ` · ${tournamentName}` : ""}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text-faint)", fontStyle: "italic" }}>
                    No match pushed
                  </div>
                )}
              </div>
              <a
                href={overlayUrl(s.slot)}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 11, fontWeight: 700, padding: "6px 10px", borderRadius: 6, background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)", textDecoration: "none", fontFamily: "'Outfit', sans-serif", flexShrink: 0 }}
              >
                Open
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Create Tournament card ─────────────────────────────────────────────────

function CreateTournamentCard({ masterKey }: { masterKey: string }) {
  const [name, setName] = useState("");
  const [urlSlug, setUrlSlug] = useState("");
  const [defaultPin, setDefaultPin] = useState("");
  const [approvalMode, setApprovalModeLocal] = useState(false);
  const [tType, setTType] = useState<"swiss" | "single_elimination" | "double_elimination" | "round_robin">("swiss");
  const [status, setStatus] = useState<null | "loading" | { ok: boolean; msg: string; url?: string }>(null);

  // Auto-derive a URL slug from name (lowercase, non-alphanumeric → dashes).
  const deriveSlug = (n: string): string =>
    n.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

  const ready = name.trim() && urlSlug.trim() && /^[a-zA-Z0-9_-]{3,60}$/.test(urlSlug.trim()) && status !== "loading";

  const submit = async (): Promise<void> => {
    setStatus("loading");
    const result = await createTournament({
      masterKey,
      name: name.trim(),
      urlSlug: urlSlug.trim(),
      tournamentType: tType,
      pin: defaultPin.trim() || undefined,
      approvalMode,
    });
    if (result.ok) {
      setStatus({ ok: true, msg: `✓ Created "${result.slug}"`, url: result.url });
      setName(""); setUrlSlug(""); setDefaultPin(""); setApprovalModeLocal(false);
    } else {
      setStatus({ ok: false, msg: result.message });
    }
  };

  return (
    <div style={{ ...S.current.card, borderLeft: "4px solid #15803D", padding: "14px 16px" }}>
      <h2 style={{ ...S.current.label, color: "#15803D", fontSize: 14 }}>Create Tournament</h2>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
        Creates a Challonge bracket under the shared NC BLAST account. Judges can import it immediately.
      </p>
      <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase" }}>Tournament Name</label>
      <input
        type="text"
        autoComplete="off"
        value={name}
        onChange={e => { setName(e.target.value); if (!urlSlug) setUrlSlug(deriveSlug(e.target.value)); setStatus(null); }}
        placeholder="NC BLAST April Open"
        style={{ width: "100%", padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", marginBottom: 8, outline: "none", boxSizing: "border-box" }}
      />
      <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase" }}>URL Slug</label>
      <input
        type="text"
        autoComplete="off"
        value={urlSlug}
        onChange={e => { setUrlSlug(e.target.value); setStatus(null); }}
        placeholder="ncblast-april-open"
        style={{ width: "100%", padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 8, outline: "none", boxSizing: "border-box" }}
      />
      <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase" }}>Format</label>
      <select
        value={tType}
        onChange={e => setTType(e.target.value as typeof tType)}
        style={{ width: "100%", padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", marginBottom: 8, outline: "none", boxSizing: "border-box" }}
      >
        <option value="swiss">Swiss</option>
        <option value="single_elimination">Single Elimination</option>
        <option value="double_elimination">Double Elimination</option>
        <option value="round_robin">Round Robin</option>
      </select>
      <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase" }}>Default PIN (optional)</label>
      <input
        type="tel"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={8}
        value={defaultPin}
        onChange={e => { setDefaultPin(e.target.value.replace(/[^0-9]/g, "")); setStatus(null); }}
        placeholder="4-8 digits"
        style={{ width: "100%", padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 8, outline: "none", boxSizing: "border-box" }}
      />
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)", marginBottom: 10, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={approvalMode}
          onChange={e => setApprovalModeLocal(e.target.checked)}
          style={{ margin: 0, cursor: "pointer" }}
        />
        Require organizer approval before scores hit Challonge
      </label>
      {status && status !== "loading" && (
        <div style={{ marginBottom: 10 }}>
          <p style={{ fontSize: 12, fontWeight: 600, textAlign: "center", color: status.ok ? "#15803D" : "#DC2626", margin: 0 }}>
            {status.msg}
          </p>
          {status.ok && status.url && (
            <p style={{ textAlign: "center", marginTop: 4 }}>
              <a href={status.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#1D4ED8", textDecoration: "underline" }}>
                Open on Challonge →
              </a>
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        disabled={!ready}
        onClick={() => void submit()}
        style={{ display: "block", width: "100%", padding: "12px 0", borderRadius: 10, border: "none", background: ready ? "#15803D" : "#CBD5E1", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: ready ? "pointer" : "not-allowed" }}
      >
        {status === "loading" ? "Creating…" : "Create Tournament"}
      </button>
    </div>
  );
}

// ─── Approval queue card ────────────────────────────────────────────────────

function ApprovalQueueCard({ masterKey }: { masterKey: string }) {
  const [queueSlugInput, setQueueSlugInput] = useState("");
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSubmission[] | "loading" | { error: string } | null>(null);
  const [approvalOn, setApprovalOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (slug: string): Promise<void> => {
    setActiveSlug(slug);
    setPending("loading");
    setApprovalOn(null);
    const result = await listPendingApprovals(masterKey, slug);
    if (result.ok) setPending(result.pending);
    else setPending({ error: result.message });
    // Also query status so we can show whether approval mode is on.
    try {
      const statusRes = await fetch(`${WORKER_BASE_URL}/approval/status?slug=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(5000) });
      if (statusRes.ok) {
        const data = await statusRes.json() as { enabled?: boolean };
        setApprovalOn(!!data.enabled);
      }
    } catch { /* ignore */ }
  };

  const toggleApproval = async (nextEnabled: boolean): Promise<void> => {
    if (!activeSlug) return;
    setBusy(true);
    const result = await setApprovalMode(masterKey, activeSlug, nextEnabled);
    setBusy(false);
    if (result.ok) setApprovalOn(nextEnabled);
  };

  const decide = async (id: string, decision: "approve" | "reject"): Promise<void> => {
    if (!activeSlug) return;
    setBusy(true);
    const result = await decideApproval(masterKey, activeSlug, id, decision);
    setBusy(false);
    if (result.ok) {
      // Refresh list.
      await load(activeSlug);
    } else {
      alert(`Failed: ${result.message}`);
    }
  };

  return (
    <div style={{ ...S.current.card, borderLeft: "4px solid #F59E0B", padding: "14px 16px" }}>
      <h2 style={{ ...S.current.label, color: "#F59E0B", fontSize: 14 }}>Approval Queue</h2>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
        When approval mode is on, judge submissions wait here until you approve or reject each one.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          type="text"
          autoComplete="off"
          value={queueSlugInput}
          onChange={e => setQueueSlugInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && queueSlugInput.trim()) void load(queueSlugInput.trim()); }}
          placeholder="Tournament slug"
          style={{ flex: 1, padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace", outline: "none" }}
        />
        <button
          type="button"
          onClick={() => queueSlugInput.trim() && void load(queueSlugInput.trim())}
          disabled={!queueSlugInput.trim() || pending === "loading"}
          style={{ padding: "0 14px", borderRadius: 8, border: "none", background: queueSlugInput.trim() ? "#F59E0B" : "#CBD5E1", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: queueSlugInput.trim() ? "pointer" : "not-allowed" }}
        >
          Load
        </button>
      </div>
      {activeSlug && approvalOn !== null && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: 8, background: approvalOn ? "#FEF3C7" : "var(--surface2)", border: `1px solid ${approvalOn ? "#FDE68A" : "var(--border)"}`, marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: approvalOn ? "#92400E" : "var(--text-muted)" }}>
            Approval mode: {approvalOn ? "ON" : "OFF"}
          </span>
          <button
            type="button"
            onClick={() => void toggleApproval(!approvalOn)}
            disabled={busy}
            style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", cursor: busy ? "wait" : "pointer", fontFamily: "'Outfit', sans-serif" }}
          >
            Turn {approvalOn ? "off" : "on"}
          </button>
        </div>
      )}
      {pending === "loading" && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>Loading…</p>
      )}
      {pending && typeof pending === "object" && "error" in pending && (
        <p style={{ fontSize: 12, color: "#DC2626", fontWeight: 600 }}>{pending.error}</p>
      )}
      {Array.isArray(pending) && pending.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", textAlign: "center", padding: "12px 0" }}>
          No pending submissions.
        </p>
      )}
      {Array.isArray(pending) && pending.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pending.map(p => {
            const dt = new Date(p.submittedAt).toLocaleTimeString();
            return (
              <div key={p.id} style={{ padding: "10px 12px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>
                  Match #{p.matchId} · {p.scoresCsv}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 6 }}>
                  Submitted {dt}{p.ip ? ` · ${p.ip}` : ""}{p.winnerId !== null ? ` · winner ID ${p.winnerId}` : ""}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => void decide(p.id, "approve")}
                    disabled={busy}
                    style={{ flex: 1, padding: "8px 0", borderRadius: 6, border: "none", background: "#15803D", color: "#fff", fontSize: 12, fontWeight: 700, cursor: busy ? "wait" : "pointer", fontFamily: "'Outfit', sans-serif" }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide(p.id, "reject")}
                    disabled={busy}
                    style={{ flex: 1, padding: "8px 0", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "#DC2626", fontSize: 12, fontWeight: 700, cursor: busy ? "wait" : "pointer", fontFamily: "'Outfit', sans-serif" }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

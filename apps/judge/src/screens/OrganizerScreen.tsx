import { useEffect, useRef, useState } from "react";
import type React from "react";
import { useNavigate } from "react-router-dom";
import { WORKER_BASE_URL } from "@ncblast/shared";
import { S } from "../styles";
import { IC } from "../components/Icons";
import { setPin } from "../pin";
import { normalizeChallongeSlug } from "../utils";
import { useChallongeAuthPopup } from "../hooks/useChallongeAuthPopup";
import { createTournament, setApprovalMode, listPendingApprovals, decideApproval, listScoreLog, getOrgMeta, setHeadJudges as apiSetHeadJudges, claimOwnership, setLoginMode, getJudgeWhitelist, setJudgeWhitelist, getOverlayAll, pollPings, dismissPing as apiDismissPing, getJudgeNameMap, setJudgeNameMap, getPairings, getStadiumAssign, setStadiumAssign as apiSetStadiumAssign, verifyOrgSession, getAuthUsername, clearAuthSession, listCachedTournaments, deleteTournamentFromCache, type PendingSubmission, type ScoreLogEntry, type OrgMeta, type OverlaySlotSnapshot, type Ping, type JudgeNameMap, type StadiumAssign, type PairingMatch, type TournamentListEntry } from "../orgClient";

/**
 * Organizer entry. OAuth login via Challonge — opens a popup, on success
 * stores an opaque ncblast-auth-token in sessionStorage. Every privileged
 * call sends that token as X-Auth-Token. The token is checked once on mount
 * (via /org/verify) so a stale tab can detect an expired session before
 * the first user action surfaces a 401.
 *
 * Master-key login is intentionally not exposed here — the Worker still
 * accepts it as a break-glass header, but the UI is OAuth-only.
 */
export function OrganizerScreen() {
  const nav = useNavigate();

  // Auth lifecycle:
  //   "checking"   — verifying stored session token on mount
  //   "login"      — show OAuth login UI
  //   "confirming" — popup completed, awaiting /org/verify
  //   "verified"   — fully authed, render the rest of the dashboard
  type AuthStep = "checking" | "login" | "confirming" | "verified";
  const [authStep, setAuthStep] = useState<AuthStep>("checking");
  const [orgUsername, setOrgUsername] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const auth = useChallongeAuthPopup();

  // On mount: try to restore an existing session by calling /org/verify.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = getAuthUsername();
      if (!stored) {
        if (!cancelled) setAuthStep("login");
        return;
      }
      const result = await verifyOrgSession();
      if (cancelled) return;
      if (result.ok) {
        setOrgUsername(result.username);
        setAuthStep("verified");
      } else {
        setAuthStep("login");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // When the OAuth popup hook reports "done", call /org/verify to confirm
  // the just-logged-in user is admitted. This is also where org-whitelist
  // gating would kick in (Worker currently admits any valid Challonge user).
  useEffect(() => {
    if (auth.state !== "done" || !auth.username) return;
    setAuthStep("confirming");
    setAuthError(null);
    void (async () => {
      const result = await verifyOrgSession();
      if (result.ok) {
        setOrgUsername(result.username);
        setAuthStep("verified");
      } else {
        setAuthError(result.message || "You're not authorized to use the organizer view.");
        setAuthStep("login");
        clearAuthSession();
        auth.reset();
      }
    })();
  }, [auth.state, auth.username]);

  const logout = (): void => {
    clearAuthSession();
    auth.reset();
    setOrgUsername(null);
    setAuthStep("login");
  };

  // PIN management state — only used in the verified branch.
  const [orgSlug, setOrgSlug] = useState("");
  const [orgPin, setOrgPin] = useState("");
  const [orgStatus, setOrgStatus] = useState<null | "loading" | { ok: boolean; msg: string }>(null);

  const submit = async (): Promise<void> => {
    if (!orgUsername) return;
    setOrgStatus("loading");
    const slug = normalizeChallongeSlug(orgSlug);
    if (!slug) {
      setOrgStatus({ ok: false, msg: "Couldn't read a tournament slug from that URL." });
      return;
    }
    // First arg (legacy masterKey) is ignored — auth comes from X-Auth-Token.
    const result = await setPin("", slug, orgPin.trim());
    if (result.ok) {
      setOrgStatus({ ok: true, msg: `✓ PIN set for "${slug}"` });
      setOrgPin("");
    } else {
      setOrgStatus({ ok: false, msg: result.message });
      // If the token expired mid-session, surface that as a login prompt.
      if (result.message.toLowerCase().includes("token")) {
        clearAuthSession();
        setOrgUsername(null);
        setAuthStep("login");
      }
    }
  };

  const pinReady = !!orgUsername && normalizeChallongeSlug(orgSlug) && orgPin.length >= 4 && orgStatus !== "loading";

  return (
    <div style={{ ...S.current.page, height: "100dvh", overflowY: "auto", paddingBottom: 80 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <button style={{ ...S.current.back, marginBottom: 0 }} onClick={() => nav("/")}>
          {IC.back} Home
        </button>
        {orgUsername && (
          <button
            type="button"
            onClick={logout}
            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "underline", fontFamily: "'Outfit', sans-serif" }}
          >
            Log out ({orgUsername})
          </button>
        )}
      </div>
      <h1 style={{ ...S.current.title, color: "#7C3AED" }}>🎛️ Organizer</h1>
      <p style={S.current.sub}>Tournament management for event runners</p>

      {/* Checking saved session ── shown briefly on mount before deciding
          whether to show login or the dashboard. */}
      {authStep === "checking" && (
        <div style={{ ...S.current.card, borderLeft: "4px solid #7C3AED", padding: "20px 16px", textAlign: "center" }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Checking session…</p>
        </div>
      )}

      {/* OAuth login gate. */}
      {authStep === "login" && (
        <div style={{ ...S.current.card, borderLeft: "4px solid #7C3AED", padding: "14px 16px" }}>
          <h2 style={{ ...S.current.label, color: "#7C3AED", fontSize: 14 }}>Organizer Login</h2>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
            Sign in with your Challonge account. NC BLAST will open a popup to Challonge for authorization.
          </p>
          {authError && (
            <p style={{ fontSize: 12, color: "#DC2626", fontWeight: 600, marginBottom: 10, textAlign: "center" }}>{authError}</p>
          )}
          {auth.errorMsg && (
            <p style={{ fontSize: 12, color: "#DC2626", fontWeight: 600, marginBottom: 10, textAlign: "center" }}>{auth.errorMsg}</p>
          )}
          <button
            type="button"
            onClick={() => void auth.start()}
            disabled={auth.state === "waiting"}
            style={{ display: "block", width: "100%", padding: "12px 0", borderRadius: 10, border: "none", background: auth.state === "waiting" ? "#CBD5E1" : "#7C3AED", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: auth.state === "waiting" ? "wait" : "pointer" }}
          >
            {auth.state === "waiting" ? "Opening Challonge…" : "Sign in with Challonge"}
          </button>
        </div>
      )}

      {/* Brief "confirming…" between popup-close and /org/verify success. */}
      {authStep === "confirming" && (
        <div style={{ ...S.current.card, borderLeft: "4px solid #7C3AED", padding: "20px 16px", textAlign: "center" }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Verifying with NC BLAST…</p>
        </div>
      )}

      {/* PIN management — gated behind verified OAuth session. */}
      {authStep === "verified" && orgUsername && (
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
          <CreateTournamentCard masterKey={orgUsername} />

          <div style={{ height: 12 }} />

          {/* Approval queue — gate match submissions behind organizer review. */}
          <ApprovalQueueCard masterKey={orgUsername} />

          <div style={{ height: 12 }} />

          {/* Stream overlay controls — surface slot picker from organizer's vantage. */}
          <StreamOverlayControls />

          <div style={{ height: 12 }} />

          {/* Tournament select — list cached tournaments + claim by slug.
              F3 in the OrgApp port plan. */}
          <TournamentSelectCard />

          <div style={{ height: 12 }} />

          {/* Live slots mirror + ping notifications. Polls /overlay/all every
              5s for the 4-slot snapshot and long-polls /pings/poll every 2s
              for judge attention requests. Active ping modal floats on top. */}
          <LiveDashboardCard />

          <div style={{ height: 12 }} />

          {/* Per-tournament org meta: head judges, owner, login mode. Single
              KV doc on the Worker. Cards below all consume the same useState. */}
          <OrgMetaSection masterKey={orgUsername || ""} />

          <div style={{ height: 12 }} />

          {/* Score log — judge-accountability audit of finalized matches. */}
          <ScoreLogCard />
        </>
      )}

      <div style={{ height: 32 }} />
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

// ─── Score Log card ─────────────────────────────────────────────────────────
// Read-only audit view of finalized matches with judge attribution. Per-slug.
function ScoreLogCard() {
  const [slug, setSlug] = useState("");
  const [entries, setEntries] = useState<ScoreLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    if (!slug.trim()) {
      setErr("Enter a tournament slug.");
      return;
    }
    setLoading(true);
    setErr(null);
    const result = await listScoreLog(slug.trim());
    setLoading(false);
    if (!result.ok) {
      setErr(result.message);
      setEntries([]);
      return;
    }
    setEntries(result.entries);
    if (!result.entries.length) setErr("No entries yet for this slug.");
  };

  return (
    <div style={{ ...S.current.card, borderLeft: "4px solid #0EA5E9", padding: "14px 16px" }}>
      <h2 style={{ ...S.current.label, color: "#0EA5E9", fontSize: 14 }}>Score Log</h2>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
        Audit trail of finalized matches across this tournament — newest first. Pulled from the Worker after each Challonge submit.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          type="text"
          autoComplete="off"
          value={slug}
          onChange={(e) => { setSlug(e.target.value); setErr(null); }}
          placeholder="Tournament slug"
          style={{ flex: 1, padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", outline: "none" }}
        />
        <button
          type="button"
          onClick={() => void load()}
          disabled={!slug.trim() || loading}
          style={{ padding: "0 16px", borderRadius: 8, border: "none", background: slug.trim() && !loading ? "#0EA5E9" : "#CBD5E1", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: slug.trim() && !loading ? "pointer" : "not-allowed" }}
        >
          {loading ? "…" : "Load"}
        </button>
      </div>
      {err && <p style={{ fontSize: 11, color: "#DC2626", textAlign: "center", marginBottom: 8, fontWeight: 600 }}>{err}</p>}
      {entries.length > 0 && (
        <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
          {entries.map((e) => (
            <div key={e.id} style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
                  {e.p1} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{e.p1Sets}–{e.p2Sets}</span> {e.p2}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  {new Date(e.scoredAt).toLocaleTimeString()}
                </span>
              </div>
              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                Winner: <strong style={{ color: "#15803D" }}>{e.winner || "—"}</strong>
                {e.judge && <span> · Judge: {e.judge}</span>}
                {e.challongeMatchId && <span> · #{e.challongeMatchId}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Org Meta Section (head judges + login mode + judge whitelist) ─────────
// All three cards share a single (slug, meta) state since they all hit the
// same `org:meta:<slug>` KV doc on the Worker. Single Load action loads all,
// then each card edits and saves independently.
function OrgMetaSection({ masterKey }: { masterKey: string }) {
  const [slug, setSlug] = useState("");
  const [meta, setMeta] = useState<OrgMeta | null>(null);
  const [whitelist, setWhitelist] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    if (!slug.trim()) { setErr("Enter a tournament slug."); return; }
    setLoading(true); setErr(null);
    // Load org meta and whitelist in parallel.
    const [metaRes, wlRes] = await Promise.all([
      getOrgMeta(slug.trim()),
      getJudgeWhitelist(slug.trim()),
    ]);
    setLoading(false);
    if (!metaRes.ok) { setErr(metaRes.message); return; }
    if (!wlRes.ok) { setErr(wlRes.message); return; }
    setMeta(metaRes.meta);
    setWhitelist(wlRes.usernames);
  };

  return (
    <div style={{ ...S.current.card, borderLeft: "4px solid #7C3AED", padding: "14px 16px" }}>
      <h2 style={{ ...S.current.label, color: "#7C3AED", fontSize: 14 }}>Tournament Settings</h2>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
        Head judges, login mode (solo/duo), and the judge whitelist for a specific tournament. All gated by the master key for now — OAuth will land later.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="text"
          autoComplete="off"
          value={slug}
          onChange={(e) => { setSlug(e.target.value); setErr(null); }}
          placeholder="Tournament slug"
          style={{ flex: 1, padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", outline: "none" }}
        />
        <button
          type="button"
          onClick={() => void load()}
          disabled={!slug.trim() || loading}
          style={{ padding: "0 16px", borderRadius: 8, border: "none", background: slug.trim() && !loading ? "#7C3AED" : "#CBD5E1", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: slug.trim() && !loading ? "pointer" : "not-allowed" }}
        >
          {loading ? "…" : "Load"}
        </button>
      </div>
      {err && <p style={{ fontSize: 11, color: "#DC2626", textAlign: "center", marginBottom: 8, fontWeight: 600 }}>{err}</p>}

      {meta && whitelist !== null && (
        <>
          <HeadJudgesCard
            masterKey={masterKey}
            slug={slug.trim()}
            meta={meta}
            onUpdate={setMeta}
          />
          <div style={{ height: 10 }} />
          <LoginModeCard
            masterKey={masterKey}
            slug={slug.trim()}
            meta={meta}
            onUpdate={setMeta}
          />
          <div style={{ height: 10 }} />
          <JudgeWhitelistCard
            masterKey={masterKey}
            slug={slug.trim()}
            usernames={whitelist}
            onUpdate={setWhitelist}
          />
          <div style={{ height: 10 }} />
          {/* Stadium assignment — pick 1-8 stadiums, drag judges into buckets.
              Depends on the same whitelist + slug as the cards above. */}
          <StadiumAssignCard
            masterKey={masterKey}
            slug={slug.trim()}
            judgeWhitelist={whitelist}
          />
          <div style={{ height: 10 }} />
          {/* Match Call Helper — station queues. The largest card; combines
              pairings + judge whitelist + name map + stadium assign + live
              slot data into a per-stadium ordered queue with coverage warnings,
              drag-to-reorder, and lock pins. */}
          <StationQueuesCard
            slug={slug.trim()}
            judgeWhitelist={whitelist}
          />
        </>
      )}
    </div>
  );
}

// ─── Head Judges + Owner Claim card (F5) ────────────────────────────────────
function HeadJudgesCard({ masterKey, slug, meta, onUpdate }: {
  masterKey: string;
  slug: string;
  meta: OrgMeta;
  onUpdate: (m: OrgMeta) => void;
}) {
  const [claimUsername, setClaimUsername] = useState("");
  const [newJudge, setNewJudge] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleClaim = async (): Promise<void> => {
    if (!claimUsername.trim()) { setErr("Enter a Challonge username to claim."); return; }
    setSaving(true); setErr(null);
    const result = await claimOwnership(masterKey, slug, claimUsername.trim().toLowerCase());
    setSaving(false);
    if (!result.ok) { setErr(result.message); return; }
    onUpdate({ ...meta, orgUsername: result.orgUsername });
    setClaimUsername("");
  };

  const handleAddJudge = async (): Promise<void> => {
    const u = newJudge.trim().toLowerCase();
    if (!u) return;
    if (meta.headJudges.includes(u)) { setErr("Already a head judge."); return; }
    setSaving(true); setErr(null);
    const next = [...meta.headJudges, u];
    const result = await apiSetHeadJudges(masterKey, slug, next);
    setSaving(false);
    if (!result.ok) { setErr(result.message); return; }
    onUpdate({ ...meta, headJudges: result.headJudges });
    setNewJudge("");
  };

  const handleRemoveJudge = async (u: string): Promise<void> => {
    setSaving(true); setErr(null);
    const next = meta.headJudges.filter((x) => x !== u);
    const result = await apiSetHeadJudges(masterKey, slug, next);
    setSaving(false);
    if (!result.ok) { setErr(result.message); return; }
    onUpdate({ ...meta, headJudges: result.headJudges });
  };

  return (
    <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
      <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>Head Judges</p>

      {/* Owner banner */}
      {meta.orgUsername ? (
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
          Owner: <strong style={{ color: "#7C3AED" }}>{meta.orgUsername}</strong>
        </p>
      ) : (
        <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 8, background: "#FEF3C7", border: "1px solid #F59E0B" }}>
          <p style={{ fontSize: 11, color: "#92400E", fontWeight: 700, marginBottom: 6 }}>⚠ No owner set</p>
          <p style={{ fontSize: 11, color: "#92400E", marginBottom: 8, lineHeight: 1.4 }}>
            Claim ownership for a Challonge username (master key required).
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              autoComplete="off"
              value={claimUsername}
              onChange={(e) => { setClaimUsername(e.target.value); setErr(null); }}
              placeholder="Challonge username"
              style={{ flex: 1, padding: "8px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", outline: "none" }}
            />
            <button
              type="button"
              onClick={() => void handleClaim()}
              disabled={!claimUsername.trim() || saving}
              style={{ padding: "0 12px", borderRadius: 6, border: "none", background: claimUsername.trim() && !saving ? "#92400E" : "#CBD5E1", color: "#fff", fontSize: 11, fontWeight: 700, cursor: claimUsername.trim() && !saving ? "pointer" : "not-allowed" }}
            >
              Claim
            </button>
          </div>
        </div>
      )}

      {/* Head judges list */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {meta.headJudges.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>No head judges yet.</span>
        )}
        {meta.headJudges.map((u) => (
          <span key={u} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, padding: "4px 8px", borderRadius: 12, background: "#EDE9FE", color: "#5B21B6", border: "1px solid #C4B5FD" }}>
            {u}
            <button
              type="button"
              onClick={() => void handleRemoveJudge(u)}
              disabled={saving}
              style={{ border: "none", background: "transparent", color: "#5B21B6", cursor: "pointer", fontSize: 13, fontWeight: 800, padding: 0, lineHeight: 1 }}
              aria-label={`Remove ${u}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {/* Add new head judge */}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          autoComplete="off"
          value={newJudge}
          onChange={(e) => { setNewJudge(e.target.value); setErr(null); }}
          placeholder="Add Challonge username"
          style={{ flex: 1, padding: "8px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", outline: "none" }}
        />
        <button
          type="button"
          onClick={() => void handleAddJudge()}
          disabled={!newJudge.trim() || saving}
          style={{ padding: "0 12px", borderRadius: 6, border: "none", background: newJudge.trim() && !saving ? "#7C3AED" : "#CBD5E1", color: "#fff", fontSize: 11, fontWeight: 700, cursor: newJudge.trim() && !saving ? "pointer" : "not-allowed" }}
        >
          + Add
        </button>
      </div>

      {err && <p style={{ fontSize: 11, color: "#DC2626", textAlign: "center", marginTop: 8, fontWeight: 600 }}>{err}</p>}
    </div>
  );
}

// ─── Login Mode card (F4) ───────────────────────────────────────────────────
function LoginModeCard({ masterKey, slug, meta, onUpdate }: {
  masterKey: string;
  slug: string;
  meta: OrgMeta;
  onUpdate: (m: OrgMeta) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickMode = async (mode: "solo" | "duo"): Promise<void> => {
    setSaving(true); setErr(null);
    const result = await setLoginMode(masterKey, slug, mode);
    setSaving(false);
    if (!result.ok) { setErr(result.message); return; }
    onUpdate({ ...meta, loginMode: result.loginMode });
  };

  const buttonStyle = (selected: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "16px 12px",
    borderRadius: 10,
    border: selected ? "2px solid #7C3AED" : "2px solid var(--border)",
    background: selected ? "#EDE9FE" : "var(--surface)",
    color: selected ? "#5B21B6" : "var(--text-primary)",
    fontSize: 13,
    fontWeight: 700,
    fontFamily: "'Outfit',sans-serif",
    cursor: saving ? "not-allowed" : "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  });

  return (
    <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
      <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>Login Mode</p>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => void pickMode("solo")} disabled={saving} style={buttonStyle(meta.loginMode === "solo")}>
          <span style={{ fontSize: 22 }}>📱</span>
          <span>Solo</span>
          <span style={{ fontSize: 9, fontWeight: 500, color: "var(--text-muted)" }}>One judge per tablet</span>
        </button>
        <button type="button" onClick={() => void pickMode("duo")} disabled={saving} style={buttonStyle(meta.loginMode === "duo")}>
          <span style={{ fontSize: 22 }}>👥</span>
          <span>Duo</span>
          <span style={{ fontSize: 9, fontWeight: 500, color: "var(--text-muted)" }}>Two judges share one tablet</span>
        </button>
      </div>
      {err && <p style={{ fontSize: 11, color: "#DC2626", textAlign: "center", marginTop: 8, fontWeight: 600 }}>{err}</p>}
    </div>
  );
}

// ─── Judge Whitelist card (F6) ──────────────────────────────────────────────
function JudgeWhitelistCard({ masterKey, slug, usernames, onUpdate }: {
  masterKey: string;
  slug: string;
  usernames: string[];
  onUpdate: (next: string[]) => void;
}) {
  // Edit mode toggles a textarea (one username per line) for bulk edits.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(usernames.join("\n"));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Name-map modal — opened from the 🔗 button. Owned by this card so the
  // modal close handler can re-render the whitelist row chips.
  const [nameMapOpen, setNameMapOpen] = useState(false);

  const startEdit = (): void => {
    setDraft(usernames.join("\n"));
    setEditing(true);
    setErr(null);
  };

  const save = async (): Promise<void> => {
    const list = draft
      .split(/[\n,]/g)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    setSaving(true); setErr(null);
    const result = await setJudgeWhitelist(masterKey, slug, list);
    setSaving(false);
    if (!result.ok) { setErr(result.message); return; }
    onUpdate(result.usernames);
    setEditing(false);
  };

  return (
    <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.8, margin: 0 }}>
          Judge Whitelist ({usernames.length})
        </p>
        {!editing && (
          <div style={{ display: "flex", gap: 6 }}>
            {usernames.length > 0 && (
              <button
                type="button"
                onClick={() => setNameMapOpen(true)}
                style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "#3B82F6", cursor: "pointer", fontFamily: "'Outfit',sans-serif" }}
              >
                🔗 Name Map
              </button>
            )}
            <button
              type="button"
              onClick={startEdit}
              style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", cursor: "pointer", fontFamily: "'Outfit',sans-serif" }}
            >
              Edit
            </button>
          </div>
        )}
      </div>

      {!editing && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {usernames.length === 0 && <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>No judges whitelisted.</span>}
          {usernames.map((u) => (
            <span key={u} style={{ fontSize: 11, fontWeight: 600, padding: "4px 8px", borderRadius: 12, background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)" }}>{u}</span>
          ))}
        </div>
      )}

      {editing && (
        <>
          <textarea
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setErr(null); }}
            placeholder="One Challonge username per line (also accepts commas)"
            rows={6}
            style={{ width: "100%", padding: "8px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", outline: "none", fontFamily: "'JetBrains Mono', monospace", resize: "vertical", boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              style={{ flex: 1, padding: "8px 0", borderRadius: 6, border: "none", background: saving ? "#CBD5E1" : "#7C3AED", color: "#fff", fontSize: 11, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", fontFamily: "'Outfit',sans-serif" }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setErr(null); }}
              disabled={saving}
              style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-muted)", fontSize: 11, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", fontFamily: "'Outfit',sans-serif" }}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {err && <p style={{ fontSize: 11, color: "#DC2626", textAlign: "center", marginTop: 8, fontWeight: 600 }}>{err}</p>}

      {/* Name-map modal — only mounted while open so its expensive participants
          fetch only runs when the user actually opens it. */}
      {nameMapOpen && (
        <NameMapModal
          masterKey={masterKey}
          slug={slug}
          judgeWhitelist={usernames}
          onClose={() => setNameMapOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Live Dashboard card (F9) ───────────────────────────────────────────────
// Single-slug-scoped card that polls /overlay/all every 5s for live broadcast
// slots and /pings/poll every 2s for judge attention requests. Shows the
// current 4-slot snapshot inline; floats an active-ping modal on top when
// pings arrive. Mirrors standalone NC BLAST OrgApp lines 16367-16453.
function LiveDashboardCard() {
  const [slug, setSlug] = useState("");
  const [active, setActive] = useState(false); // true once slug is committed
  const [liveSlots, setLiveSlots] = useState<OverlaySlotSnapshot[]>([]);
  const [pings, setPings] = useState<Ping[]>([]);
  const [activePing, setActivePing] = useState<Ping | null>(null);
  const liveSlotIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pingPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // afterRef tracks the highest sentAt we've seen so /pings/poll only returns fresh ones.
  const afterRef = useRef<number>(0);
  const pingPollActiveRef = useRef<boolean>(false);

  const start = (): void => {
    if (!slug.trim()) return;
    setActive(true);
  };

  const stop = (): void => {
    setActive(false);
    setLiveSlots([]);
    setPings([]);
    setActivePing(null);
    if (liveSlotIntervalRef.current) clearInterval(liveSlotIntervalRef.current);
    if (pingPollTimeoutRef.current) clearTimeout(pingPollTimeoutRef.current);
    pingPollActiveRef.current = false;
    afterRef.current = 0;
  };

  // Polling effect — runs while active is true and slug is set.
  useEffect(() => {
    if (!active || !slug.trim()) return;
    const s = slug.trim();

    // 5-second liveSlots poll.
    const pollLive = async (): Promise<void> => {
      const result = await getOverlayAll();
      if (result.ok) setLiveSlots(result.slots);
    };
    void pollLive();
    liveSlotIntervalRef.current = setInterval(() => void pollLive(), 5000);

    // 2-second ping poll loop.
    pingPollActiveRef.current = true;
    const pollPingsLoop = async (): Promise<void> => {
      if (!pingPollActiveRef.current) return;
      const result = await pollPings(s, afterRef.current);
      if (result.ok && result.pings.length > 0) {
        // Move afterRef forward so we don't re-receive these pings on the next poll.
        afterRef.current = Math.max(...result.pings.map((p) => p.sentAt));
        // Dedupe by id and append.
        setPings((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...result.pings.filter((p) => !seen.has(p.id))];
        });
      }
      if (pingPollActiveRef.current) {
        pingPollTimeoutRef.current = setTimeout(() => void pollPingsLoop(), 2000);
      }
    };
    pingPollTimeoutRef.current = setTimeout(() => void pollPingsLoop(), 0);

    return () => {
      if (liveSlotIntervalRef.current) clearInterval(liveSlotIntervalRef.current);
      if (pingPollTimeoutRef.current) clearTimeout(pingPollTimeoutRef.current);
      pingPollActiveRef.current = false;
    };
  }, [active, slug]);

  // Surface the next ping when no modal is showing.
  useEffect(() => {
    if (!activePing && pings.length > 0) {
      setActivePing(pings[0]);
    }
  }, [pings, activePing]);

  const handleDismissPing = async (ping: Ping): Promise<void> => {
    // Optimistic local removal so the modal closes instantly.
    setPings((prev) => prev.filter((p) => p.id !== ping.id));
    setActivePing(null);
    // Tell server (fire-and-forget).
    void apiDismissPing(slug.trim(), ping.id);
  };

  return (
    <>
      <div style={{ ...S.current.card, borderLeft: "4px solid #DC2626", padding: "14px 16px" }}>
        <h2 style={{ ...S.current.label, color: "#DC2626", fontSize: 14 }}>Live Dashboard</h2>
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
          Real-time mirror of all 4 overlay slots + judge attention pings. Polls every 5s.
        </p>

        {!active && (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              autoComplete="off"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="Tournament slug"
              style={{ flex: 1, padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", outline: "none" }}
            />
            <button
              type="button"
              onClick={start}
              disabled={!slug.trim()}
              style={{ padding: "0 16px", borderRadius: 8, border: "none", background: slug.trim() ? "#DC2626" : "#CBD5E1", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: slug.trim() ? "pointer" : "not-allowed" }}
            >
              Start
            </button>
          </div>
        )}

        {active && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#DC2626" }}>● LIVE — {slug}</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {pings.length > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 12, background: "#DC2626", color: "#fff" }}>
                    🚨 {pings.length}
                  </span>
                )}
                <button
                  type="button"
                  onClick={stop}
                  style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-muted)", cursor: "pointer", fontFamily: "'Outfit', sans-serif" }}
                >
                  Stop
                </button>
              </div>
            </div>

            {/* 4-slot grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {liveSlots.map((slot) => (
                <SlotCard key={slot.slot} snapshot={slot} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Active ping modal — outside the card so it can position fixed over everything. */}
      {activePing && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 20px" }}>
          <div style={{ background: "var(--surface)", borderRadius: 18, width: "100%", maxWidth: 360, boxShadow: "0 16px 48px rgba(0,0,0,0.5)", border: "3px solid #DC2626", overflow: "hidden" }}>
            <div style={{ background: "#DC2626", padding: "14px 18px", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 24 }}>🚨</span>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 14, fontWeight: 900, color: "#fff", margin: 0 }}>Judge Calling TO</p>
                {pings.length > 1 && (
                  <p style={{ fontSize: 10, color: "rgba(255,255,255,0.75)", margin: 0 }}>
                    {pings.length - 1} more ping{pings.length > 2 ? "s" : ""} waiting
                  </p>
                )}
              </div>
            </div>
            <div style={{ padding: "16px 18px" }}>
              <div style={{ background: "var(--surface2)", borderRadius: 10, padding: "10px 12px", marginBottom: 12, border: "1px solid var(--border)" }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 4px" }}>Match</p>
                <p style={{ fontSize: 15, fontWeight: 900, color: "var(--text-primary)", margin: 0 }}>
                  {activePing.p1 || "?"} vs {activePing.p2 || "?"}
                </p>
                {activePing.judge && <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "3px 0 0" }}>Judge: {activePing.judge}</p>}
              </div>
              {activePing.comment && (
                <div style={{ background: "#FEF3C7", borderRadius: 10, padding: "10px 12px", marginBottom: 12, border: "1px solid #FCD34D" }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 4px" }}>Note from Judge</p>
                  <p style={{ fontSize: 13, color: "#78350F", margin: 0, lineHeight: 1.5 }}>{activePing.comment}</p>
                </div>
              )}
              <p style={{ fontSize: 10, color: "var(--text-faint)", margin: "0 0 12px", textAlign: "right" }}>
                {new Date(activePing.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
              <button
                type="button"
                onClick={() => void handleDismissPing(activePing)}
                style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: "var(--surface3)", color: "var(--text-primary)", fontSize: 13, fontWeight: 900, fontFamily: "'Outfit',sans-serif", cursor: "pointer" }}
              >
                ✕ Dismiss {pings.length > 1 ? `(${pings.length - 1} more)` : ""}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Single overlay-slot card inside the LiveDashboardCard ──────────────────
// Tries to extract a few well-known fields from the opaque slot.state so it
// can render a useful summary. Falls back gracefully when fields are missing.
function SlotCard({ snapshot }: { snapshot: OverlaySlotSnapshot }) {
  const slot = snapshot.slot;
  // Type-narrow opaque state into a few optional fields we know exist.
  const s = (snapshot.state && typeof snapshot.state === "object") ? snapshot.state as {
    p1?: string;
    p2?: string;
    pts?: [number, number];
    sets?: [number, number];
    judge?: string;
    tournamentName?: string;
    shuffling?: boolean;
  } : null;

  const live = !!s && (s.p1 || s.p2);
  return (
    <div style={{ padding: "10px 12px", borderRadius: 10, border: live ? "2px solid #DC2626" : "1px solid var(--border)", background: live ? "rgba(220,38,38,0.05)" : "var(--surface2)", minHeight: 80 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-faint)", letterSpacing: 0.8, textTransform: "uppercase" }}>Slot {slot}</span>
        {live && <span style={{ fontSize: 9, fontWeight: 800, color: "#DC2626", letterSpacing: 0.8 }}>● LIVE</span>}
      </div>
      {!live && <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, fontStyle: "italic" }}>No active match</p>}
      {live && s && (
        <>
          <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", margin: "0 0 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {s.p1 || "—"} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>vs</span> {s.p2 || "—"}
          </p>
          {s.pts && (
            <p style={{ fontSize: 14, fontWeight: 900, color: "var(--text-primary)", margin: "0 0 2px" }}>
              {s.pts[0]} <span style={{ color: "var(--text-muted)" }}>—</span> {s.pts[1]}
            </p>
          )}
          {s.sets && (s.sets[0] > 0 || s.sets[1] > 0) && (
            <p style={{ fontSize: 9, color: "var(--text-muted)", margin: "0 0 2px" }}>Sets: {s.sets[0]}–{s.sets[1]}</p>
          )}
          {s.judge && <p style={{ fontSize: 9, color: "var(--text-muted)", margin: 0 }}>⚖️ {s.judge}</p>}
          {s.shuffling && <p style={{ fontSize: 9, color: "#A16207", fontWeight: 700, margin: "4px 0 0" }}>⏱ Shuffling</p>}
        </>
      )}
    </div>
  );
}

// ─── Name Map Modal (F7) ────────────────────────────────────────────────────
// Full-screen modal that lets the organizer link each whitelisted Challonge
// username to the bracket display name they're known as on stream. Mirrors
// standalone NC BLAST index.html:16671-16976.
//
// Two input modalities:
//   1. HTML5 drag-and-drop on desktop (drag a chip from the pool onto a judge row).
//   2. Tap-to-assign fallback: press the "Assign →" button next to a pool
//      chip, then pick a judge from the dropdown that opens. Required because
//      native HTML5 DnD is unreliable on tablets/touch devices.
//
// Auto-match: on first open, any judge whose Challonge username matches a
// participant name (case-insensitive) gets the suggestion pre-filled (yellow
// AUTO badge). Auto-suggestions don't persist until the user explicitly Saves.
function NameMapModal({ masterKey, slug, judgeWhitelist, onClose }: {
  masterKey: string;
  slug: string;
  judgeWhitelist: string[];
  onClose: () => void;
}) {
  const [participants, setParticipants] = useState<string[]>([]);
  // Saved map (already on the server). Used to distinguish AUTO suggestions
  // from already-saved entries when rendering judge rows.
  const [savedMap, setSavedMap] = useState<JudgeNameMap>({});
  // Draft = in-progress edits. Lowercase username → bracket name | null.
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Tap-to-assign menu state — which pool chip's "Assign →" is open.
  const [assignMenu, setAssignMenu] = useState<string | null>(null);

  // On mount: load global name map AND tournament participants from pairings.
  useEffect(() => {
    let cancelled = false;
    const init = async (): Promise<void> => {
      setLoading(true); setErr(null);
      const [mapRes, pairRes] = await Promise.all([
        getJudgeNameMap(),
        slug ? getPairings(slug) : Promise.resolve({ ok: true as const, pairings: [], fromCache: false }),
      ]);
      if (cancelled) return;
      setLoading(false);
      if (!mapRes.ok) { setErr(mapRes.message); return; }
      const map = mapRes.map;
      setSavedMap(map);
      // Extract unique participant display names from the pairings response.
      // Sort alphabetically so the chip pool has stable ordering.
      const names = pairRes.ok
        ? Array.from(new Set(
            pairRes.pairings.flatMap((p) => [p.player1_name, p.player2_name])
              .filter((n): n is string => !!n && n.trim().length > 0)
              .map((n) => n.trim()),
          )).sort((a, b) => a.localeCompare(b))
        : [];
      setParticipants(names);
      // Build initial draft: saved map values, else auto-match participant by
      // case-insensitive username equality. Auto-matches show with the AUTO
      // badge so the organizer can verify before saving.
      const d: Record<string, string | null> = {};
      for (const u of judgeWhitelist) {
        const key = u.toLowerCase();
        if (map[key]) {
          d[u] = map[key];
        } else {
          const match = names.find((n) => n.toLowerCase() === u.toLowerCase());
          d[u] = match || null;
        }
      }
      setDraft(d);
    };
    void init();
    return () => { cancelled = true; };
  }, [slug, judgeWhitelist]);

  // Currently-claimed bracket names — used to filter the unmatched pool.
  const claimed = new Set(Object.values(draft).filter((v): v is string => !!v));
  const unmatched = participants.filter((p) => !claimed.has(p));
  const allMapped = judgeWhitelist.every((u) => !!draft[u]);

  const assignName = (judgeUsername: string, bracketName: string | null): void => {
    setDraft((prev) => {
      const next = { ...prev };
      // If this bracketName is already assigned to a different judge, clear
      // that other judge's mapping so the same name can't be on two judges.
      if (bracketName) {
        for (const u of Object.keys(next)) {
          if (next[u] === bracketName) next[u] = null;
        }
      }
      next[judgeUsername] = bracketName;
      return next;
    });
    setAssignMenu(null);
  };

  // ── HTML5 DnD handlers (desktop) ──
  const onDragStart = (e: React.DragEvent, name: string): void => {
    e.dataTransfer.setData("text/plain", name);
  };
  const onDropOnJudge = (e: React.DragEvent, judge: string): void => {
    e.preventDefault();
    const name = e.dataTransfer.getData("text/plain");
    if (name) assignName(judge, name);
    setDragOver(null);
  };
  const onDropOnPool = (e: React.DragEvent): void => {
    e.preventDefault();
    const name = e.dataTransfer.getData("text/plain");
    if (!name) return;
    // Drop on the pool = unassign wherever this name was.
    setDraft((prev) => {
      const next = { ...prev };
      for (const u of Object.keys(next)) {
        if (next[u] === name) next[u] = null;
      }
      return next;
    });
    setDragOver(null);
  };
  const onDragOver = (e: React.DragEvent, target: string): void => {
    e.preventDefault();
    setDragOver(target);
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true); setErr(null);
    const map: JudgeNameMap = {};
    for (const [u, v] of Object.entries(draft)) {
      if (v) map[u.toLowerCase()] = v;
    }
    const result = await setJudgeNameMap(masterKey, map);
    setSaving(false);
    if (!result.ok) { setErr(result.message); return; }
    // Mirror to localStorage so any judge on this device gets the update
    // immediately without waiting for a refresh. Mirrors standalone behavior.
    try { localStorage.setItem("ncblast-judge-namemap", JSON.stringify(result.map)); } catch { /* ignore */ }
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 600, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "20px 16px", overflowY: "auto" }}>
      <div style={{ background: "var(--surface)", borderRadius: 18, width: "100%", maxWidth: 420, boxShadow: "0 16px 48px rgba(0,0,0,0.5)", border: "1px solid var(--border)" }}>
        <div style={{ padding: "16px 18px 0", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 1, margin: "0 0 2px" }}>Global — persists across events</p>
            <h2 style={{ fontSize: 18, fontWeight: 900, color: "var(--text-primary)", margin: 0 }}>Judge Name Mapping</h2>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0", lineHeight: 1.5 }}>
              Link each judge's Challonge login to their bracket display name. Drag a bracket name onto a judge row, or use the "Assign →" button on touch devices.
            </p>
          </div>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 22, fontFamily: "'Outfit',sans-serif", paddingTop: 2, flexShrink: 0 }}>×</button>
        </div>

        <div style={{ padding: "14px 18px 18px" }}>
          {err && <p style={{ fontSize: 11, color: "#DC2626", margin: "0 0 8px", fontWeight: 600 }}>⚠ {err}</p>}
          {loading && <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>Loading…</p>}

          {/* Bracket-name pool — drag source on desktop, also has Assign → on touch. */}
          <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 6px" }}>
            Bracket Names — drag onto a judge row
          </p>
          <div
            onDrop={onDropOnPool}
            onDragOver={(e) => { e.preventDefault(); setDragOver("__pool__"); }}
            onDragLeave={() => setDragOver(null)}
            style={{
              minHeight: 44,
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              padding: "8px 10px",
              borderRadius: 10,
              border: `2px dashed ${dragOver === "__pool__" ? "var(--text-muted)" : "var(--border)"}`,
              background: dragOver === "__pool__" ? "var(--surface2)" : "transparent",
              marginBottom: 14,
              transition: "background 0.15s",
            }}
          >
            {unmatched.length === 0 && allMapped && (
              <p style={{ fontSize: 10, color: "var(--text-faint)", margin: "auto 0", fontStyle: "italic" }}>All names assigned — drag here to unassign</p>
            )}
            {unmatched.length === 0 && !allMapped && (
              <p style={{ fontSize: 10, color: "var(--text-faint)", margin: "auto 0", fontStyle: "italic" }}>
                {participants.length === 0 ? "No bracket names — make sure the slug is loaded above." : "No bracket names left to assign."}
              </p>
            )}
            {unmatched.map((p) => {
              const isAssignOpen = assignMenu === p;
              const unmappedJudges = judgeWhitelist.filter((u) => !draft[u]);
              return (
                <div key={p} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px 4px 14px", borderRadius: isAssignOpen ? "20px 20px 6px 6px" : "20px", background: "var(--surface2)", border: "1.5px solid var(--border)" }}>
                    <span
                      draggable
                      onDragStart={(e) => onDragStart(e, p)}
                      style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", cursor: "grab", userSelect: "none", flex: 1 }}
                    >
                      {p}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAssignMenu(isAssignOpen ? null : p)}
                      style={{ background: isAssignOpen ? "#3B82F6" : "none", border: `1px solid ${isAssignOpen ? "#3B82F6" : "var(--border)"}`, borderRadius: 5, padding: "2px 6px", cursor: "pointer", fontSize: 9, fontWeight: 800, color: isAssignOpen ? "#fff" : "var(--text-faint)", fontFamily: "'Outfit',sans-serif", flexShrink: 0 }}
                    >
                      {isAssignOpen ? "✕" : "Assign →"}
                    </button>
                  </div>
                  {isAssignOpen && (
                    <div style={{ background: "var(--surface)", border: "1.5px solid var(--border)", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "6px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
                      <p style={{ fontSize: 9, fontWeight: 700, color: "var(--text-faint)", margin: "0 0 3px", textTransform: "uppercase", letterSpacing: 0.5 }}>Assign to judge:</p>
                      {unmappedJudges.length === 0 && (
                        <p style={{ fontSize: 10, color: "var(--text-faint)", fontStyle: "italic", margin: 0 }}>All judges already have a name assigned</p>
                      )}
                      {unmappedJudges.map((u) => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => assignName(u, p)}
                          style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontSize: 11, fontWeight: 700, fontFamily: "'Outfit',sans-serif", cursor: "pointer", textAlign: "left" }}
                        >
                          {u}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Judge rows — drop targets. */}
          <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 8px" }}>Judges</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
            {judgeWhitelist.map((u) => {
              const mapped = draft[u] || null;
              const savedFor = savedMap[u.toLowerCase()] || null;
              // AUTO badge only when a value exists in draft but NOT in saved
              // (i.e. it's an unsaved suggestion or an unsaved manual edit).
              const isAutoMatch = !savedFor && mapped;
              const isOver = dragOver === u;
              return (
                <div
                  key={u}
                  onDrop={(e) => onDropOnJudge(e, u)}
                  onDragOver={(e) => onDragOver(e, u)}
                  onDragLeave={() => setDragOver(null)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "9px 12px",
                    borderRadius: 10,
                    border: `2px solid ${isOver ? "#3B82F6" : mapped ? "var(--border)" : "var(--border)"}`,
                    background: isOver ? "rgba(59,130,246,0.13)" : mapped ? "var(--surface2)" : "var(--surface)",
                    transition: "background 0.12s, border-color 0.12s",
                  }}
                >
                  <div style={{ flex: "0 0 auto", minWidth: 0 }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", margin: 0, whiteSpace: "nowrap" }}>{u}</p>
                    <p style={{ fontSize: 9, color: "var(--text-faint)", margin: 0 }}>Challonge</p>
                  </div>
                  <span style={{ fontSize: 12, color: "var(--text-faint)", flexShrink: 0 }}>→</span>
                  {mapped ? (
                    <div
                      draggable
                      onDragStart={(e) => onDragStart(e, mapped)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flex: 1,
                        padding: "4px 10px",
                        borderRadius: 20,
                        background: isAutoMatch ? "#FEF3C7" : "#1E3A5F",
                        border: `1.5px solid ${isAutoMatch ? "#F59E0B" : "#3B82F6"}`,
                        cursor: "grab",
                        userSelect: "none",
                      }}
                    >
                      <span style={{ fontSize: 11, fontWeight: 700, color: isAutoMatch ? "#78350F" : "#93C5FD", flex: 1 }}>{mapped}</span>
                      {isAutoMatch && <span style={{ fontSize: 9, fontWeight: 800, color: "#92400E", letterSpacing: 0.5 }}>AUTO</span>}
                      <button
                        type="button"
                        onClick={() => assignName(u, null)}
                        style={{ background: "none", border: "none", color: isAutoMatch ? "#92400E" : "#60A5FA", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0, fontFamily: "'Outfit',sans-serif" }}
                        aria-label={`Unassign from ${u}`}
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <div style={{ flex: 1, padding: "6px 10px", borderRadius: 20, border: `2px dashed ${isOver ? "#3B82F6" : "var(--border)"}`, textAlign: "center" }}>
                      <p style={{ fontSize: 10, color: "var(--text-faint)", margin: 0, fontStyle: "italic" }}>Drop bracket name here or use Assign →</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "2px solid var(--border)", background: "none", color: "var(--text-muted)", fontSize: 13, fontWeight: 700, fontFamily: "'Outfit',sans-serif", cursor: saving ? "not-allowed" : "pointer" }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || loading}
              style={{ flex: 2, padding: "11px 0", borderRadius: 10, border: "none", background: saving ? "var(--border)" : "#3B82F6", color: "#fff", fontSize: 13, fontWeight: 800, fontFamily: "'Outfit',sans-serif", cursor: saving ? "not-allowed" : "pointer" }}
            >
              {saving ? "Saving…" : "💾 Save Name Map"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Stadium Assignment card (F10) ──────────────────────────────────────────
// Pick 1-8 stadiums (step 1) then drag whitelisted judges into the A-H
// buckets (step 2). Mirrors standalone NC BLAST index.html:17023-17151. Uses
// HTML5 DnD for desktop and a tap-to-pick-stadium fallback for touch.
const STADIUM_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
type StadiumLetter = typeof STADIUM_LETTERS[number];
const STADIUM_COLORS: Record<StadiumLetter, { bg: string; border: string; text: string; faint: string }> = {
  A: { bg: "#0D9488", border: "#14B8A6", text: "#fff", faint: "#99F6E4" },
  B: { bg: "#7C3AED", border: "#8B5CF6", text: "#fff", faint: "#DDD6FE" },
  C: { bg: "#D97706", border: "#F59E0B", text: "#fff", faint: "#FDE68A" },
  D: { bg: "#DB2777", border: "#EC4899", text: "#fff", faint: "#FBCFE8" },
  E: { bg: "#2563EB", border: "#3B82F6", text: "#fff", faint: "#BFDBFE" },
  F: { bg: "#DC2626", border: "#EF4444", text: "#fff", faint: "#FECACA" },
  G: { bg: "#059669", border: "#10B981", text: "#fff", faint: "#A7F3D0" },
  H: { bg: "#9333EA", border: "#A855F7", text: "#fff", faint: "#E9D5FF" },
};

function StadiumAssignCard({ masterKey, slug, judgeWhitelist }: {
  masterKey: string;
  slug: string;
  judgeWhitelist: string[];
}) {
  // Stadium count — null until step 1 is completed.
  const [count, setCount] = useState<number | null>(null);
  // Lowercased username → letter (or undefined when unassigned).
  const [assign, setAssign] = useState<Record<string, string>>({});
  // Global judge name map so we can show bracket display names instead of
  // raw Challonge usernames in the chip pool / buckets.
  const [nameMap, setNameMap] = useState<JudgeNameMap>({});
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Tap-to-assign: which judge's "Stadium →" menu is open.
  const [pickMenu, setPickMenu] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<null | "saved" | "error">(null);
  const [err, setErr] = useState<string | null>(null);

  // Initial load — pull existing stadium doc + global name map in parallel.
  useEffect(() => {
    let cancelled = false;
    const init = async (): Promise<void> => {
      const [stadRes, mapRes] = await Promise.all([
        getStadiumAssign(slug),
        getJudgeNameMap(),
      ]);
      if (cancelled) return;
      if (stadRes.ok && stadRes.data) {
        setCount(stadRes.data.count > 0 ? stadRes.data.count : null);
        setAssign(stadRes.data.assign || {});
      }
      if (mapRes.ok) setNameMap(mapRes.map);
    };
    void init();
    return () => { cancelled = true; };
  }, [slug]);

  const stadiumLetters = (count ? STADIUM_LETTERS.slice(0, count) : []) as StadiumLetter[];
  const unassigned = judgeWhitelist.filter((u) => !assign[u.toLowerCase()] || !stadiumLetters.includes(assign[u.toLowerCase()] as StadiumLetter));

  const setLetter = (username: string, letter: StadiumLetter | null): void => {
    setAssign((prev) => {
      const next = { ...prev };
      const key = username.toLowerCase();
      if (letter) next[key] = letter;
      else delete next[key];
      return next;
    });
    setSaveMsg(null);
    setPickMenu(null);
  };

  const onDragStart = (e: React.DragEvent, username: string): void => {
    e.dataTransfer.setData("text/plain", username);
  };
  const onDropOnLetter = (e: React.DragEvent, letter: StadiumLetter): void => {
    e.preventDefault();
    const username = e.dataTransfer.getData("text/plain");
    if (username) setLetter(username, letter);
    setDragOver(null);
  };
  const onDropOnPool = (e: React.DragEvent): void => {
    e.preventDefault();
    const username = e.dataTransfer.getData("text/plain");
    if (username) setLetter(username, null);
    setDragOver(null);
  };
  const onDragOver = (e: React.DragEvent, target: string): void => {
    e.preventDefault();
    setDragOver(target);
  };

  const handleSave = async (): Promise<void> => {
    if (!count) return;
    setSaving(true); setErr(null); setSaveMsg(null);
    const result = await apiSetStadiumAssign(masterKey, slug, count, assign);
    setSaving(false);
    if (!result.ok) {
      setErr(result.message);
      setSaveMsg("error");
      setTimeout(() => setSaveMsg(null), 2500);
      return;
    }
    setAssign(result.assign);
    setSaveMsg("saved");
    setTimeout(() => setSaveMsg(null), 2500);
  };

  const handleReset = (): void => {
    setCount(null);
    setAssign({});
    setSaveMsg(null);
    setErr(null);
  };

  return (
    <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.8, margin: 0 }}>
          Stadium Assignment
        </p>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {saveMsg === "saved" && <span style={{ fontSize: 10, fontWeight: 700, color: "#22C55E" }}>✓ Saved</span>}
          {saveMsg === "error" && <span style={{ fontSize: 10, fontWeight: 700, color: "#EF4444" }}>⚠ Failed</span>}
          {count && (
            <>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                style={{ background: "#3B82F6", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 10, fontWeight: 800, color: "#fff", fontFamily: "'Outfit',sans-serif", cursor: saving ? "not-allowed" : "pointer" }}
              >
                {saving ? "…" : "Save"}
              </button>
              <button
                type="button"
                onClick={handleReset}
                style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 9px", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "'Outfit',sans-serif", cursor: "pointer" }}
              >
                Reset
              </button>
            </>
          )}
        </div>
      </div>

      {/* Step 1: pick count */}
      {!count && (
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", margin: "0 0 8px" }}>How many stadiums are you running?</p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setCount(n)}
                style={{ width: 38, height: 38, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface)", color: "var(--text-primary)", fontSize: 16, fontWeight: 800, fontFamily: "'Outfit',sans-serif", cursor: "pointer" }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: drag-and-drop assignment */}
      {count && (
        <div>
          <p style={{ fontSize: 9, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 6px" }}>
            Judges (unassigned) — drag onto a stadium, or use Stadium →
          </p>
          {/* Unassigned pool */}
          <div
            onDrop={onDropOnPool}
            onDragOver={(e) => { e.preventDefault(); setDragOver("__pool__"); }}
            onDragLeave={() => setDragOver(null)}
            style={{
              minHeight: 38,
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              padding: "8px 10px",
              borderRadius: 10,
              border: `2px dashed ${dragOver === "__pool__" ? "var(--text-muted)" : "var(--border)"}`,
              background: dragOver === "__pool__" ? "var(--surface)" : "transparent",
              marginBottom: 12,
              transition: "background 0.15s",
            }}
          >
            {unassigned.length === 0 && (
              <p style={{ fontSize: 10, color: "var(--text-faint)", margin: "auto 0", fontStyle: "italic" }}>All judges assigned — drag here to unassign</p>
            )}
            {unassigned.map((u) => {
              const bracketName = nameMap[u.toLowerCase()];
              const isOpen = pickMenu === u;
              return (
                <div key={u} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px 4px 12px", borderRadius: isOpen ? "20px 20px 6px 6px" : 20, background: "var(--surface)", border: "1.5px solid var(--border)" }}>
                    <span
                      draggable
                      onDragStart={(e) => onDragStart(e, u)}
                      style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", cursor: "grab", userSelect: "none", flex: 1 }}
                    >
                      {bracketName || u}
                      {bracketName && <span style={{ fontSize: 9, color: "var(--text-faint)", fontWeight: 500, marginLeft: 4 }}>({u})</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPickMenu(isOpen ? null : u)}
                      style={{ background: isOpen ? "#3B82F6" : "none", border: `1px solid ${isOpen ? "#3B82F6" : "var(--border)"}`, borderRadius: 5, padding: "2px 6px", cursor: "pointer", fontSize: 9, fontWeight: 800, color: isOpen ? "#fff" : "var(--text-faint)", fontFamily: "'Outfit',sans-serif", flexShrink: 0 }}
                    >
                      {isOpen ? "✕" : "Stadium →"}
                    </button>
                  </div>
                  {isOpen && (
                    <div style={{ background: "var(--surface)", border: "1.5px solid var(--border)", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "6px 10px", display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {stadiumLetters.map((letter) => {
                        const sc = STADIUM_COLORS[letter];
                        return (
                          <button
                            key={letter}
                            type="button"
                            onClick={() => setLetter(u, letter)}
                            style={{ padding: "5px 10px", borderRadius: 7, border: `1.5px solid ${sc.border}`, background: sc.bg, color: sc.text, fontSize: 11, fontWeight: 800, fontFamily: "'Outfit',sans-serif", cursor: "pointer" }}
                          >
                            {letter}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Stadium buckets */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
            {stadiumLetters.map((letter) => {
              const sc = STADIUM_COLORS[letter];
              const members = judgeWhitelist.filter((u) => assign[u.toLowerCase()] === letter);
              const isOver = dragOver === letter;
              return (
                <div
                  key={letter}
                  onDrop={(e) => onDropOnLetter(e, letter)}
                  onDragOver={(e) => onDragOver(e, letter)}
                  onDragLeave={() => setDragOver(null)}
                  style={{
                    borderRadius: 10,
                    padding: "8px 10px",
                    minHeight: 60,
                    border: `2px solid ${isOver ? sc.border : sc.bg + "60"}`,
                    background: isOver ? sc.bg + "25" : sc.bg + "12",
                    transition: "background 0.15s, border-color 0.15s",
                  }}
                >
                  <p style={{ fontSize: 10, fontWeight: 800, color: sc.bg, margin: "0 0 6px", letterSpacing: 0.8 }}>STADIUM {letter}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {members.length === 0 && (
                      <p style={{ fontSize: 10, color: sc.bg + "90", margin: 0, fontStyle: "italic" }}>Drop here</p>
                    )}
                    {members.map((u) => {
                      const bracketName = nameMap[u.toLowerCase()];
                      return (
                        <div
                          key={u}
                          draggable
                          onDragStart={(e) => onDragStart(e, u)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "3px 8px",
                            borderRadius: 20,
                            background: sc.bg,
                            border: `1.5px solid ${sc.border}`,
                            fontSize: 10,
                            fontWeight: 700,
                            color: sc.text,
                            cursor: "grab",
                            userSelect: "none",
                            maxWidth: "100%",
                          }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bracketName || u}</span>
                          <button
                            type="button"
                            onClick={() => setLetter(u, null)}
                            style={{ background: "none", border: "none", color: sc.text, cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0, fontFamily: "'Outfit',sans-serif", opacity: 0.85 }}
                            aria-label={`Unassign ${u}`}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {err && <p style={{ fontSize: 11, color: "#DC2626", textAlign: "center", marginTop: 8, fontWeight: 600 }}>{err}</p>}
    </div>
  );
}

// ─── Station Queues / Match Call Helper (F11) ───────────────────────────────
// The largest single feature in the OrgApp port. Combines:
//   - Pairings (current round's matches) from /pairings
//   - Judge whitelist (passed in)
//   - Judge name map (loaded here)
//   - Stadium assignment (loaded here)
//   - Live slots (loaded here on a 5s interval so coverage updates automatically)
// Into a per-stadium ordered queue with drag-to-reorder, lock pins, move
// menu, generate-all algorithm, "judges first" toggle, and coverage warnings.
// Mirrors standalone NC BLAST index.html:17269-17710 (~440 lines).
//
// Pure client-side — no Worker writes for the queue itself. State is
// ephemeral so a tab refresh resets it. Locks use a Set<number>.
type StationQueueMap = Record<StadiumLetter, number[]>;

function StationQueuesCard({ slug, judgeWhitelist }: {
  slug: string;
  judgeWhitelist: string[];
}) {
  // ── Loaded data ──
  const [pairings, setPairings] = useState<PairingMatch[]>([]);
  const [nameMap, setNameMap] = useState<JudgeNameMap>({});
  const [stadium, setStadium] = useState<StadiumAssign | null>(null);
  const [liveSlots, setLiveSlots] = useState<OverlaySlotSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── Queue state ──
  const [stationQueues, setStationQueues] = useState<StationQueueMap>({} as StationQueueMap);
  const [queuesGenerated, setQueuesGenerated] = useState(false);
  const [lockedMatchIds, setLockedMatchIds] = useState<Set<number>>(new Set());
  const [judgesFirstMode, setJudgesFirstMode] = useState(true);

  // ── Drag + menu state ──
  const [queueDragItem, setQueueDragItem] = useState<{ matchId: number; fromStation: StadiumLetter } | null>(null);
  const [queueDragOver, setQueueDragOver] = useState<{ station: StadiumLetter; afterIdx: number } | null>(null);
  const [moveMenuOpen, setMoveMenuOpen] = useState<number | null>(null);

  // ── Initial load + 5s liveSlots refresh while card is open ──
  const reload = async (): Promise<void> => {
    if (!slug) return;
    setLoading(true); setErr(null);
    const [pairRes, mapRes, stadRes] = await Promise.all([
      getPairings(slug, true),
      getJudgeNameMap(),
      getStadiumAssign(slug),
    ]);
    setLoading(false);
    if (!pairRes.ok) { setErr(pairRes.message); return; }
    if (!mapRes.ok) { setErr(mapRes.message); return; }
    if (!stadRes.ok) { setErr(stadRes.message); return; }
    setPairings(pairRes.pairings);
    setNameMap(mapRes.map);
    setStadium(stadRes.data);
  };

  useEffect(() => {
    void reload();
    // Refresh live slots every 5s so coverage warnings stay accurate as
    // matches start/finish on judges' tablets.
    const refreshLive = async (): Promise<void> => {
      const result = await getOverlayAll();
      if (result.ok) setLiveSlots(result.slots);
    };
    void refreshLive();
    const id = setInterval(() => void refreshLive(), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // ── Derived data ──
  // Active stadium letters (subset of A-H based on count).
  const stadiumLetters: StadiumLetter[] = stadium && stadium.count > 0
    ? (STADIUM_LETTERS.slice(0, stadium.count) as StadiumLetter[])
    : [];
  const stadiumAssignMap = stadium?.assign || {};

  // Current round = lowest open round number among open matches.
  const openMatches = pairings.filter((m) => m.state !== "complete");
  const openRoundNums = openMatches
    .map((m) => m.round)
    .filter((r): r is number => typeof r === "number" && r !== 0 && Number.isFinite(r));
  const currentRound = openRoundNums.length > 0 ? Math.min(...openRoundNums) : null;
  let roundMatches = currentRound !== null
    ? pairings.filter((m) => m.round === currentRound)
    : pairings;
  if (roundMatches.length === 0 && openMatches.length > 0) roundMatches = openMatches;

  // ── Live state lookups ──
  const liveByMatchId: Record<string, { p1?: string; p2?: string; sets?: [number, number]; pts?: [number, number]; judge?: string; shuffling?: boolean; challongeMatchId?: number }> = {};
  const liveByPlayers: Record<string, { p1?: string; p2?: string; sets?: [number, number]; pts?: [number, number]; judge?: string; shuffling?: boolean }> = {};
  const playersLive = new Set<string>();
  for (const s of liveSlots) {
    if (!s.state || typeof s.state !== "object") continue;
    const st = s.state as { p1?: string; p2?: string; sets?: [number, number]; pts?: [number, number]; judge?: string; shuffling?: boolean; challongeMatchId?: number };
    if (st.challongeMatchId !== undefined) liveByMatchId[String(st.challongeMatchId)] = st;
    if (st.p1 || st.p2) {
      const key = [(st.p1 || "").toLowerCase().trim(), (st.p2 || "").toLowerCase().trim()].sort().join("|");
      liveByPlayers[key] = st;
    }
    if (st.p1) playersLive.add(st.p1.toLowerCase());
    if (st.p2) playersLive.add(st.p2.toLowerCase());
  }
  const getLiveState = (m: PairingMatch): typeof liveByMatchId[string] | null => {
    if (m.id && liveByMatchId[String(m.id)]) return liveByMatchId[String(m.id)];
    const key = [(m.player1_name || "").toLowerCase().trim(), (m.player2_name || "").toLowerCase().trim()].sort().join("|");
    return liveByPlayers[key] || null;
  };
  const isLive = (name: string | null | undefined): boolean => !!name && playersLive.has(name.toLowerCase());

  // ── Helpers ──
  const getBN = (u: string): string => nameMap[u.toLowerCase()] || u;
  const isJudgeName = (displayName: string | null): boolean => {
    if (!displayName) return false;
    const dl = displayName.toLowerCase();
    return judgeWhitelist.some((u) => {
      const mapped = nameMap[u.toLowerCase()];
      return mapped ? mapped.toLowerCase() === dl : u.toLowerCase() === dl;
    });
  };
  const displayToUsername = (displayName: string | null): string | null => {
    if (!displayName) return null;
    const dl = displayName.toLowerCase();
    return judgeWhitelist.find((u) => {
      const mapped = nameMap[u.toLowerCase()];
      return mapped ? mapped.toLowerCase() === dl : u.toLowerCase() === dl;
    }) || null;
  };
  const judgesAt = (letter: StadiumLetter): string[] =>
    judgeWhitelist.filter((u) => stadiumAssignMap[u.toLowerCase()] === letter);
  const floaterUsers = judgeWhitelist.filter((u) => !stadiumAssignMap[u.toLowerCase()]);
  const freeAt = (letter: StadiumLetter): number =>
    judgesAt(letter).filter((u) => !isLive(getBN(u))).length;
  const floatersFree = floaterUsers.filter((u) => !isLive(getBN(u))).length;

  // Match classification — display badge.
  const classifyM = (m: PairingMatch): "PvP" | "JvP" | "JvJ" => {
    const p1j = isJudgeName(m.player1_name);
    const p2j = isJudgeName(m.player2_name);
    if (p1j && p2j) return "JvJ";
    if (p1j || p2j) return "JvP";
    return "PvP";
  };

  // Priority classification — floater-only judge matches schedule like PvP.
  const isFloater = (displayName: string | null): boolean => {
    if (!displayName) return false;
    const u = displayToUsername(displayName);
    return u ? floaterUsers.includes(u) : false;
  };
  const classifyForPriority = (m: PairingMatch): "PvP" | "JvP" | "JvJ" => {
    const p1j = isJudgeName(m.player1_name);
    const p2j = isJudgeName(m.player2_name);
    if (!p1j && !p2j) return "PvP";
    if (p1j && p2j) {
      const p1float = isFloater(m.player1_name);
      const p2float = isFloater(m.player2_name);
      if (p1float && p2float) return "PvP";
      return "JvJ";
    }
    return "JvP";
  };

  const matchById: Record<number, PairingMatch> = {};
  roundMatches.forEach((m) => { matchById[m.id] = m; });
  const waitingIds = new Set(
    roundMatches.filter((m) => !getLiveState(m) && m.state !== "complete").map((m) => m.id),
  );

  // ── Queue generator ─────────────────────────────────────────────────────
  // Builds suggested ordered queues per stadium. Mirrors standalone exactly.
  const generateQueues = (): StationQueueMap => {
    const queues: StationQueueMap = {} as StationQueueMap;
    for (const l of stadiumLetters) {
      // Preserve locked matches in their current stations.
      queues[l] = (stationQueues[l] || []).filter((id) => lockedMatchIds.has(id));
    }
    const lockedSet = new Set(stadiumLetters.flatMap((l) => queues[l]));

    const pending = roundMatches.filter((m) => {
      if (m.state === "complete") return false;
      if (getLiveState(m)) return false;
      if (lockedSet.has(m.id)) return false;
      return true;
    });

    const jvjMatches = pending.filter((m) => classifyForPriority(m) === "JvJ");
    const jvpMatches = pending.filter((m) => classifyForPriority(m) === "JvP");
    const pvpMatches = pending.filter((m) => classifyForPriority(m) === "PvP");

    const pushToShortest = (matchId: number): void => {
      if (stadiumLetters.length === 0) return;
      const shortest = stadiumLetters.reduce((best, l) =>
        queues[l].length < queues[best].length ? l : best,
        stadiumLetters[0],
      );
      queues[shortest].push(matchId);
    };

    if (judgesFirstMode) {
      // Step 1: JvP matches go to the station whose judges are playing in them.
      for (const letter of stadiumLetters) {
        const judges = judgesAt(letter);
        const stationJvP = jvpMatches.filter((m) => {
          const p1u = displayToUsername(m.player1_name);
          const p2u = displayToUsername(m.player2_name);
          return (p1u && judges.includes(p1u)) || (p2u && judges.includes(p2u));
        });
        stationJvP.sort((a, b) => {
          const juA = displayToUsername(a.player1_name) || displayToUsername(a.player2_name) || "";
          const juB = displayToUsername(b.player1_name) || displayToUsername(b.player2_name) || "";
          return getBN(juA).localeCompare(getBN(juB));
        });
        stationJvP.forEach((m) => queues[letter].push(m.id));
      }
      // Step 1b: floater JvP matches go to shortest queue.
      const assignedJvP = new Set(stadiumLetters.flatMap((l) => queues[l]));
      jvpMatches.filter((m) => !assignedJvP.has(m.id)).forEach((m) => pushToShortest(m.id));
      // Step 2: PvP matches.
      pvpMatches.forEach((m) => pushToShortest(m.id));
    } else {
      // Judges-Last mode: PvP first, then JvP, then JvJ.
      pvpMatches.forEach((m) => pushToShortest(m.id));
      for (const letter of stadiumLetters) {
        const judges = judgesAt(letter);
        const stationJvP = jvpMatches.filter((m) => {
          const p1u = displayToUsername(m.player1_name);
          const p2u = displayToUsername(m.player2_name);
          return (p1u && judges.includes(p1u)) || (p2u && judges.includes(p2u));
        });
        stationJvP.sort((a, b) => {
          const juA = displayToUsername(a.player1_name) || displayToUsername(a.player2_name) || "";
          const juB = displayToUsername(b.player1_name) || displayToUsername(b.player2_name) || "";
          return getBN(juA).localeCompare(getBN(juB));
        });
        stationJvP.forEach((m) => queues[letter].push(m.id));
      }
      const assignedJvP2 = new Set(stadiumLetters.flatMap((l) => queues[l]));
      jvpMatches.filter((m) => !assignedJvP2.has(m.id)).forEach((m) => pushToShortest(m.id));
    }
    // JvJ matches always go last.
    jvjMatches.forEach((m) => pushToShortest(m.id));
    return queues;
  };

  // ── Coverage check: can the next match at this station be called? ───────
  const coverageFor = (m: PairingMatch | null, stationLetter: StadiumLetter): { ok: boolean; flags: string[] } => {
    if (!m) return { ok: true, flags: [] };
    const type = classifyM(m);
    const flags: string[] = [];
    const blocked = isLive(m.player1_name) || isLive(m.player2_name);
    if (blocked) return { ok: false, flags: ["Player already in a live match"] };

    if (type === "PvP") return { ok: true, flags };

    if (type === "JvP") {
      const judgePlayer = isJudgeName(m.player1_name) ? displayToUsername(m.player1_name) : displayToUsername(m.player2_name);
      const homeSt = judgePlayer ? (stadiumAssignMap[judgePlayer.toLowerCase()] as StadiumLetter | undefined) : undefined;
      const remainAfter = homeSt ? freeAt(homeSt) - 1 : 0;
      if (homeSt && remainAfter >= 1) return { ok: true, flags };
      if (floatersFree > 0) {
        flags.push(`Floater covers Stadium ${homeSt || "?"}`);
        return { ok: true, flags };
      }
      const donor = stadiumLetters.find((l) => l !== homeSt && freeAt(l) >= 2);
      if (donor) {
        flags.push(`Handoff from Stadium ${donor}`);
        return { ok: true, flags };
      }
      return { ok: false, flags: [`Stadium ${homeSt || "?"} would be stranded`] };
    }

    if (type === "JvJ") {
      const p1u = displayToUsername(m.player1_name);
      const p2u = displayToUsername(m.player2_name);
      const st1 = p1u ? (stadiumAssignMap[p1u.toLowerCase()] as StadiumLetter | undefined) : undefined;
      const st2 = p2u ? (stadiumAssignMap[p2u.toLowerCase()] as StadiumLetter | undefined) : undefined;
      if (st1 && st1 === st2) {
        if (floatersFree > 0) {
          flags.push("Same-station JvJ — floater needed");
          return { ok: true, flags };
        }
        const donor = stadiumLetters.find((l) => l !== st1 && freeAt(l) >= 2);
        if (donor) {
          flags.push(`Same-station JvJ — handoff from Stadium ${donor}`);
          return { ok: true, flags };
        }
        return { ok: false, flags: ["Same-station JvJ — no coverage available"] };
      }
      const st1ok = !st1 || freeAt(st1) >= 2;
      const st2ok = !st2 || freeAt(st2) >= 2;
      if (st1ok && st2ok) return { ok: true, flags };
      const problems: string[] = [];
      if (!st1ok) problems.push(`Stadium ${st1} stranded`);
      if (!st2ok) problems.push(`Stadium ${st2} stranded`);
      return { ok: false, flags: problems };
    }
    return { ok: true, flags };
  };

  // ── Drag handlers ──
  const onQueueDragStart = (e: React.DragEvent, matchId: number, fromStation: StadiumLetter): void => {
    e.dataTransfer.setData("text/plain", String(matchId));
    setQueueDragItem({ matchId, fromStation });
  };
  const onQueueDragOver = (e: React.DragEvent, station: StadiumLetter, afterIdx: number): void => {
    e.preventDefault();
    setQueueDragOver({ station, afterIdx });
  };
  const onQueueDrop = (e: React.DragEvent, toStation: StadiumLetter, afterIdx: number): void => {
    e.preventDefault();
    if (!queueDragItem) return;
    const { matchId, fromStation } = queueDragItem;
    setStationQueues((prev) => {
      const next = {} as StationQueueMap;
      for (const l of stadiumLetters) next[l] = [...(prev[l] || [])];
      next[fromStation] = next[fromStation].filter((id) => id !== matchId);
      const dest = [...(next[toStation] || [])];
      const insertAt = Math.min(afterIdx, dest.length);
      dest.splice(insertAt, 0, matchId);
      next[toStation] = dest;
      return next;
    });
    setQueueDragItem(null);
    setQueueDragOver(null);
  };
  const onQueueDragEnd = (): void => { setQueueDragItem(null); setQueueDragOver(null); };

  const moveMatch = (matchId: number, fromStation: StadiumLetter, toStation: StadiumLetter): void => {
    setStationQueues((prev) => {
      const next = {} as StationQueueMap;
      for (const l of stadiumLetters) next[l] = [...(prev[l] || [])];
      next[fromStation] = next[fromStation].filter((id) => id !== matchId);
      next[toStation] = [...next[toStation], matchId];
      return next;
    });
    setMoveMenuOpen(null);
  };

  const toggleLock = (matchId: number): void => {
    setLockedMatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(matchId)) next.delete(matchId);
      else next.add(matchId);
      return next;
    });
  };

  const typeBadgeColor = (type: "PvP" | "JvP" | "JvJ"): string =>
    type === "JvJ" ? "#F59E0B" : type === "JvP" ? "#3B82F6" : "var(--text-faint)";

  // ── Render guards ──
  if (!slug) return null;
  const noStadium = !stadium || stadium.count === 0;

  return (
    <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
        <div>
          <p style={{ fontSize: 9, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 1, margin: "0 0 1px" }}>Match Call Helper</p>
          <p style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)", margin: 0 }}>Station Queues</p>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => setJudgesFirstMode((m) => !m)}
            title="Toggle whether judge-played matches go to the front (judges-first) or end (judges-last) of the queue"
            style={{ padding: "5px 10px", borderRadius: 8, border: `1px solid ${judgesFirstMode ? "#3B82F6" : "var(--border)"}`, background: judgesFirstMode ? "#3B82F6" : "var(--surface)", color: judgesFirstMode ? "#fff" : "var(--text-secondary)", fontSize: 10, fontWeight: 700, fontFamily: "'Outfit',sans-serif", cursor: "pointer" }}
          >
            {judgesFirstMode ? "⚖ Judges First" : "🎲 Judges Last"}
          </button>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-faint)", fontSize: 10, fontWeight: 700, fontFamily: "'Outfit',sans-serif", cursor: loading ? "not-allowed" : "pointer" }}
          >
            {loading ? "…" : "↻ Refresh"}
          </button>
          {queuesGenerated && (
            <button
              type="button"
              onClick={() => { setQueuesGenerated(false); setStationQueues({} as StationQueueMap); setLockedMatchIds(new Set()); setMoveMenuOpen(null); }}
              style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "none", color: "var(--text-faint)", fontSize: 10, fontWeight: 700, fontFamily: "'Outfit',sans-serif", cursor: "pointer" }}
            >
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const q = generateQueues();
              setStationQueues(q);
              setQueuesGenerated(true);
              setMoveMenuOpen(null);
            }}
            disabled={noStadium || roundMatches.length === 0}
            style={{ padding: "5px 12px", borderRadius: 8, border: "none", background: noStadium || roundMatches.length === 0 ? "#94A3B8" : "#3B82F6", color: "#fff", fontSize: 10, fontWeight: 800, fontFamily: "'Outfit',sans-serif", cursor: noStadium || roundMatches.length === 0 ? "not-allowed" : "pointer" }}
          >
            {queuesGenerated ? "↻ Regenerate" : "⚡ Generate Queues"}
          </button>
        </div>
      </div>

      {err && <p style={{ fontSize: 11, color: "#DC2626", textAlign: "center", marginBottom: 8, fontWeight: 600 }}>⚠ {err}</p>}
      {noStadium && (
        <p style={{ fontSize: 11, color: "#A16207", margin: "0 0 8px", padding: "8px 10px", background: "#FEF3C7", borderRadius: 6 }}>
          ⚠ No stadium count set — use Stadium Assignment above first.
        </p>
      )}
      {roundMatches.length === 0 && !loading && !noStadium && (
        <p style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", padding: "20px 0" }}>
          No matches in the current round. Make sure the slug has an active Challonge tournament.
        </p>
      )}

      {/* Floaters bar */}
      {floaterUsers.length > 0 && !noStadium && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 10, padding: "6px 10px", background: "var(--surface)", borderRadius: 6, border: "1px solid var(--border)" }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 0.5 }}>Floaters:</span>
          {floaterUsers.map((u) => (
            <span
              key={u}
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: 10,
                background: isLive(getBN(u)) ? "#450A0A" : "var(--surface2)",
                color: isLive(getBN(u)) ? "#FCA5A5" : "var(--text-secondary)",
                border: `1px solid ${isLive(getBN(u)) ? "#DC2626" : "var(--border)"}`,
              }}
            >
              {getBN(u)}{isLive(getBN(u)) ? " ▶" : ""}
            </span>
          ))}
          <span style={{ fontSize: 9, color: "var(--text-faint)", marginLeft: "auto" }}>{floatersFree}/{floaterUsers.length} free</span>
        </div>
      )}

      {!queuesGenerated && !noStadium && roundMatches.length > 0 && (
        <div style={{ padding: "20px", borderRadius: 10, border: "2px dashed var(--border)", textAlign: "center", color: "var(--text-muted)" }}>
          <p style={{ fontSize: 22, margin: "0 0 6px" }}>📋</p>
          <p style={{ fontSize: 12, fontWeight: 700, margin: "0 0 3px" }}>No queues generated yet</p>
          <p style={{ fontSize: 10, color: "var(--text-faint)", margin: 0 }}>Tap Generate Queues to build a suggested match order based on judge assignments.</p>
        </div>
      )}

      {/* Per-stadium queues */}
      {queuesGenerated && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10, alignItems: "start" }}>
          {stadiumLetters.map((letter) => {
            const sc = STADIUM_COLORS[letter];
            const queueIds = stationQueues[letter] || [];
            const visibleIds = queueIds.filter((id) => waitingIds.has(id));
            const nextId = visibleIds[0] || null;
            const nextMatch = nextId ? matchById[nextId] : null;
            const nextCoverage = coverageFor(nextMatch, letter);
            const stationJudges = judgesAt(letter);

            return (
              <div key={letter} style={{ borderRadius: 10, border: `2px solid ${sc.bg}40`, overflow: "hidden" }}>
                {/* Stadium header */}
                <div style={{ background: sc.bg + "18", borderBottom: `1px solid ${sc.bg}30`, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: sc.bg, letterSpacing: 0.5 }}>STADIUM {letter}</span>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {stationJudges.map((u) => (
                        <span
                          key={u}
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: 8,
                            background: isLive(getBN(u)) ? "#450A0A" : sc.bg + "30",
                            color: isLive(getBN(u)) ? "#FCA5A5" : sc.bg,
                            border: `1px solid ${isLive(getBN(u)) ? "#DC2626" : sc.bg + "50"}`,
                          }}
                        >
                          {getBN(u)}{isLive(getBN(u)) ? " ▶" : ""}
                        </span>
                      ))}
                      {stationJudges.length === 0 && <span style={{ fontSize: 9, color: "var(--text-faint)", fontStyle: "italic" }}>No judges</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: 10, color: sc.bg, fontWeight: 700, flexShrink: 0 }}>{visibleIds.length} queued</span>
                </div>

                {/* Queue items */}
                <div style={{ padding: "8px 10px", background: "var(--surface)" }}>
                  {visibleIds.length === 0 && (
                    <p style={{ fontSize: 10, color: "var(--text-faint)", margin: "4px 0", fontStyle: "italic", textAlign: "center" }}>Queue empty — drag or use Move →</p>
                  )}

                  {visibleIds.map((id, idx) => {
                    const m = matchById[id];
                    if (!m) return null;
                    const type = classifyM(m);
                    const isNext = idx === 0;
                    const cov = isNext ? nextCoverage : { ok: true, flags: [] };
                    const isBlocked = isNext && !cov.ok;
                    const isDragging = queueDragItem?.matchId === id;
                    const isDropTarget = queueDragOver?.station === letter && queueDragOver?.afterIdx === idx;
                    const isLocked = lockedMatchIds.has(id);
                    const isMoveOpen = moveMenuOpen === id;
                    const otherStations = stadiumLetters.filter((l) => l !== letter);

                    return (
                      <div key={id}>
                        {isDropTarget && <div style={{ height: 3, borderRadius: 2, background: "#3B82F6", margin: "2px 0" }} />}
                        <div style={{ marginBottom: 4 }}>
                          <div
                            draggable={!isLocked}
                            onDragStart={(e) => !isLocked && onQueueDragStart(e, id, letter)}
                            onDragEnd={onQueueDragEnd}
                            onDragOver={(e) => onQueueDragOver(e, letter, idx)}
                            onDrop={(e) => onQueueDrop(e, letter, idx)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "6px 8px",
                              borderRadius: 8,
                              border: `1.5px solid ${isLocked ? sc.bg + "90" : isBlocked ? "#DC2626" : isNext ? sc.bg + "60" : "var(--border)"}`,
                              background: isBlocked ? "#450A0A" : isNext ? sc.bg + "10" : "var(--surface2)",
                              opacity: isDragging ? 0.4 : 1,
                              cursor: isLocked ? "default" : "grab",
                            }}
                          >
                            <span style={{ fontSize: 10, fontWeight: 800, color: isNext ? sc.bg : "var(--text-faint)", width: 14, textAlign: "center", flexShrink: 0 }}>{idx + 1}</span>
                            <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 5px", borderRadius: 4, border: `1px solid ${typeBadgeColor(type)}50`, color: typeBadgeColor(type), flexShrink: 0 }}>{type}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: isBlocked ? "#FCA5A5" : "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {m.player1_name || "?"} <span style={{ fontWeight: 400, color: "var(--text-faint)" }}>vs</span> {m.player2_name || "?"}
                            </span>
                            {cov.flags.length > 0 && !isMoveOpen && (
                              <span style={{ fontSize: 9, fontWeight: 700, color: isBlocked ? "#EF4444" : "#F59E0B", flexShrink: 0, textAlign: "right", maxWidth: 120, lineHeight: 1.3 }}>
                                {cov.flags[0]}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => toggleLock(id)}
                              title={isLocked ? "Unlock — allow regenerate to move this match" : "Lock — keep this match here on regenerate"}
                              style={{ background: "none", border: "none", padding: "0 2px", cursor: "pointer", fontSize: 13, lineHeight: 1, flexShrink: 0, opacity: isLocked ? 1 : 0.45 }}
                            >
                              {isLocked ? "🔒" : "🔓"}
                            </button>
                            {otherStations.length > 0 && (
                              <button
                                type="button"
                                onClick={() => setMoveMenuOpen(isMoveOpen ? null : id)}
                                style={{ background: isMoveOpen ? "#3B82F6" : "none", border: `1px solid ${isMoveOpen ? "#3B82F6" : "var(--border)"}`, borderRadius: 5, padding: "2px 6px", cursor: "pointer", fontSize: 9, fontWeight: 800, color: isMoveOpen ? "#fff" : "var(--text-faint)", fontFamily: "'Outfit',sans-serif", flexShrink: 0 }}
                              >
                                {isMoveOpen ? "✕" : "Move →"}
                              </button>
                            )}
                          </div>
                          {isMoveOpen && (
                            <div style={{ display: "flex", gap: 5, padding: "5px 8px", background: "var(--surface)", borderRadius: "0 0 8px 8px", border: "1px solid var(--border)", borderTop: "none", flexWrap: "wrap" }}>
                              <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-faint)", alignSelf: "center", marginRight: 2 }}>Move to:</span>
                              {otherStations.map((dest) => {
                                const dsc = STADIUM_COLORS[dest];
                                return (
                                  <button
                                    key={dest}
                                    type="button"
                                    onClick={() => moveMatch(id, letter, dest)}
                                    style={{ padding: "3px 10px", borderRadius: 6, border: `1.5px solid ${dsc.bg}`, background: dsc.bg + "18", color: dsc.bg, fontSize: 10, fontWeight: 800, fontFamily: "'Outfit',sans-serif", cursor: "pointer" }}
                                  >
                                    {dest}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Tail drop zone — append at end of queue */}
                  <div
                    onDragOver={(e) => onQueueDragOver(e, letter, visibleIds.length)}
                    onDrop={(e) => onQueueDrop(e, letter, visibleIds.length)}
                    style={{
                      height: queueDragOver?.station === letter && queueDragOver?.afterIdx === visibleIds.length ? 6 : 2,
                      borderRadius: 3,
                      background: queueDragOver?.station === letter && queueDragOver?.afterIdx === visibleIds.length ? "#3B82F6" : "transparent",
                      margin: "2px 0 0",
                      transition: "height 0.1s, background 0.1s",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Tournament Select card (F3) ───────────────────────────────────────────
// Lists tournaments whose participants have been cached by the Worker. The
// `/list` endpoint returns all cached entries (not filtered by owner) so the
// org gets a quick overview of every tournament the system knows about. Per-
// tournament ownership is enforced server-side on writes — anyone authed can
// see the list, but only the owner can edit `org:meta`, set PINs, etc.
//
// Add-by-link: paste a Challonge URL or slug to "warm" the cache by calling
// /?slug= via the existing roster fetch. After warming, the slug appears in
// the list and can be selected. Tournament creation lives in its own card.
function TournamentSelectCard() {
  const [tournaments, setTournaments] = useState<TournamentListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const [warming, setWarming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true); setErr(null);
    const result = await listCachedTournaments();
    setLoading(false);
    if (!result.ok) { setErr(result.message); return; }
    // Sort by most-recently-fetched first.
    const sorted = result.tournaments.slice().sort((a, b) => b.fetchedAt - a.fetchedAt);
    setTournaments(sorted);
  };

  useEffect(() => { void load(); }, []);

  const addByLink = async (): Promise<void> => {
    const slug = normalizeChallongeSlug(linkInput);
    if (!slug) {
      setErr("Couldn't parse a slug from that input.");
      return;
    }
    setWarming(true); setErr(null);
    try {
      // Touch the /?slug= endpoint to warm the cache. The Worker will fetch
      // participants from Challonge and store them in `tourney:<slug>` so
      // they appear in /list on the next reload.
      const res = await fetch(
        `${WORKER_BASE_URL}/?slug=${encodeURIComponent(slug)}`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { errors?: unknown[] };
        const msg = Array.isArray(data.errors) && data.errors.length ? String(data.errors[0]) : `HTTP ${res.status}`;
        setErr(msg);
        return;
      }
      setLinkInput("");
      await load();
    } catch (e) {
      setErr((e as Error).message || "Network error");
    } finally {
      setWarming(false);
    }
  };

  const handleDelete = async (slug: string): Promise<void> => {
    setErr(null);
    const result = await deleteTournamentFromCache(slug);
    if (!result.ok) { setErr(result.message); return; }
    setConfirmDelete(null);
    await load();
  };

  const fmtAge = (fetchedAt: number): string => {
    const ageMs = Date.now() - fetchedAt;
    const ageMin = Math.floor(ageMs / 60_000);
    if (ageMin < 1) return "just now";
    if (ageMin < 60) return `${ageMin}m ago`;
    const ageHr = Math.floor(ageMin / 60);
    if (ageHr < 24) return `${ageHr}h ago`;
    const ageDay = Math.floor(ageHr / 24);
    return `${ageDay}d ago`;
  };

  return (
    <div style={{ ...S.current.card, borderLeft: "4px solid #6366F1", padding: "14px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ ...S.current.label, color: "#6366F1", fontSize: 14, margin: 0 }}>Tournaments</h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-muted)", cursor: loading ? "not-allowed" : "pointer", fontFamily: "'Outfit', sans-serif" }}
        >
          {loading ? "…" : "↻ Refresh"}
        </button>
      </div>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
        Every tournament the Worker has cached. Paste a Challonge URL below to add a new one.
      </p>

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <input
          type="text"
          autoComplete="off"
          value={linkInput}
          onChange={(e) => { setLinkInput(e.target.value); setErr(null); }}
          placeholder="Challonge URL or slug"
          style={{ flex: 1, padding: "10px 12px", fontSize: 13, borderRadius: 8, border: "2px solid var(--border)", background: "var(--surface2)", color: "var(--text-primary)", fontFamily: "'Outfit', sans-serif", outline: "none" }}
        />
        <button
          type="button"
          onClick={() => void addByLink()}
          disabled={!linkInput.trim() || warming}
          style={{ padding: "0 14px", borderRadius: 8, border: "none", background: linkInput.trim() && !warming ? "#6366F1" : "#CBD5E1", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "'Outfit', sans-serif", cursor: linkInput.trim() && !warming ? "pointer" : "not-allowed" }}
        >
          {warming ? "Adding…" : "+ Add"}
        </button>
      </div>

      {err && <p style={{ fontSize: 11, color: "#DC2626", textAlign: "center", marginBottom: 10, fontWeight: 600 }}>{err}</p>}

      {tournaments.length === 0 && !loading && (
        <p style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", fontStyle: "italic", padding: "16px 0" }}>
          No cached tournaments. Paste a Challonge URL above to get started.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {tournaments.map((t) => {
          const isConfirming = confirmDelete === t.slug;
          return (
            <div
              key={t.slug}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface2)" }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", margin: "0 0 2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.slug}
                </p>
                <p style={{ fontSize: 10, color: "var(--text-muted)", margin: 0 }}>
                  {t.participantCount} player{t.participantCount === 1 ? "" : "s"} · cached {fmtAge(t.fetchedAt)}
                </p>
              </div>
              {!isConfirming && (
                <>
                  <a
                    href={`https://challonge.com/${t.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--surface)", color: "#6366F1", textDecoration: "none", fontFamily: "'Outfit', sans-serif" }}
                  >
                    ↗ Open
                  </a>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(t.slug)}
                    style={{ fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 5, border: "1px solid #FCA5A5", background: "var(--surface)", color: "#DC2626", cursor: "pointer", fontFamily: "'Outfit', sans-serif" }}
                  >
                    Delete
                  </button>
                </>
              )}
              {isConfirming && (
                <>
                  <span style={{ fontSize: 10, color: "#DC2626", fontWeight: 700 }}>Delete cache?</span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(t.slug)}
                    style={{ fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 5, border: "none", background: "#DC2626", color: "#fff", cursor: "pointer", fontFamily: "'Outfit', sans-serif" }}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(null)}
                    style={{ fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-muted)", cursor: "pointer", fontFamily: "'Outfit', sans-serif" }}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

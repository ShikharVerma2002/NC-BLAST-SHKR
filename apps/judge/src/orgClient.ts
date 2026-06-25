/**
/**
 * Organizer-action HTTP wrappers.
 *
 * Auth model (post-OAuth): every privileged call sends the opaque
 * `ncblast-auth-token` from sessionStorage as the `X-Auth-Token` header.
 * The Worker accepts X-Auth-Token (OAuth path) OR X-Master-Key (emergency
 * fallback). Per project decision, master-key is no longer exposed in the
 * UI but the Worker still honors it for break-glass operations.
 *
 * Each function below preserves its `masterKey` parameter name for backward
 * compatibility with existing callers, but the value passed is ignored —
 * we always read the token from sessionStorage at call time. This lets us
 * remove master-key UI without rewriting every consumer.
 */
import { WORKER_BASE_URL } from "@ncblast/shared";
import type { Combo } from "@ncblast/shared";

type Ok = { ok: true };
type Err = { ok: false; message: string };

/** Sentinel value: pass this where the legacy API expected `masterKey` and
 * you want to make explicit you're relying on the sessionStorage token.
 * Functionally equivalent to passing anything (the param is ignored). */
export const AUTH_VIA_TOKEN = "__via_session_token__";

/** Read the OAuth token currently stored in sessionStorage. Returns "" if
 * not logged in — callers should still call but the Worker will 401, which
 * the UI surfaces as an error message instead of a silent failure. */
export function getAuthToken(): string {
  try {
    return sessionStorage.getItem("ncblast-auth-token") || "";
  } catch {
    return "";
  }
}

export function getAuthUsername(): string {
  try {
    return sessionStorage.getItem("ncblast-auth-user") || "";
  } catch {
    return "";
  }
}

export function clearAuthSession(): void {
  try {
    sessionStorage.removeItem("ncblast-auth-token");
    sessionStorage.removeItem("ncblast-auth-user");
  } catch { /* ignore */ }
}

/** Standard headers for privileged calls. Always sends X-Auth-Token if
 * available; the Worker rejects with 401 if the token is missing/expired. */
function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h["X-Auth-Token"] = token;
  return h;
}

async function postWithAuth(path: string, body: Record<string, unknown>): Promise<Ok | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { ok: true };
    const data: unknown = await res.json().catch(() => null);
    const msg =
      typeof data === "object" && data !== null && "errors" in data && Array.isArray((data as { errors: unknown[] }).errors) && (data as { errors: unknown[] }).errors.length
        ? String((data as { errors: unknown[] }).errors[0])
        : `HTTP ${res.status}`;
    return { ok: false, message: msg };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── OAuth verification ────────────────────────────────────────────────────

/** Verify the stored session token is still valid (used on Organizer screen
 * mount to detect expired tokens before the user clicks anything). */
export async function verifyOrgSession(): Promise<{ ok: true; username: string } | Err> {
  const token = getAuthToken();
  const username = getAuthUsername();
  if (!token || !username) return { ok: false, message: "Not logged in" };
  try {
    const res = await fetch(`${WORKER_BASE_URL}/org/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, username }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      clearAuthSession();
      return { ok: false, message: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { ok?: boolean; username?: string; error?: string };
    if (!data.ok || !data.username) {
      clearAuthSession();
      return { ok: false, message: data.error || "Session invalid" };
    }
    return { ok: true, username: data.username };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Tournament creation ───────────────────────────────────────────────────

export interface CreateTournamentOpts {
  masterKey: string;
  name: string;
  urlSlug: string;
  tournamentType?: "single_elimination" | "double_elimination" | "round_robin" | "swiss";
  pin?: string;
  approvalMode?: boolean;
}

export async function createTournament(
  opts: CreateTournamentOpts
): Promise<{ ok: true; slug: string; url: string } | Err> {
  try {
    // masterKey arg ignored — auth via X-Auth-Token header set in authHeaders().
    const { masterKey: _ignored, ...rest } = opts;
    void _ignored;
    const res = await fetch(`${WORKER_BASE_URL}/tournament/create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(rest),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; slug?: string; url?: string; errors?: unknown[] };
    if (res.ok && data.ok && data.slug) {
      return { ok: true, slug: data.slug, url: data.url || `https://challonge.com/${data.slug}` };
    }
    const msg = Array.isArray(data.errors) && data.errors.length ? String(data.errors[0]) : `HTTP ${res.status}`;
    return { ok: false, message: msg };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Approval mode ─────────────────────────────────────────────────────────

export async function setApprovalMode(masterKey: string, slug: string, enabled: boolean): Promise<Ok | Err> {
  // masterKey arg ignored — auth comes from X-Auth-Token header.
  void masterKey;
  return await postWithAuth("/approval/set", { slug, enabled });
}

export interface PendingSubmission {
  id: string;
  matchId: number;
  scoresCsv: string;
  winnerId: number | null;
  submittedAt: number;
  ip: string | null;
}

export async function listPendingApprovals(masterKey: string, slug: string): Promise<{ ok: true; pending: PendingSubmission[] } | Err> {
  void masterKey; // ignored — auth via X-Auth-Token header
  try {
    const res = await fetch(`${WORKER_BASE_URL}/approval/list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ slug }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({})) as { pending?: PendingSubmission[]; errors?: unknown[] };
    if (res.ok && Array.isArray(data.pending)) {
      return { ok: true, pending: data.pending };
    }
    const msg = Array.isArray(data.errors) && data.errors.length ? String(data.errors[0]) : `HTTP ${res.status}`;
    return { ok: false, message: msg };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function decideApproval(masterKey: string, slug: string, id: string, decision: "approve" | "reject"): Promise<Ok | Err> {
  void masterKey;
  return await postWithAuth("/approval/decide", { slug, id, decision });
}

export async function getApprovalStatus(slug: string): Promise<{ ok: true; enabled: boolean } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/approval/status?slug=${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = await res.json() as { enabled?: boolean };
    return { ok: true, enabled: !!data.enabled };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Combo prereg ──────────────────────────────────────────────────────────

export async function submitPreregCombos(slug: string, playerName: string, combos: Combo[]): Promise<Ok | Err> {
  return await postWithAuth("/combos/prereg", { slug, playerName, combos });
}

export async function getPreregCombos(slug: string, playerName: string): Promise<{ ok: true; combos: Combo[] | null } | Err> {
  try {
    const res = await fetch(
      `${WORKER_BASE_URL}/combos/prereg?slug=${encodeURIComponent(slug)}&player=${encodeURIComponent(playerName)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = await res.json() as { combos?: Combo[] | null; playerName?: string };
    return { ok: true, combos: Array.isArray(data.combos) ? data.combos : null };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Pairings (org dashboard) ──────────────────────────────────────────────

/** Match record returned by /pairings — extends what /matches returns with
 * state, winner_id, and scores_csv so the org dashboard can show round
 * progress and completed-match scores. */
export interface PairingMatch {
  id: number;
  player1_id: number | null;
  player2_id: number | null;
  player1_name: string | null;
  player2_name: string | null;
  round: number;
  state: string;
  scores_csv?: string;
  winner_id?: number | null;
  suggested_play_order?: number;
}

export async function getPairings(
  slug: string,
  bypassCache = false,
): Promise<{ ok: true; pairings: PairingMatch[]; fromCache: boolean } | Err> {
  try {
    const url = `${WORKER_BASE_URL}/pairings?slug=${encodeURIComponent(slug)}${bypassCache ? "&bypass_cache=1" : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { pairings?: PairingMatch[]; fromCache?: boolean };
    return { ok: true, pairings: data.pairings || [], fromCache: !!data.fromCache };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

/** Force-refresh participant cache. The org "Refresh Roster" button calls
 * this to bypass the 30-min participant cache; pair with getPairings(slug, true)
 * for a complete refresh. */
export async function refreshRoster(slug: string): Promise<{ ok: true; participants: unknown[] } | Err> {
  try {
    const res = await fetch(
      `${WORKER_BASE_URL}/?slug=${encodeURIComponent(slug)}&bypass_cache=1`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { participants?: unknown[]; fromCache?: boolean };
    if (data.fromCache) return { ok: false, message: "Worker returned cached data — refresh failed" };
    return { ok: true, participants: data.participants || [] };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Score log (judge accountability) ──────────────────────────────────────

export interface ScoreLogEntry {
  id: string;
  p1: string;
  p2: string;
  p1Sets: number;
  p2Sets: number;
  winner: string;
  judge: string;
  challongeMatchId?: number;
  scoredAt: number;
}

/** Best-effort push from the judge submit flow. Call without awaiting the
 * result — score log is fire-and-forget. */
export function pushScoreLogEntry(payload: {
  slug: string;
  judge: string;
  p1: string;
  p2: string;
  p1Sets: number;
  p2Sets: number;
  winner: string;
  challongeMatchId?: number;
  scoredAt?: number;
}): Promise<Ok | Err> {
  return postWithAuth("/scorelog/push", payload as unknown as Record<string, unknown>);
}

export async function listScoreLog(slug: string): Promise<{ ok: true; entries: ScoreLogEntry[] } | Err> {
  try {
    const res = await fetch(
      `${WORKER_BASE_URL}/scorelog/list?slug=${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { entries?: ScoreLogEntry[] };
    return { ok: true, entries: data.entries || [] };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Org meta (head judges + owner + login mode) — F4/F5 ───────────────────

export interface OrgMeta {
  orgUsername: string | null;
  headJudges: string[];
  loginMode: "solo" | "duo" | null;
}

export async function getOrgMeta(slug: string): Promise<{ ok: true; meta: OrgMeta } | Err> {
  try {
    const res = await fetch(
      `${WORKER_BASE_URL}/judges/get?slug=${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as Partial<OrgMeta>;
    return {
      ok: true,
      meta: {
        orgUsername: data.orgUsername || null,
        headJudges: Array.isArray(data.headJudges) ? data.headJudges : [],
        loginMode: data.loginMode === "solo" || data.loginMode === "duo" ? data.loginMode : null,
      },
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function setHeadJudges(masterKey: string, slug: string, headJudges: string[]): Promise<{ ok: true; headJudges: string[] } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/judges/set`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ slug, headJudges }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const msg = (data && typeof data === "object" && "errors" in data && Array.isArray((data as { errors: unknown[] }).errors) && (data as { errors: unknown[] }).errors.length)
        ? String((data as { errors: unknown[] }).errors[0])
        : `HTTP ${res.status}`;
      return { ok: false, message: msg };
    }
    const data = (await res.json()) as { headJudges?: string[] };
    return { ok: true, headJudges: data.headJudges || [] };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function claimOwnership(masterKey: string, slug: string, orgUsername: string): Promise<{ ok: true; orgUsername: string } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/org/tournament/set-owner`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ slug, orgUsername }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const msg = (data && typeof data === "object" && "errors" in data && Array.isArray((data as { errors: unknown[] }).errors) && (data as { errors: unknown[] }).errors.length)
        ? String((data as { errors: unknown[] }).errors[0])
        : `HTTP ${res.status}`;
      return { ok: false, message: msg };
    }
    const data = (await res.json()) as { orgUsername?: string };
    return { ok: true, orgUsername: String(data.orgUsername || orgUsername) };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function setLoginMode(masterKey: string, slug: string, mode: "solo" | "duo"): Promise<{ ok: true; loginMode: "solo" | "duo" } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/org/tournament/set-login-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ slug, loginMode: mode }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const msg = (data && typeof data === "object" && "errors" in data && Array.isArray((data as { errors: unknown[] }).errors) && (data as { errors: unknown[] }).errors.length)
        ? String((data as { errors: unknown[] }).errors[0])
        : `HTTP ${res.status}`;
      return { ok: false, message: msg };
    }
    return { ok: true, loginMode: mode };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Judge whitelist — F6 ──────────────────────────────────────────────────

export async function getJudgeWhitelist(slug: string): Promise<{ ok: true; usernames: string[] } | Err> {
  try {
    const res = await fetch(
      `${WORKER_BASE_URL}/judge-whitelist/get?slug=${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { usernames?: string[] };
    return { ok: true, usernames: data.usernames || [] };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function setJudgeWhitelist(masterKey: string, slug: string, usernames: string[]): Promise<{ ok: true; usernames: string[] } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/judge-whitelist/set`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ slug, usernames }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const msg = (data && typeof data === "object" && "errors" in data && Array.isArray((data as { errors: unknown[] }).errors) && (data as { errors: unknown[] }).errors.length)
        ? String((data as { errors: unknown[] }).errors[0])
        : `HTTP ${res.status}`;
      return { ok: false, message: msg };
    }
    const data = (await res.json()) as { usernames?: string[] };
    return { ok: true, usernames: data.usernames || [] };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function checkJudgeWhitelist(slug: string, username: string): Promise<{ ok: true; allowed: boolean } | Err> {
  try {
    const res = await fetch(
      `${WORKER_BASE_URL}/judge-whitelist/check?slug=${encodeURIComponent(slug)}&username=${encodeURIComponent(username)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { allowed?: boolean };
    return { ok: true, allowed: !!data.allowed };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Overlay snapshot + Pings — F9 ─────────────────────────────────────────

/** Per-slot overlay state — shape mirrors what /overlay/state returns. The
 * org dashboard reads this for its 4-slot live mirror; specific fields like
 * judge/p1/p2/sets/pts are inspected by the dashboard but the overlay state
 * itself is opaque to the typings here (it's defined fully in @ncblast/shared
 * types.ts as OverlayState). */
export interface OverlaySlotSnapshot {
  slot: number;
  state: unknown | null;
  etag: string | null;
}

export async function getOverlayAll(): Promise<{ ok: true; slots: OverlaySlotSnapshot[] } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/overlay/all`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { slots?: OverlaySlotSnapshot[] };
    return { ok: true, slots: data.slots || [] };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export interface Ping {
  id: string;
  judge: string;
  p1: string;
  p2: string;
  comment: string;
  sentAt: number;
}

export async function sendPing(payload: {
  slug: string;
  judge?: string;
  p1?: string;
  p2?: string;
  comment?: string;
}): Promise<Ok | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/pings/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 429) return { ok: false, message: "Sending too fast — wait a moment." };
    const data: unknown = await res.json().catch(() => null);
    const msg = (data && typeof data === "object" && "errors" in data && Array.isArray((data as { errors: unknown[] }).errors) && (data as { errors: unknown[] }).errors.length)
      ? String((data as { errors: unknown[] }).errors[0])
      : `HTTP ${res.status}`;
    return { ok: false, message: msg };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function pollPings(slug: string, after: number): Promise<{ ok: true; pings: Ping[] } | Err> {
  try {
    const res = await fetch(
      `${WORKER_BASE_URL}/pings/poll?slug=${encodeURIComponent(slug)}&after=${after}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { pings?: Ping[] };
    return { ok: true, pings: data.pings || [] };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function dismissPing(slug: string, id: string): Promise<Ok | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/pings/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, id }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, message: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Judge name map (global) — F7 ───────────────────────────────────────────

/** Map shape: lowercased Challonge username → bracket display name. */
export type JudgeNameMap = Record<string, string>;

export async function getJudgeNameMap(): Promise<{ ok: true; map: JudgeNameMap } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/judge-namemap`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { map?: JudgeNameMap };
    return { ok: true, map: data.map || {} };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function setJudgeNameMap(masterKey: string, map: JudgeNameMap): Promise<{ ok: true; map: JudgeNameMap } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/judge-namemap`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ map }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const msg = (data && typeof data === "object" && "errors" in data && Array.isArray((data as { errors: unknown[] }).errors) && (data as { errors: unknown[] }).errors.length)
        ? String((data as { errors: unknown[] }).errors[0])
        : `HTTP ${res.status}`;
      return { ok: false, message: msg };
    }
    const data = (await res.json()) as { map?: JudgeNameMap };
    return { ok: true, map: data.map || {} };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Stadium assignment (per slug) — F10 ────────────────────────────────────

export interface StadiumAssign {
  count: number;
  assign: Record<string, string>; // lowercased username → letter A-H
}

export async function getStadiumAssign(slug: string): Promise<{ ok: true; data: StadiumAssign | null } | Err> {
  try {
    const res = await fetch(
      `${WORKER_BASE_URL}/stadium-assign?slug=${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { data?: StadiumAssign | null };
    return { ok: true, data: data.data ?? null };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function setStadiumAssign(masterKey: string, slug: string, count: number, assign: Record<string, string>): Promise<{ ok: true; count: number; assign: Record<string, string> } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/stadium-assign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ slug, count, assign }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const msg = (data && typeof data === "object" && "errors" in data && Array.isArray((data as { errors: unknown[] }).errors) && (data as { errors: unknown[] }).errors.length)
        ? String((data as { errors: unknown[] }).errors[0])
        : `HTTP ${res.status}`;
      return { ok: false, message: msg };
    }
    const data = (await res.json()) as { count?: number; assign?: Record<string, string> };
    return { ok: true, count: data.count || count, assign: data.assign || assign };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

// ─── Tournament list (F3) ──────────────────────────────────────────────────

export interface TournamentListEntry {
  slug: string;
  participantCount: number;
  fetchedAt: number;
}

export async function listCachedTournaments(): Promise<{ ok: true; tournaments: TournamentListEntry[] } | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}/list`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { tournaments?: TournamentListEntry[] };
    return { ok: true, tournaments: data.tournaments || [] };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "Network error" };
  }
}

export async function deleteTournamentFromCache(slug: string): Promise<Ok | Err> {
  return await postWithAuth("/delete", { slug });
}

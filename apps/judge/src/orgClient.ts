/**
 * Organizer-action HTTP wrappers. Each takes the master key explicitly;
 * callers that want the cached-session behavior should read from
 * `getCachedMasterKey()` in pin.ts and pass that in.
 */
import { WORKER_BASE_URL } from "@ncblast/shared";
import type { Combo } from "@ncblast/shared";

type Ok = { ok: true };
type Err = { ok: false; message: string };

async function postWithAuth(path: string, body: Record<string, unknown>): Promise<Ok | Err> {
  try {
    const res = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const res = await fetch(`${WORKER_BASE_URL}/tournament/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
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
  return await postWithAuth("/approval/set", { slug, enabled, masterKey });
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
  try {
    const res = await fetch(`${WORKER_BASE_URL}/approval/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, masterKey }),
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
  return await postWithAuth("/approval/decide", { slug, id, decision, masterKey });
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

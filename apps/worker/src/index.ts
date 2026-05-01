/**
 * NC BLAST Cloudflare Worker — Challonge proxy + Overlay state bus + PIN auth.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /?slug=X                  → Challonge participants (proxied + 30-min KV cached)
 *   GET  /list                     → cached tournaments metadata (slug, count, ageSeconds)
 *   POST /delete                   → remove a slug from cache (body: {slug})
 *   GET  /matches?slug=X           → open Challonge matches for slug
 *   GET  /standings?slug=X         → aggregated per-player W/L/points standings
 *   POST /submit                   → submit a match score to Challonge (gated by PIN in tournament mode)
 *                                     body: {slug, matchId, scores_csv, winner_id, pin?}
 *   POST /overlay/push             → write overlay state for a slot (body: {slot, state})
 *   GET  /overlay/poll?slot=N&etag=X → long-poll overlay state (30s timeout)
 *   GET  /overlay/state?slot=N     → current overlay state (one-shot)
 *   POST /combos/push              → cache a player's combos (body: {player, combos, updatedAt})
 *   GET  /combos/get?player=X      → fetch a player's cached combos
 *   POST /combos/prereg            → player: submit 3 combos for a tournament (body: {slug, playerName, combos})
 *   GET  /combos/prereg?slug=X&player=Y → judge/player: retrieve preregistered combos
 *
 *   Tournament + approval:
 *   POST /tournament/create        → organizer: create Challonge tournament (body: {masterKey, name, urlSlug, ...})
 *   POST /approval/set             → organizer: toggle approval mode (body: {slug, enabled, masterKey})
 *   GET  /approval/status?slug=X   → public: is approval mode on?
 *   POST /approval/list            → organizer: list pending submissions (body: {slug, masterKey})
 *   POST /approval/decide          → organizer: approve or reject (body: {slug, id, decision, masterKey})
 *
 *   Auth-related:
 *   POST /pin/set                  → organizer: set/update tournament PIN
 *                                     body: {slug, pin, masterKey}
 *   POST /admin/verify             → organizer: verify master key (no side effects)
 *                                     body: {masterKey}
 *   POST /pin/verify               → judge: verify PIN for a slug (rate-limited)
 *                                     body: {slug, pin}
 *                                     response: {ok: boolean, sessionToken?: string}
 *
 * Secrets (set via `wrangler secret put <NAME>`):
 *   CHALLONGE_API_KEY              → the shared Challonge v1 API key
 *   ORGANIZER_MASTER_KEY           → organizer-only secret for /pin/set
 *
 * KV bindings (wrangler.toml):
 *   TOURNEY_KV                     → tournament cache, overlay state, combos, PINs, rate-limit counters
 */

export interface Env {
  CHALLONGE_API_KEY: string;
  ORGANIZER_MASTER_KEY: string;
  TOURNEY_KV: KVNamespace;
}

const TOURNAMENT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const OVERLAY_LONG_POLL_MS = 25_000; // < 30s so clients with AbortSignal.timeout(30000) never race it
const OVERLAY_POLL_INTERVAL_MS = 200;
const SESSION_TOKEN_TTL_SEC = 12 * 60 * 60; // 12 hours — one event day
const PIN_RATE_WINDOW_SEC = 60;
const PIN_RATE_MAX_ATTEMPTS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  // 24 bytes → 48 hex chars; sufficient for a session token
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// PIN storage (KV keys: `pin:<slug>` → {hash, salt, createdAt})
// Session token storage (KV keys: `sess:<token>` → {slug, issuedAt}, TTL)
// Rate-limit storage (KV keys: `rl:<ip>:<slug>` → count, short TTL)
// ─────────────────────────────────────────────────────────────────────────────

interface StoredPin {
  hash: string;
  salt: string;
  createdAt: number;
}

async function hashPin(pin: string, salt: string): Promise<string> {
  // SHA-256(salt + ":" + pin). Not argon2 — Workers crypto doesn't expose it —
  // but a long random salt + rate-limit on /pin/verify makes offline attack
  // infeasible for the threat model (leaked KV dump). PINs are short-lived anyway.
  return await sha256Hex(`${salt}:${pin}`);
}

async function getStoredPin(env: Env, slug: string): Promise<StoredPin | null> {
  const raw = await env.TOURNEY_KV.get(`pin:${slug}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredPin; } catch { return null; }
}

async function setStoredPin(env: Env, slug: string, pin: string): Promise<void> {
  const salt = randomToken();
  const hash = await hashPin(pin, salt);
  const entry: StoredPin = { hash, salt, createdAt: Date.now() };
  await env.TOURNEY_KV.put(`pin:${slug}`, JSON.stringify(entry));
}

async function issueSession(env: Env, slug: string): Promise<string> {
  const token = randomToken();
  await env.TOURNEY_KV.put(
    `sess:${token}`,
    JSON.stringify({ slug, issuedAt: Date.now() }),
    { expirationTtl: SESSION_TOKEN_TTL_SEC }
  );
  return token;
}

async function sessionValidFor(env: Env, token: string, slug: string): Promise<boolean> {
  if (!token) return false;
  const raw = await env.TOURNEY_KV.get(`sess:${token}`);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { slug: string };
    return parsed.slug === slug;
  } catch { return false; }
}

async function rateCheck(env: Env, ip: string, slug: string): Promise<boolean> {
  const key = `rl:${ip}:${slug}`;
  const existing = await env.TOURNEY_KV.get(key);
  const count = existing ? parseInt(existing, 10) || 0 : 0;
  if (count >= PIN_RATE_MAX_ATTEMPTS) return false;
  await env.TOURNEY_KV.put(key, String(count + 1), { expirationTtl: PIN_RATE_WINDOW_SEC });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────────────

// GET /?slug=X — proxy Challonge participants, 30-min KV cache.
async function handleTournamentFetch(env: Env, slug: string): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);

  // Cache hit?
  const cached = await env.TOURNEY_KV.get(`tourney:${slug}`);
  if (cached) {
    try {
      const entry = JSON.parse(cached) as { participants: unknown[]; fetchedAt: number };
      if (Date.now() - entry.fetchedAt < TOURNAMENT_CACHE_TTL_MS) {
        return jsonResponse({ participants: entry.participants, fromCache: true });
      }
    } catch { /* fall through to fresh fetch */ }
  }

  // Fresh fetch from Challonge.
  const url = `https://api.challonge.com/v1/tournaments/${encodeURIComponent(slug)}/participants.json?api_key=${env.CHALLONGE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ errors: [`Challonge HTTP ${res.status}: ${text.slice(0, 200)}`] }, res.status);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    return jsonResponse({ errors: ["unexpected Challonge response"] }, 502);
  }

  // Write cache.
  await env.TOURNEY_KV.put(
    `tourney:${slug}`,
    JSON.stringify({ participants: data, fetchedAt: Date.now() }),
    { expirationTtl: Math.ceil(TOURNAMENT_CACHE_TTL_MS / 1000) + 60 }
  );
  // Also refresh the list-metadata key (single small blob so /list is O(1)).
  await refreshListMetadata(env, slug, data.length);

  return jsonResponse({ participants: data, fromCache: false });
}

// GET /list — returns small metadata blob so /list is O(1) regardless of cache size.
interface ListEntry {
  slug: string;
  participantCount: number;
  fetchedAt: number;
}
async function refreshListMetadata(env: Env, slug: string, count: number): Promise<void> {
  const raw = await env.TOURNEY_KV.get("list:meta");
  let entries: ListEntry[] = [];
  if (raw) {
    try { entries = JSON.parse(raw) as ListEntry[]; } catch { /* ignore */ }
  }
  // Upsert
  const now = Date.now();
  entries = entries.filter(e => e.slug !== slug && now - e.fetchedAt < TOURNAMENT_CACHE_TTL_MS);
  entries.push({ slug, participantCount: count, fetchedAt: now });
  await env.TOURNEY_KV.put("list:meta", JSON.stringify(entries));
}

async function handleList(env: Env): Promise<Response> {
  const raw = await env.TOURNEY_KV.get("list:meta");
  if (!raw) return jsonResponse({ tournaments: [] });
  try {
    const entries = JSON.parse(raw) as ListEntry[];
    const now = Date.now();
    const tournaments = entries
      .filter(e => now - e.fetchedAt < TOURNAMENT_CACHE_TTL_MS)
      .map(e => ({
        slug: e.slug,
        participantCount: e.participantCount,
        ageSeconds: Math.floor((now - e.fetchedAt) / 1000),
      }));
    return jsonResponse({ tournaments });
  } catch {
    return jsonResponse({ tournaments: [] });
  }
}

// POST /delete — remove a slug from cache entirely.
async function handleDelete(env: Env, body: unknown): Promise<Response> {
  const slug = typeof body === "object" && body !== null && "slug" in body ? String((body as { slug: unknown }).slug) : "";
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  await env.TOURNEY_KV.delete(`tourney:${slug}`);
  // Also drop from list:meta
  const raw = await env.TOURNEY_KV.get("list:meta");
  if (raw) {
    try {
      const entries = JSON.parse(raw) as ListEntry[];
      const filtered = entries.filter(e => e.slug !== slug);
      await env.TOURNEY_KV.put("list:meta", JSON.stringify(filtered));
    } catch { /* ignore */ }
  }
  return jsonResponse({ ok: true });
}

// GET /matches?slug=X — returns open Challonge matches (not complete).
async function handleMatches(env: Env, slug: string): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const url = `https://api.challonge.com/v1/tournaments/${encodeURIComponent(slug)}/matches.json?state=open&api_key=${env.CHALLONGE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ errors: [`Challonge HTTP ${res.status}: ${text.slice(0, 200)}`] }, res.status);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) return jsonResponse({ matches: [] });

  // Also need participants to resolve display names.
  const cached = await env.TOURNEY_KV.get(`tourney:${slug}`);
  const partById: Record<string, string> = {};
  if (cached) {
    try {
      const entry = JSON.parse(cached) as { participants: unknown[] };
      for (const p of entry.participants) {
        if (typeof p === "object" && p !== null && "participant" in p) {
          const pw = (p as { participant: { id?: number; display_name?: string; name?: string } }).participant;
          if (pw.id !== undefined) {
            const n = pw.display_name || pw.name || "";
            if (n) partById[String(pw.id)] = n;
          }
        }
      }
    } catch { /* ignore */ }
  }

  const matches = raw.map((m: unknown) => {
    const mw = (m as { match: { id: number; player1_id: number | null; player2_id: number | null; round: number; suggested_play_order?: number } }).match;
    return {
      id: mw.id,
      player1_id: mw.player1_id,
      player2_id: mw.player2_id,
      player1_name: mw.player1_id !== null ? partById[String(mw.player1_id)] : undefined,
      player2_name: mw.player2_id !== null ? partById[String(mw.player2_id)] : undefined,
      round: mw.round,
      suggested_play_order: mw.suggested_play_order,
    };
  });

  return jsonResponse({ matches });
}

// GET /standings?slug=X — fetch participants + all matches, aggregate into
// per-player W/L/points/SoS. Challonge's own standings computation isn't
// exposed via v1 API, so we compute it client-side-ish here.
async function handleStandings(env: Env, slug: string): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);

  // Pull participants (use cache if fresh).
  let participants: unknown[] = [];
  const cached = await env.TOURNEY_KV.get(`tourney:${slug}`);
  if (cached) {
    try {
      const entry = JSON.parse(cached) as { participants: unknown[]; fetchedAt: number };
      if (Date.now() - entry.fetchedAt < TOURNAMENT_CACHE_TTL_MS) {
        participants = entry.participants;
      }
    } catch { /* fall through */ }
  }
  if (participants.length === 0) {
    const pRes = await fetch(
      `https://api.challonge.com/v1/tournaments/${encodeURIComponent(slug)}/participants.json?api_key=${env.CHALLONGE_API_KEY}`
    );
    if (!pRes.ok) {
      const text = await pRes.text();
      return jsonResponse({ errors: [`Challonge HTTP ${pRes.status}: ${text.slice(0, 200)}`] }, pRes.status);
    }
    const data = await pRes.json();
    if (Array.isArray(data)) participants = data;
  }

  // Pull ALL matches (all states).
  const mRes = await fetch(
    `https://api.challonge.com/v1/tournaments/${encodeURIComponent(slug)}/matches.json?api_key=${env.CHALLONGE_API_KEY}`
  );
  if (!mRes.ok) {
    const text = await mRes.text();
    return jsonResponse({ errors: [`Challonge HTTP ${mRes.status}: ${text.slice(0, 200)}`] }, mRes.status);
  }
  const mRaw = await mRes.json();
  const matches = Array.isArray(mRaw) ? mRaw : [];

  // Index participants by id.
  interface PRow { id: number; name: string; wins: number; losses: number; points: number; }
  const pById = new Map<number, PRow>();
  for (const p of participants) {
    if (typeof p === "object" && p !== null && "participant" in p) {
      const pw = (p as { participant: { id?: number; display_name?: string; name?: string } }).participant;
      if (pw.id !== undefined) {
        pById.set(pw.id, {
          id: pw.id,
          name: pw.display_name || pw.name || "",
          wins: 0,
          losses: 0,
          points: 0,
        });
      }
    }
  }

  // Walk completed matches, tally.
  let totalComplete = 0;
  for (const m of matches) {
    const mw = (m as {
      match: {
        state: string;
        winner_id: number | null;
        loser_id: number | null;
        player1_id: number | null;
        player2_id: number | null;
        scores_csv?: string;
      };
    }).match;
    if (mw.state !== "complete" || !mw.winner_id || !mw.loser_id) continue;
    totalComplete++;
    const winner = pById.get(mw.winner_id);
    const loser = pById.get(mw.loser_id);
    if (winner) winner.wins += 1;
    if (loser) loser.losses += 1;
    // Accumulate total points scored per player from scores_csv.
    if (mw.scores_csv && mw.player1_id !== null && mw.player2_id !== null) {
      const p1 = pById.get(mw.player1_id);
      const p2 = pById.get(mw.player2_id);
      const setScores = mw.scores_csv.split(",").map(s => s.trim().split("-").map(Number));
      for (const [s1, s2] of setScores) {
        if (typeof s1 === "number" && !isNaN(s1) && p1) p1.points += s1;
        if (typeof s2 === "number" && !isNaN(s2) && p2) p2.points += s2;
      }
    }
  }

  // Sort: wins desc, then losses asc, then points desc.
  const standings = [...pById.values()].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    return b.points - a.points;
  });

  return jsonResponse({ standings, totalComplete, totalMatches: matches.length });
}

// POST /tournament/create — organizer-only: create a Challonge tournament
// under the shared NC BLAST account. Optionally set a PIN and mark approval mode.
async function handleTournamentCreate(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as {
    masterKey?: string;
    name?: string;
    urlSlug?: string;
    tournamentType?: "single_elimination" | "double_elimination" | "round_robin" | "swiss";
    pin?: string;
    approvalMode?: boolean;
  };
  if (!constantTimeEquals(String(b.masterKey || ""), env.ORGANIZER_MASTER_KEY)) {
    return jsonResponse({ errors: ["invalid master key"] }, 401);
  }
  const name = String(b.name || "").trim();
  const urlSlug = String(b.urlSlug || "").trim();
  const tType = b.tournamentType || "swiss";
  if (!name || !urlSlug) {
    return jsonResponse({ errors: ["name and urlSlug required"] }, 400);
  }
  if (!/^[a-zA-Z0-9_-]{3,60}$/.test(urlSlug)) {
    return jsonResponse({ errors: ["urlSlug must be 3-60 chars, a-z/0-9/_/- only"] }, 400);
  }
  // Forward to Challonge.
  const form = new URLSearchParams();
  form.set("api_key", env.CHALLONGE_API_KEY);
  form.set("tournament[name]", name);
  form.set("tournament[url]", urlSlug);
  form.set("tournament[tournament_type]", tType);
  const res = await fetch("https://api.challonge.com/v1/tournaments.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const challongeBody = await res.text();
  if (!res.ok) {
    return jsonResponse({ errors: [`Challonge HTTP ${res.status}: ${challongeBody.slice(0, 300)}`] }, res.status);
  }
  // On success, optionally set PIN and approval mode.
  if (b.pin && /^[0-9]{4,8}$/.test(String(b.pin))) {
    await setStoredPin(env, urlSlug, String(b.pin));
  }
  if (b.approvalMode === true) {
    await env.TOURNEY_KV.put(`approval:${urlSlug}`, "1");
  }
  return jsonResponse({ ok: true, slug: urlSlug, url: `https://challonge.com/${urlSlug}` });
}

// POST /submit — score submission, PIN-gated.
async function handleSubmit(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) {
    return jsonResponse({ errors: ["invalid body"] }, 400);
  }
  const b = body as {
    slug?: string;
    matchId?: number;
    scores_csv?: string;
    winner_id?: number | null;
    pin?: string;
  };
  const slug = String(b.slug || "");
  const matchId = Number(b.matchId);
  const scoresCsv = String(b.scores_csv || "");
  const winnerId = b.winner_id !== undefined && b.winner_id !== null ? Number(b.winner_id) : null;

  if (!slug || !matchId || !scoresCsv) {
    return jsonResponse({ errors: ["slug, matchId, scores_csv required"] }, 400);
  }

  // PIN gate: if a PIN is configured for this tournament, require a valid
  // session token OR a valid PIN on this request. Tournaments without a
  // configured PIN are allowed through (casual / unmanaged use).
  const stored = await getStoredPin(env, slug);
  if (stored) {
    const token = request.headers.get("X-Session-Token") || "";
    const tokenOk = await sessionValidFor(env, token, slug);
    if (!tokenOk) {
      // Accept a direct PIN as fallback (e.g., if session expired mid-submit).
      if (!b.pin) {
        return jsonResponse({ errors: ["PIN required for this tournament"] }, 401);
      }
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await rateCheck(env, ip, slug))) {
        return jsonResponse({ errors: ["Too many PIN attempts; try again later"] }, 429);
      }
      const candidate = await hashPin(String(b.pin), stored.salt);
      if (!constantTimeEquals(candidate, stored.hash)) {
        return jsonResponse({ errors: ["Invalid PIN"] }, 401);
      }
    }
  }

  // Approval-mode gate: if this slug has approval mode on, queue the
  // submission for organizer review instead of forwarding to Challonge.
  const approvalOn = !!(await env.TOURNEY_KV.get(`approval:${slug}`));
  if (approvalOn) {
    await enqueuePendingSubmission(env, slug, {
      matchId,
      scoresCsv,
      winnerId,
      submittedAt: Date.now(),
      ip: request.headers.get("CF-Connecting-IP") || null,
    });
    return jsonResponse({ ok: true, pending: true, message: "Queued for organizer approval." });
  }

  // Forward to Challonge.
  const form = new URLSearchParams();
  form.set("api_key", env.CHALLONGE_API_KEY);
  form.set("match[scores_csv]", scoresCsv);
  if (winnerId !== null) form.set("match[winner_id]", String(winnerId));

  const url = `https://api.challonge.com/v1/tournaments/${encodeURIComponent(slug)}/matches/${matchId}.json`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const challongeBody = await res.text();
  if (!res.ok) {
    return jsonResponse({ errors: [`Challonge HTTP ${res.status}: ${challongeBody.slice(0, 200)}`] }, res.status);
  }
  // Best-effort parse of errors[]
  try {
    const parsed = JSON.parse(challongeBody) as unknown;
    if (typeof parsed === "object" && parsed !== null && "errors" in parsed) {
      const errs = (parsed as { errors: unknown }).errors;
      if (Array.isArray(errs) && errs.length > 0) {
        return jsonResponse({ errors: errs.map(String) }, 400);
      }
    }
  } catch { /* ignore */ }

  // Audit log (best-effort, 1-day TTL).
  await auditLog(env, slug, {
    action: "submit",
    matchId,
    scoresCsv,
    winnerId,
    ip: request.headers.get("CF-Connecting-IP") || null,
  });

  return jsonResponse({ ok: true });
}

// POST /submit-sheets — removed; Sheets submissions go direct to Apps Script from the client.
// (Future work: when migrating to a real DB, this endpoint will return.)

// POST /pin/set — organizer-only: set or update the PIN for a tournament.
async function handlePinSet(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; pin?: string; masterKey?: string };
  const slug = String(b.slug || "");
  const pin = String(b.pin || "");
  const masterKey = String(b.masterKey || "");

  if (!slug || !pin || !masterKey) {
    return jsonResponse({ errors: ["slug, pin, masterKey required"] }, 400);
  }
  if (!constantTimeEquals(masterKey, env.ORGANIZER_MASTER_KEY)) {
    return jsonResponse({ errors: ["invalid master key"] }, 401);
  }
  if (!/^[0-9]{4,8}$/.test(pin)) {
    return jsonResponse({ errors: ["PIN must be 4-8 digits"] }, 400);
  }
  await setStoredPin(env, slug, pin);
  return jsonResponse({ ok: true });
}

// POST /admin/verify — check a master key without any side effect. Used by
// the client to cache the key in sessionStorage after a single validation
// instead of making the organizer type it into every form.
async function handleAdminVerify(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { masterKey?: string };
  const masterKey = String(b.masterKey || "");
  if (!masterKey) return jsonResponse({ ok: false, errors: ["masterKey required"] }, 400);
  if (!constantTimeEquals(masterKey, env.ORGANIZER_MASTER_KEY)) {
    return jsonResponse({ ok: false, errors: ["invalid master key"] }, 401);
  }
  return jsonResponse({ ok: true });
}

// POST /pin/verify — judge verifies PIN, gets a session token on success.
async function handlePinVerify(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; pin?: string };
  const slug = String(b.slug || "");
  const pin = String(b.pin || "");
  if (!slug || !pin) return jsonResponse({ errors: ["slug, pin required"] }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await rateCheck(env, ip, slug))) {
    return jsonResponse({ ok: false, errors: ["Too many attempts; try again in a minute"] }, 429);
  }

  const stored = await getStoredPin(env, slug);
  if (!stored) {
    // Distinguish "no PIN configured" from "wrong PIN" so the client can block
    // sensibly. (No PIN configured == tournament not set up for strict mode.)
    return jsonResponse({ ok: false, reason: "no-pin" }, 404);
  }

  const candidate = await hashPin(pin, stored.salt);
  if (!constantTimeEquals(candidate, stored.hash)) {
    return jsonResponse({ ok: false, errors: ["Invalid PIN"] }, 401);
  }

  const token = await issueSession(env, slug);
  return jsonResponse({ ok: true, sessionToken: token, ttlSeconds: SESSION_TOKEN_TTL_SEC });
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay state bus
// ─────────────────────────────────────────────────────────────────────────────

async function handleOverlayPush(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slot?: number; state?: unknown };
  const slot = Number(b.slot);
  if (!slot || slot < 1 || slot > 4) return jsonResponse({ errors: ["slot 1-4 required"] }, 400);
  const etag = randomToken().slice(0, 12);
  await env.TOURNEY_KV.put(`overlay:${slot}`, JSON.stringify({ state: b.state ?? null, etag }), {
    expirationTtl: 24 * 60 * 60,
  });
  return jsonResponse({ ok: true, etag });
}

async function handleOverlayState(env: Env, slot: number): Promise<Response> {
  const raw = await env.TOURNEY_KV.get(`overlay:${slot}`);
  if (!raw) return jsonResponse({ etag: null, state: null });
  try {
    const parsed = JSON.parse(raw);
    return jsonResponse(parsed);
  } catch {
    return jsonResponse({ etag: null, state: null });
  }
}

async function handleOverlayPoll(env: Env, slot: number, clientEtag: string): Promise<Response> {
  const deadline = Date.now() + OVERLAY_LONG_POLL_MS;
  while (Date.now() < deadline) {
    const raw = await env.TOURNEY_KV.get(`overlay:${slot}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { state: unknown; etag: string };
        if (parsed.etag !== clientEtag) {
          return jsonResponse(parsed);
        }
      } catch { /* treat as no-change */ }
    }
    await new Promise(r => setTimeout(r, OVERLAY_POLL_INTERVAL_MS));
  }
  // Timed out with no change — return same etag so client knows nothing new.
  return jsonResponse({ etag: clientEtag, state: null, noChange: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Combo cache
// ─────────────────────────────────────────────────────────────────────────────

async function handleCombosPush(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { player?: string; combos?: unknown[]; updatedAt?: number };
  const player = String(b.player || "").trim();
  if (!player || !Array.isArray(b.combos)) return jsonResponse({ errors: ["player + combos required"] }, 400);
  await env.TOURNEY_KV.put(
    `combos:${player}`,
    JSON.stringify({ combos: b.combos, updatedAt: b.updatedAt || Date.now() }),
    { expirationTtl: 24 * 60 * 60 }
  );
  return jsonResponse({ ok: true });
}

async function handleCombosGet(env: Env, player: string): Promise<Response> {
  if (!player) return jsonResponse({ errors: ["player required"] }, 400);
  const raw = await env.TOURNEY_KV.get(`combos:${player}`);
  if (!raw) return jsonResponse({ combos: [], updatedAt: 0 });
  try { return jsonResponse(JSON.parse(raw)); }
  catch { return jsonResponse({ combos: [], updatedAt: 0 }); }
}

// POST /combos/prereg — player: submit their 3 combos for a specific
// tournament slug. No PIN gate (the player has to know the slug + their name;
// malicious prereg-flooding is low-severity). Rate-limited per IP per slug.
// body: {slug, playerName, combos: Combo[]}
async function handleCombosPrereg(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; playerName?: string; combos?: unknown };
  const slug = String(b.slug || "").trim();
  const playerName = String(b.playerName || "").trim();
  if (!slug || !playerName || !Array.isArray(b.combos)) {
    return jsonResponse({ errors: ["slug, playerName, combos required"] }, 400);
  }
  if (b.combos.length !== 3) {
    return jsonResponse({ errors: ["exactly 3 combos required"] }, 400);
  }
  // Rate limit against the same rate-limit bucket used elsewhere.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await rateCheck(env, ip, `prereg:${slug}`))) {
    return jsonResponse({ errors: ["Too many prereg attempts; try again later"] }, 429);
  }
  const key = `prereg:${slug}:${playerName.toLowerCase()}`;
  await env.TOURNEY_KV.put(
    key,
    JSON.stringify({ playerName, combos: b.combos, submittedAt: Date.now() }),
    { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
  );
  return jsonResponse({ ok: true });
}

// GET /combos/prereg?slug=X&player=Y — retrieve a player's preregistered combos.
async function handleCombosPreregGet(env: Env, slug: string, player: string): Promise<Response> {
  if (!slug || !player) return jsonResponse({ errors: ["slug, player required"] }, 400);
  const raw = await env.TOURNEY_KV.get(`prereg:${slug}:${player.toLowerCase()}`);
  if (!raw) return jsonResponse({ combos: null });
  try { return jsonResponse(JSON.parse(raw)); }
  catch { return jsonResponse({ combos: null }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval queue (pending submissions per-slug)
// ─────────────────────────────────────────────────────────────────────────────

interface PendingSubmission {
  id: string; // random, used for approve/reject by id
  matchId: number;
  scoresCsv: string;
  winnerId: number | null;
  submittedAt: number;
  ip: string | null;
}

async function enqueuePendingSubmission(
  env: Env,
  slug: string,
  sub: Omit<PendingSubmission, "id">
): Promise<string> {
  const id = randomToken().slice(0, 16);
  const key = `pending:${slug}`;
  const raw = await env.TOURNEY_KV.get(key);
  let list: PendingSubmission[] = [];
  if (raw) {
    try { list = JSON.parse(raw); } catch { /* ignore */ }
  }
  // Cap at 100 pending per slug to avoid unbounded growth.
  list = [...list, { id, ...sub }].slice(-100);
  await env.TOURNEY_KV.put(key, JSON.stringify(list), { expirationTtl: 7 * 24 * 60 * 60 });
  return id;
}

async function listPendingSubmissions(env: Env, slug: string): Promise<PendingSubmission[]> {
  const raw = await env.TOURNEY_KV.get(`pending:${slug}`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function removePendingSubmission(env: Env, slug: string, id: string): Promise<PendingSubmission | null> {
  const list = await listPendingSubmissions(env, slug);
  const found = list.find(p => p.id === id) || null;
  const remaining = list.filter(p => p.id !== id);
  await env.TOURNEY_KV.put(`pending:${slug}`, JSON.stringify(remaining), { expirationTtl: 7 * 24 * 60 * 60 });
  return found;
}

// POST /approval/set — organizer: toggle approval mode for a slug.
// body: {slug, enabled, masterKey}
async function handleApprovalSet(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; enabled?: boolean; masterKey?: string };
  if (!constantTimeEquals(String(b.masterKey || ""), env.ORGANIZER_MASTER_KEY)) {
    return jsonResponse({ errors: ["invalid master key"] }, 401);
  }
  const slug = String(b.slug || "");
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  if (b.enabled) await env.TOURNEY_KV.put(`approval:${slug}`, "1");
  else await env.TOURNEY_KV.delete(`approval:${slug}`);
  return jsonResponse({ ok: true, enabled: !!b.enabled });
}

// GET /approval/status?slug=X — is approval mode on? (no auth needed; public)
async function handleApprovalStatus(env: Env, slug: string): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const enabled = !!(await env.TOURNEY_KV.get(`approval:${slug}`));
  return jsonResponse({ enabled });
}

// POST /approval/list — organizer: list pending submissions for a slug.
// body: {slug, masterKey}
async function handleApprovalList(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; masterKey?: string };
  if (!constantTimeEquals(String(b.masterKey || ""), env.ORGANIZER_MASTER_KEY)) {
    return jsonResponse({ errors: ["invalid master key"] }, 401);
  }
  const slug = String(b.slug || "");
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const pending = await listPendingSubmissions(env, slug);
  return jsonResponse({ pending });
}

// POST /approval/decide — organizer: approve (forward to Challonge) or reject
// a pending submission. body: {slug, id, decision: "approve"|"reject", masterKey}
async function handleApprovalDecide(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; id?: string; decision?: string; masterKey?: string };
  if (!constantTimeEquals(String(b.masterKey || ""), env.ORGANIZER_MASTER_KEY)) {
    return jsonResponse({ errors: ["invalid master key"] }, 401);
  }
  const slug = String(b.slug || "");
  const id = String(b.id || "");
  const decision = b.decision === "approve" ? "approve" : "reject";
  if (!slug || !id) return jsonResponse({ errors: ["slug, id required"] }, 400);
  const sub = await removePendingSubmission(env, slug, id);
  if (!sub) return jsonResponse({ errors: ["not found"] }, 404);
  if (decision === "reject") {
    await auditLog(env, slug, { action: "reject", matchId: sub.matchId, scoresCsv: sub.scoresCsv });
    return jsonResponse({ ok: true, decision: "reject" });
  }
  // Approve: forward to Challonge.
  const form = new URLSearchParams();
  form.set("api_key", env.CHALLONGE_API_KEY);
  form.set("match[scores_csv]", sub.scoresCsv);
  if (sub.winnerId !== null) form.set("match[winner_id]", String(sub.winnerId));
  const url = `https://api.challonge.com/v1/tournaments/${encodeURIComponent(slug)}/matches/${sub.matchId}.json`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const challongeBody = await res.text();
  if (!res.ok) {
    // Re-queue on failure so organizer can retry.
    await enqueuePendingSubmission(env, slug, {
      matchId: sub.matchId,
      scoresCsv: sub.scoresCsv,
      winnerId: sub.winnerId,
      submittedAt: sub.submittedAt,
      ip: sub.ip,
    });
    return jsonResponse({ errors: [`Challonge HTTP ${res.status}: ${challongeBody.slice(0, 200)}`] }, res.status);
  }
  await auditLog(env, slug, { action: "approve", matchId: sub.matchId, scoresCsv: sub.scoresCsv });
  return jsonResponse({ ok: true, decision: "approve" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log (append-only, capped, per slug)
// ─────────────────────────────────────────────────────────────────────────────

async function auditLog(env: Env, slug: string, entry: Record<string, unknown>): Promise<void> {
  const key = `audit:${slug}`;
  const raw = await env.TOURNEY_KV.get(key);
  let log: Record<string, unknown>[] = [];
  if (raw) {
    try { log = JSON.parse(raw); } catch { /* ignore */ }
  }
  log.push({ ...entry, ts: Date.now() });
  // Cap at last 200 entries per slug.
  if (log.length > 200) log = log.slice(-200);
  await env.TOURNEY_KV.put(key, JSON.stringify(log), {
    expirationTtl: 24 * 60 * 60, // 24h
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const method = request.method;

    // Parse body for POSTs once (safe even if unused).
    let body: unknown = null;
    if (method === "POST") {
      try { body = await request.json(); }
      catch { body = null; }
    }

    try {
      // Legacy root route: GET /?slug=X → tournament fetch
      if (url.pathname === "/" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleTournamentFetch(env, slug);
      }

      if (url.pathname === "/list" && method === "GET") {
        return await handleList(env);
      }
      if (url.pathname === "/delete" && method === "POST") {
        return await handleDelete(env, body);
      }
      if (url.pathname === "/matches" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleMatches(env, slug);
      }
      if (url.pathname === "/standings" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleStandings(env, slug);
      }
      if (url.pathname === "/submit" && method === "POST") {
        return await handleSubmit(request, env, body);
      }
      if (url.pathname === "/pin/set" && method === "POST") {
        return await handlePinSet(env, body);
      }
      if (url.pathname === "/admin/verify" && method === "POST") {
        return await handleAdminVerify(env, body);
      }
      if (url.pathname === "/tournament/create" && method === "POST") {
        return await handleTournamentCreate(env, body);
      }
      if (url.pathname === "/approval/set" && method === "POST") {
        return await handleApprovalSet(env, body);
      }
      if (url.pathname === "/approval/status" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleApprovalStatus(env, slug);
      }
      if (url.pathname === "/approval/list" && method === "POST") {
        return await handleApprovalList(env, body);
      }
      if (url.pathname === "/approval/decide" && method === "POST") {
        return await handleApprovalDecide(env, body);
      }
      if (url.pathname === "/pin/verify" && method === "POST") {
        return await handlePinVerify(request, env, body);
      }
      if (url.pathname === "/overlay/push" && method === "POST") {
        return await handleOverlayPush(env, body);
      }
      if (url.pathname === "/overlay/state" && method === "GET") {
        const slot = Number(url.searchParams.get("slot") || "0");
        if (!slot) return jsonResponse({ errors: ["slot required"] }, 400);
        return await handleOverlayState(env, slot);
      }
      if (url.pathname === "/overlay/poll" && method === "GET") {
        const slot = Number(url.searchParams.get("slot") || "0");
        const etag = url.searchParams.get("etag") || "";
        if (!slot) return jsonResponse({ errors: ["slot required"] }, 400);
        return await handleOverlayPoll(env, slot, etag);
      }
      if (url.pathname === "/combos/push" && method === "POST") {
        return await handleCombosPush(env, body);
      }
      if (url.pathname === "/combos/get" && method === "GET") {
        const player = url.searchParams.get("player") || "";
        return await handleCombosGet(env, player);
      }
      if (url.pathname === "/combos/prereg" && method === "POST") {
        return await handleCombosPrereg(request, env, body);
      }
      if (url.pathname === "/combos/prereg" && method === "GET") {
        const s = url.searchParams.get("slug") || "";
        const p = url.searchParams.get("player") || "";
        return await handleCombosPreregGet(env, s, p);
      }

      return jsonResponse({ errors: ["route not found"] }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return jsonResponse({ errors: [msg] }, 500);
    }
  },
};

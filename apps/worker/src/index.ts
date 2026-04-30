/**
 * NC BLAST Cloudflare Worker — Challonge proxy + Overlay state bus + PIN auth.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /?slug=X                  → Challonge participants (proxied + 30-min KV cached)
 *   GET  /list                     → cached tournaments metadata (slug, count, ageSeconds)
 *   POST /delete                   → remove a slug from cache (body: {slug})
 *   GET  /matches?slug=X           → open Challonge matches for slug
 *   POST /submit                   → submit a match score to Challonge (gated by PIN in tournament mode)
 *                                     body: {slug, matchId, scores_csv, winner_id, pin?}
 *   POST /overlay/push             → write overlay state for a slot (body: {slot, state})
 *   GET  /overlay/poll?slot=N&etag=X → long-poll overlay state (30s timeout)
 *   GET  /overlay/state?slot=N     → current overlay state (one-shot)
 *   POST /combos/push              → cache a player's combos (body: {player, combos, updatedAt})
 *   GET  /combos/get?player=X      → fetch a player's cached combos
 *
 *   Auth-related:
 *   POST /pin/set                  → organizer: set/update tournament PIN
 *                                     body: {slug, pin, masterKey}
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
      if (url.pathname === "/submit" && method === "POST") {
        return await handleSubmit(request, env, body);
      }
      if (url.pathname === "/pin/set" && method === "POST") {
        return await handlePinSet(env, body);
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

      return jsonResponse({ errors: ["route not found"] }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return jsonResponse({ errors: [msg] }, 500);
    }
  },
};

/**
 * NC BLAST Cloudflare Worker — Challonge proxy + Overlay state bus + PIN auth.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /?slug=X                  → Challonge participants (proxied + 30-min KV cached)
 *   GET  /list                     → cached tournaments metadata (slug, count, ageSeconds)
 *   POST /delete                   → remove a slug from cache (body: {slug})
 *   GET  /matches?slug=X           → open Challonge matches for slug
 *   GET  /pairings?slug=X[&bypass_cache=1] → ALL Challonge matches (incl. complete)
 *   GET  /standings?slug=X         → aggregated per-player W/L/points standings
 *   POST /submit                   → submit a match score to Challonge (gated by PIN in tournament mode)
 *                                     body: {slug, matchId, scores_csv, winner_id, pin?}
 *   POST /overlay/push             → write overlay state for a slot (body: {slot, state})
 *   GET  /overlay/poll?slot=N&etag=X → long-poll overlay state (30s timeout)
 *   GET  /overlay/all              → snapshot of all 4 overlay slots (org dashboard)
 *   POST /pings/send               → judge: send attention ping (body: {slug, judge?, p1?, p2?, comment?})
 *   GET  /pings/poll?slug=X&after=<ms> → org: fetch new pings since `after`
 *   POST /pings/dismiss            → org: ack a ping (body: {slug, id})
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
 *   POST /scorelog/push            → judge: append finalized match (body: {slug, judge, p1, p2, p1Sets, p2Sets, winner, challongeMatchId?, scoredAt?})
 *   GET  /scorelog/list?slug=X     → organizer: list score-log entries (newest first)
 *   GET  /judges/get?slug=X        → public: read org meta (orgUsername, headJudges, loginMode)
 *   POST /judges/set               → owner/master: replace head-judge list (body: {slug, headJudges, masterKey?})
 *   POST /org/tournament/set-owner → master-key: emergency-claim ownership (body: {slug, orgUsername, masterKey?})
 *   POST /org/tournament/set-login-mode → owner/master: solo or duo (body: {slug, loginMode, masterKey?})
 *   GET  /judge-whitelist/get?slug=X    → owner-side read of allowed-judge usernames
 *   POST /judge-whitelist/set            → owner/master: replace whitelist (body: {slug, usernames, masterKey?})
 *   GET  /judge-whitelist/check?slug=X&username=Y → public yes/no for judge login UI
 *   GET  /judge-namemap            → public read of global judge-username → bracket-name map
 *   POST /judge-namemap            → master: replace global name map (body: {map, masterKey?})
 *   GET  /stadium-assign?slug=X    → public read of {count, assign} for a tournament
 *   POST /stadium-assign           → master: replace stadium doc (body: {slug, count, assign, masterKey?})
 *
 *   Auth-related:
 *   POST /pin/set                  → organizer: set/update tournament PIN
 *                                     body: {slug, pin, masterKey}
 *   POST /admin/verify             → organizer: verify master key (no side effects)
 *   GET  /auth/authorize-url       → OAuth: build Challonge authorize URL (client_id server-side)
 *   POST /auth/exchange            → OAuth: exchange code for opaque token (body: {code, redirect_uri})
 *   POST /auth/me                  → OAuth: resolve username from opaque token (body: {token})
 *   POST /org/verify               → OAuth: revalidate token + username (body: {token, username})
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
  CHALLONGE_OAUTH_CLIENT_ID: string;
  CHALLONGE_OAUTH_CLIENT_SECRET: string;
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

// GET /?slug=X[&bypass_cache=1] — proxy Challonge participants, 30-min KV cache.
// When bypass_cache=1 is passed, refetches from Challonge and rewrites the cache,
// returning fromCache:false. Used by the org "Refresh Roster" button.
async function handleTournamentFetch(env: Env, slug: string, bypassCache: boolean): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);

  // Cache hit? — only consulted when caller hasn't asked us to bypass.
  if (!bypassCache) {
    const cached = await env.TOURNEY_KV.get(`tourney:${slug}`);
    if (cached) {
      try {
        const entry = JSON.parse(cached) as { participants: unknown[]; fetchedAt: number };
        if (Date.now() - entry.fetchedAt < TOURNAMENT_CACHE_TTL_MS) {
          return jsonResponse({ participants: entry.participants, fromCache: true });
        }
      } catch { /* fall through to fresh fetch */ }
    }
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

// GET /pairings?slug=X[&bypass_cache=1] — returns ALL Challonge matches with
// state, scores, and resolved player names. Cached for 30s by default. Used by
// the org dashboard to show round progress, build name pools, and seed the
// match-call queues. Differs from /matches by including completed matches and
// the full state field, and by caching aggressively.
async function handlePairings(env: Env, slug: string, bypassCache: boolean): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);

  // Cache hit (30s TTL) — pairings change with each Challonge submit so we
  // refresh more often than the participant cache (30min).
  const PAIRINGS_TTL_MS = 30_000;
  if (!bypassCache) {
    const cached = await env.TOURNEY_KV.get(`pairings:${slug}`);
    if (cached) {
      try {
        const entry = JSON.parse(cached) as { pairings: unknown[]; fetchedAt: number };
        if (Date.now() - entry.fetchedAt < PAIRINGS_TTL_MS) {
          return jsonResponse({ pairings: entry.pairings, fromCache: true });
        }
      } catch { /* fall through */ }
    }
  }

  // Fresh fetch — note we do NOT filter by state, so this returns everything.
  const url = `https://api.challonge.com/v1/tournaments/${encodeURIComponent(slug)}/matches.json?api_key=${env.CHALLONGE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ errors: [`Challonge HTTP ${res.status}: ${text.slice(0, 200)}`] }, res.status);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) return jsonResponse({ pairings: [], fromCache: false });

  // Resolve participant names from the participant cache. If the participant
  // cache is empty, we'll return id-only matches; the caller can refetch
  // participants first via /?slug=&bypass_cache=1.
  const partRaw = await env.TOURNEY_KV.get(`tourney:${slug}`);
  const partById: Record<string, string> = {};
  if (partRaw) {
    try {
      const entry = JSON.parse(partRaw) as { participants: unknown[] };
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

  const pairings = raw.map((m: unknown) => {
    const mw = (m as { match: { id: number; player1_id: number | null; player2_id: number | null; round: number; state: string; scores_csv?: string; winner_id?: number | null; suggested_play_order?: number } }).match;
    return {
      id: mw.id,
      player1_id: mw.player1_id,
      player2_id: mw.player2_id,
      player1_name: mw.player1_id !== null ? partById[String(mw.player1_id)] : null,
      player2_name: mw.player2_id !== null ? partById[String(mw.player2_id)] : null,
      round: mw.round,
      state: mw.state,
      scores_csv: mw.scores_csv,
      winner_id: mw.winner_id,
      suggested_play_order: mw.suggested_play_order,
    };
  });

  await env.TOURNEY_KV.put(
    `pairings:${slug}`,
    JSON.stringify({ pairings, fetchedAt: Date.now() }),
    { expirationTtl: 60 } // 60s KV TTL — slightly longer than the in-memory check
  );

  return jsonResponse({ pairings, fromCache: false });
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
async function handleTournamentCreate(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as {
    masterKey?: string;
    name?: string;
    urlSlug?: string;
    tournamentType?: "single_elimination" | "double_elimination" | "round_robin" | "swiss";
    pin?: string;
    approvalMode?: boolean;
  };
  // Auth: OAuth user OR master-key. Tournament-create is not slug-scoped
  // (the slug doesn't exist yet), so use requireOrgAuth (any authed org).
  // After creation, the org:meta orgUsername is set to the creator below.
  const auth = await requireOrgAuth(env, request, body);
  if (auth instanceof Response) return auth;
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
  // Record the creator as the org owner — sets org:meta:<slug>.orgUsername
  // so subsequent owner-only writes (judges/whitelist/login-mode/stadium)
  // recognize this user. Master-key creates skip this step (no real user).
  if (!auth.viaMasterKey) {
    const meta = await readOrgMeta(env, urlSlug);
    meta.orgUsername = auth.username;
    await writeOrgMeta(env, urlSlug, meta);
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
async function handlePinSet(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; pin?: string; masterKey?: string };
  const slug = String(b.slug || "");
  const pin = String(b.pin || "");

  if (!slug || !pin) {
    return jsonResponse({ errors: ["slug and pin required"] }, 400);
  }
  if (!/^[0-9]{4,8}$/.test(pin)) {
    return jsonResponse({ errors: ["PIN must be 4-8 digits"] }, 400);
  }
  // Auth: OAuth owner/head-judge OR master-key.
  const auth = await requireOrgOwnerOrHeadJudge(env, request, body, slug);
  if (auth instanceof Response) return auth;
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

// GET /overlay/all — single shot snapshot of all 4 overlay slots. Used by
// the org dashboard to show "LIVE" badges, current scores, and judge chips
// across every broadcast match. Polled every 5s on the org side; cheap because
// it's just 4 KV reads. Returns { slots: Array<{slot, state, etag}> }.
const OVERLAY_SLOT_COUNT = 4;
async function handleOverlayAll(env: Env): Promise<Response> {
  const slots: Array<{ slot: number; state: unknown; etag: string | null }> = [];
  for (let i = 1; i <= OVERLAY_SLOT_COUNT; i++) {
    const raw = await env.TOURNEY_KV.get(`overlay:${i}`);
    if (!raw) {
      slots.push({ slot: i, state: null, etag: null });
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { state: unknown; etag: string };
      slots.push({ slot: i, state: parsed.state, etag: parsed.etag });
    } catch {
      slots.push({ slot: i, state: null, etag: null });
    }
  }
  return jsonResponse({ slots });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pings — judge → organizer attention requests (per slug, queued)
// ─────────────────────────────────────────────────────────────────────────────

interface Ping {
  id: string;
  judge: string;
  p1: string;
  p2: string;
  comment: string;
  sentAt: number;
}

const PINGS_CAP = 50;
const PINGS_TTL_SEC = 6 * 60 * 60; // 6h — pings are ephemeral

async function readPings(env: Env, slug: string): Promise<Ping[]> {
  const raw = await env.TOURNEY_KV.get(`pings:${slug}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Ping[]) : [];
  } catch {
    return [];
  }
}

async function writePings(env: Env, slug: string, list: Ping[]): Promise<void> {
  const trimmed = list.length > PINGS_CAP ? list.slice(-PINGS_CAP) : list;
  await env.TOURNEY_KV.put(`pings:${slug}`, JSON.stringify(trimmed), { expirationTtl: PINGS_TTL_SEC });
}

// POST /pings/send — judge calls this when they need the TO's attention.
// Body: { slug, judge?, p1?, p2?, comment? }. Best-effort and rate-limited.
async function handlePingsSend(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; judge?: string; p1?: string; p2?: string; comment?: string };
  const slug = String(b.slug || "").trim();
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);

  // Rate-limit: a judge calling the TO repeatedly should not flood the queue.
  // Reuse existing rateCheck (5/min default). Key on ip+slug+ping so it doesn't
  // collide with /pin/verify or /combos/prereg counters.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await rateCheck(env, ip, `ping:${slug}`))) {
    return jsonResponse({ errors: ["rate limit exceeded"] }, 429);
  }

  const ping: Ping = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    judge: String(b.judge || ""),
    p1: String(b.p1 || ""),
    p2: String(b.p2 || ""),
    comment: String(b.comment || ""),
    sentAt: Date.now(),
  };

  const list = await readPings(env, slug);
  list.push(ping);
  await writePings(env, slug, list);
  return jsonResponse({ ok: true, id: ping.id });
}

// GET /pings/poll?slug=X&after=<ms> — returns pings whose sentAt > after.
// The standalone uses a simple poll-and-reopen-after-2s pattern; we don't
// long-poll on the server because pings are bursty and a 2s reopen latency
// is fine. If we ever want sub-second delivery we can add a deadline loop
// like /overlay/poll.
async function handlePingsPoll(env: Env, slug: string, after: number): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const list = await readPings(env, slug);
  const fresh = list.filter((p) => p.sentAt > after);
  return jsonResponse({ pings: fresh });
}

// POST /pings/dismiss — TO acknowledges a ping; remove it from the queue.
// Body: { slug, id }. No auth (master-key-gating would be ideal but the
// standalone leaves it open and that's fine for an event-internal worker).
async function handlePingsDismiss(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; id?: string };
  const slug = String(b.slug || "").trim();
  const id = String(b.id || "").trim();
  if (!slug || !id) return jsonResponse({ errors: ["slug and id required"] }, 400);
  const list = await readPings(env, slug);
  const next = list.filter((p) => p.id !== id);
  await writePings(env, slug, next);
  return jsonResponse({ ok: true });
}

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
// body: {slug, enabled, masterKey?} OR X-Auth-Token header.
async function handleApprovalSet(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; enabled?: boolean; masterKey?: string };
  const slug = String(b.slug || "");
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const auth = await requireOrgOwnerOrHeadJudge(env, request, body, slug);
  if (auth instanceof Response) return auth;
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
// body: {slug, masterKey?} OR X-Auth-Token header.
async function handleApprovalList(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; masterKey?: string };
  const slug = String(b.slug || "");
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const auth = await requireOrgOwnerOrHeadJudge(env, request, body, slug);
  if (auth instanceof Response) return auth;
  const pending = await listPendingSubmissions(env, slug);
  return jsonResponse({ pending });
}

// POST /approval/decide — organizer: approve (forward to Challonge) or reject
// a pending submission. body: {slug, id, decision: "approve"|"reject", masterKey?}
// OR X-Auth-Token header.
async function handleApprovalDecide(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; id?: string; decision?: string; masterKey?: string };
  const slug = String(b.slug || "");
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const auth = await requireOrgOwnerOrHeadJudge(env, request, body, slug);
  if (auth instanceof Response) return auth;
  const id = String(b.id || "");
  const decision = b.decision === "approve" ? "approve" : "reject";
  if (!id) return jsonResponse({ errors: ["id required"] }, 400);
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
// ─────────────────────────────────────────────────────────────────────────────
// OAuth — Challonge Authorization Code Grant + opaque org-auth tokens
//
// Flow (mirrors standalone NC BLAST OAuth implementation):
//   1. Client GETs /auth/authorize-url with redirect_uri + state → Worker
//      builds the Challonge authorize URL with client_id baked in server-side
//      (keeps client_id off the public client bundle).
//   2. User authorizes on Challonge; Challonge redirects back to the
//      registered redirect URI with ?code=&state=.
//   3. Client POSTs /auth/exchange {code, redirect_uri} → Worker exchanges
//      code for Challonge access_token via client_secret, fetches Challonge
//      /me to resolve username, mints an opaque ncblast-auth-token, stores
//      org:auth:<token> KV with {username, issuedAt} (12h TTL), returns
//      {ok, access_token: <opaque>, username}.
//   4. Client POSTs /org/verify {token, username} → Worker confirms the token
//      still resolves and matches the claimed username. Used both right after
//      login (whitelist check) and on every page-load to revalidate session.
//
// The opaque ncblast-auth-token is what other Worker endpoints accept as
// `X-Auth-Token`. The raw Challonge access_token is NEVER returned to the
// client — we keep it server-side in case we later need to call Challonge
// APIs on the user's behalf. For now /me is the only Challonge-API call.
// ─────────────────────────────────────────────────────────────────────────────

interface OrgAuthRecord {
  username: string;
  /** Lowercased Challonge username (canonical). */
  challongeAccessToken: string;
  issuedAt: number;
}

const ORG_AUTH_TTL_SEC = 12 * 60 * 60; // 12h — matches standalone behavior
const ORG_AUTH_TTL_MS = ORG_AUTH_TTL_SEC * 1000;

function genOrgToken(): string {
  // 32-byte random hex — opaque to client, used as the KV key suffix.
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// GET /auth/authorize-url?redirect_uri=&response_type=code&state= →
// returns { url } that the client opens in a popup. Hides client_id server-side.
function handleAuthAuthorizeUrl(env: Env, redirectUri: string, state: string): Response {
  if (!redirectUri) return jsonResponse({ error: "redirect_uri required" }, 400);
  if (!env.CHALLONGE_OAUTH_CLIENT_ID) {
    return jsonResponse({ error: "OAuth not configured on Worker" }, 500);
  }
  const params = new URLSearchParams({
    client_id: env.CHALLONGE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    state: state || "",
  });
  // Challonge OAuth authorize endpoint per their developer docs.
  const url = `https://challonge.com/oauth/authorize?${params.toString()}`;
  return jsonResponse({ url });
}

// POST /auth/exchange — body { code, redirect_uri }. Exchanges the code for
// a Challonge access_token, resolves the username, and issues an opaque
// ncblast-auth-token. Returns { ok, access_token: <opaque>, username, error? }.
async function handleAuthExchange(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) {
    return jsonResponse({ ok: false, error: "invalid body" }, 400);
  }
  const b = body as { code?: string; redirect_uri?: string };
  const code = String(b.code || "").trim();
  const redirectUri = String(b.redirect_uri || "").trim();
  if (!code || !redirectUri) {
    return jsonResponse({ ok: false, error: "code and redirect_uri required" }, 400);
  }
  if (!env.CHALLONGE_OAUTH_CLIENT_ID || !env.CHALLONGE_OAUTH_CLIENT_SECRET) {
    return jsonResponse({ ok: false, error: "OAuth not configured on Worker" }, 500);
  }

  // Exchange the code with Challonge's token endpoint.
  // Per Challonge OAuth docs the body is x-www-form-urlencoded.
  const tokenForm = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.CHALLONGE_OAUTH_CLIENT_ID,
    client_secret: env.CHALLONGE_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
  });
  let tokenRes: Response;
  try {
    tokenRes = await fetch("https://api.challonge.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString(),
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: "Challonge token exchange network error" }, 502);
  }
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return jsonResponse({
      ok: false,
      error: `Challonge token exchange HTTP ${tokenRes.status}: ${text.slice(0, 200)}`,
    }, 502);
  }
  let tokenData: { access_token?: string; token_type?: string; expires_in?: number };
  try {
    tokenData = await tokenRes.json();
  } catch {
    return jsonResponse({ ok: false, error: "Challonge token exchange returned non-JSON" }, 502);
  }
  const challongeToken = String(tokenData.access_token || "").trim();
  if (!challongeToken) {
    return jsonResponse({ ok: false, error: "No access_token in Challonge response" }, 502);
  }

  // Resolve username — Challonge's v2 /me endpoint.
  let username = "";
  try {
    const meRes = await fetch("https://api.challonge.com/v2.1/me", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${challongeToken}`,
        "Accept": "application/json",
        "Authorization-Type": "v2",
      },
    });
    if (meRes.ok) {
      const meData = await meRes.json();
      // Challonge wraps in { data: { attributes: { username } } } per JSON:API.
      // Fall back to common alternate shapes if that doesn't match.
      const m = meData as Record<string, unknown>;
      const fromJsonApi = (((m.data as Record<string, unknown>)?.attributes as Record<string, unknown>)?.username) as string | undefined;
      const fromTopLevel = (m.username as string | undefined);
      const fromUser = ((m.user as Record<string, unknown>)?.username as string | undefined);
      username = String(fromJsonApi || fromTopLevel || fromUser || "").trim();
    }
  } catch { /* swallow — username remains empty */ }
  if (!username) {
    return jsonResponse({ ok: false, error: "Couldn't read username from Challonge /me" }, 502);
  }

  // Mint opaque token and persist to KV.
  const opaque = genOrgToken();
  const record: OrgAuthRecord = {
    username: username.toLowerCase(),
    challongeAccessToken: challongeToken,
    issuedAt: Date.now(),
  };
  await env.TOURNEY_KV.put(`org:auth:${opaque}`, JSON.stringify(record), {
    expirationTtl: ORG_AUTH_TTL_SEC,
  });

  return jsonResponse({ ok: true, access_token: opaque, username: record.username });
}

// POST /auth/me — body { token }. Public username-lookup endpoint kept for
// parity with the standalone client (which calls this after /auth/exchange).
async function handleAuthMe(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) {
    return jsonResponse({ ok: false, error: "invalid body" }, 400);
  }
  const b = body as { token?: string };
  const token = String(b.token || "").trim();
  if (!token) return jsonResponse({ ok: false, error: "token required" }, 400);

  const raw = await env.TOURNEY_KV.get(`org:auth:${token}`);
  if (!raw) return jsonResponse({ ok: false, error: "token unknown or expired" }, 401);
  try {
    const record = JSON.parse(raw) as OrgAuthRecord;
    return jsonResponse({ ok: true, username: record.username });
  } catch {
    return jsonResponse({ ok: false, error: "token record corrupt" }, 500);
  }
}

// POST /org/verify — body { token, username }. Confirms the token still
// resolves to the claimed username AND the user is on the org whitelist
// (which for now is simply: anyone with a valid token. Org-whitelist gating
// will be enabled by populating `org:whitelist` KV — see TODO below).
async function handleOrgVerify(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) {
    return jsonResponse({ ok: false, error: "invalid body" }, 400);
  }
  const b = body as { token?: string; username?: string };
  const token = String(b.token || "").trim();
  const claimed = String(b.username || "").trim().toLowerCase();
  if (!token) return jsonResponse({ ok: false, error: "token required" }, 400);

  const raw = await env.TOURNEY_KV.get(`org:auth:${token}`);
  if (!raw) return jsonResponse({ ok: false, error: "token unknown or expired" }, 401);
  let record: OrgAuthRecord;
  try {
    record = JSON.parse(raw) as OrgAuthRecord;
  } catch {
    return jsonResponse({ ok: false, error: "token record corrupt" }, 500);
  }
  // If client supplied a username, double-check it matches the token's record.
  // Defends against the obscure case where a client somehow holds a token but
  // is confused about which user it belongs to.
  if (claimed && claimed !== record.username) {
    return jsonResponse({ ok: false, error: "token/username mismatch" }, 401);
  }

  // TODO: when an org-whitelist is desired, check `org:whitelist` here and
  // return ok:false if record.username is not in it. For now any valid
  // Challonge login is admitted.
  return jsonResponse({ ok: true, username: record.username });
}

// requireOrgAuth — returns { username, viaMasterKey } on success, or a
// Response (already a 401) on failure. Master key path remains as a fallback
// for the existing automation flows; OAuth is the primary login.
//
// CAVEAT: this helper accepts EITHER:
//   (a) X-Auth-Token header that resolves to an org:auth:<token> KV record
//   (b) X-Master-Key header that equals env.ORGANIZER_MASTER_KEY
//
// Per-tournament ownership enforcement is the caller's responsibility — the
// caller should compare the returned username against org:meta:<slug>'s
// orgUsername or headJudges array. requireOrgAuth only proves the user is
// who they say they are; it does not prove they own the resource.
async function requireOrgAuth(env: Env, request: Request, body: unknown): Promise<{ username: string; viaMasterKey: boolean } | Response> {
  const headerAuth = request.headers.get("X-Auth-Token") || "";
  const headerMaster = request.headers.get("X-Master-Key") || "";
  // Body-level fallback for legacy clients that still send masterKey in JSON.
  const bodyMaster = (typeof body === "object" && body !== null && "masterKey" in body)
    ? String((body as { masterKey?: unknown }).masterKey || "")
    : "";

  // Master-key path — accepted from either header or body.
  if (headerMaster || bodyMaster) {
    if (!constantTimeEquals(headerMaster || bodyMaster, env.ORGANIZER_MASTER_KEY)) {
      return jsonResponse({ errors: ["invalid master key"] }, 401);
    }
    return { username: "__master__", viaMasterKey: true };
  }

  // OAuth path.
  if (headerAuth) {
    const raw = await env.TOURNEY_KV.get(`org:auth:${headerAuth}`);
    if (!raw) return jsonResponse({ errors: ["token unknown or expired"] }, 401);
    try {
      const record = JSON.parse(raw) as OrgAuthRecord;
      // Defensive expiry check (KV TTL should already have evicted, but if a
      // clock skew lets a stale record through, deny it).
      if (Date.now() - record.issuedAt > ORG_AUTH_TTL_MS) {
        return jsonResponse({ errors: ["token expired"] }, 401);
      }
      return { username: record.username, viaMasterKey: false };
    } catch {
      return jsonResponse({ errors: ["token record corrupt"] }, 500);
    }
  }

  return jsonResponse({ errors: ["unauthorized — provide X-Auth-Token or X-Master-Key"] }, 401);
}

// requireOrgOwnerOrHeadJudge — convenience wrapper for endpoints that also
// need per-tournament ownership. Returns the auth result on success or a 403
// if the authenticated user isn't the owner / head-judge / master-key.
async function requireOrgOwnerOrHeadJudge(env: Env, request: Request, body: unknown, slug: string): Promise<{ username: string; viaMasterKey: boolean } | Response> {
  const auth = await requireOrgAuth(env, request, body);
  if (auth instanceof Response) return auth;
  if (auth.viaMasterKey) return auth; // master key bypasses ownership
  if (!slug) return jsonResponse({ errors: ["slug required for ownership check"] }, 400);

  const metaRaw = await env.TOURNEY_KV.get(`org:meta:${slug}`);
  if (!metaRaw) {
    // No meta = no owner recorded yet. Master key is the only way to write.
    return jsonResponse({ errors: ["tournament has no owner — use master-key claim flow"] }, 403);
  }
  try {
    const meta = JSON.parse(metaRaw) as { orgUsername?: string | null; headJudges?: string[] };
    const owner = (meta.orgUsername || "").toLowerCase();
    const headJudges = Array.isArray(meta.headJudges) ? meta.headJudges.map((u) => u.toLowerCase()) : [];
    if (owner === auth.username || headJudges.includes(auth.username)) return auth;
    return jsonResponse({ errors: ["not the tournament owner or a head judge"] }, 403);
  } catch {
    return jsonResponse({ errors: ["meta record corrupt"] }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Score log (judge accountability — append-only, capped, per slug)
// ─────────────────────────────────────────────────────────────────────────────

interface ScoreLogEntry {
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

const SCORELOG_CAP = 500;

// POST /scorelog/push — append a finalized-match record so the org can audit
// who scored what. Body: { slug, judge?, p1, p2, p1Sets, p2Sets, winner,
// challongeMatchId?, scoredAt? }. Best-effort — judge-side calls this
// fire-and-forget so we keep validation lenient and never gate on it.
async function handleScorelogPush(env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) {
    return jsonResponse({ errors: ["invalid body"] }, 400);
  }
  const b = body as {
    slug?: string;
    judge?: string;
    p1?: string;
    p2?: string;
    p1Sets?: number;
    p2Sets?: number;
    winner?: string;
    challongeMatchId?: number;
    scoredAt?: number;
  };
  const slug = String(b.slug || "").trim();
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);

  const entry: ScoreLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    p1: String(b.p1 || ""),
    p2: String(b.p2 || ""),
    p1Sets: typeof b.p1Sets === "number" ? b.p1Sets : 0,
    p2Sets: typeof b.p2Sets === "number" ? b.p2Sets : 0,
    winner: String(b.winner || ""),
    judge: String(b.judge || ""),
    challongeMatchId: typeof b.challongeMatchId === "number" ? b.challongeMatchId : undefined,
    scoredAt: typeof b.scoredAt === "number" ? b.scoredAt : Date.now(),
  };

  const key = `scorelog:${slug}`;
  const raw = await env.TOURNEY_KV.get(key);
  let entries: ScoreLogEntry[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed as ScoreLogEntry[];
    } catch { /* ignore */ }
  }
  entries.push(entry);
  if (entries.length > SCORELOG_CAP) entries = entries.slice(-SCORELOG_CAP);

  await env.TOURNEY_KV.put(key, JSON.stringify(entries), {
    // Keep the log alive for the duration of an event week-plus — 14 days.
    expirationTtl: 14 * 24 * 60 * 60,
  });

  return jsonResponse({ ok: true });
}

// GET /scorelog/list?slug=X — returns the score log entries for a tournament,
// newest first. Public read (no auth) — same access model as participants/list.
async function handleScorelogList(env: Env, slug: string): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const raw = await env.TOURNEY_KV.get(`scorelog:${slug}`);
  if (!raw) return jsonResponse({ entries: [] });
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return jsonResponse({ entries: [] });
    // Reverse so callers always get newest-first without doing it client-side.
    const sorted = (parsed as ScoreLogEntry[]).slice().sort((a, b) => b.scoredAt - a.scoredAt);
    return jsonResponse({ entries: sorted });
  } catch {
    return jsonResponse({ entries: [] });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Org meta — head judges, owner, login mode (per slug)
// Single KV doc `org:meta:<slug>` shared by F4 (login mode), F5 (head judges +
// emergency claim), and any future feature that needs per-tournament org info.
// ─────────────────────────────────────────────────────────────────────────────

interface OrgMeta {
  /** Lowercased Challonge username of the tournament owner. null until claimed. */
  orgUsername: string | null;
  /** Lowercased Challonge usernames granted head-judge privilege. */
  headJudges: string[];
  /** "solo" = each judge logs in individually. "duo" = shared tablet. null = unset. */
  loginMode: "solo" | "duo" | null;
}

async function readOrgMeta(env: Env, slug: string): Promise<OrgMeta> {
  const raw = await env.TOURNEY_KV.get(`org:meta:${slug}`);
  if (!raw) return { orgUsername: null, headJudges: [], loginMode: null };
  try {
    const parsed = JSON.parse(raw) as Partial<OrgMeta>;
    return {
      orgUsername: parsed.orgUsername || null,
      headJudges: Array.isArray(parsed.headJudges) ? parsed.headJudges : [],
      loginMode: parsed.loginMode === "solo" || parsed.loginMode === "duo" ? parsed.loginMode : null,
    };
  } catch {
    return { orgUsername: null, headJudges: [], loginMode: null };
  }
}

async function writeOrgMeta(env: Env, slug: string, meta: OrgMeta): Promise<void> {
  // No TTL — meta is event-lifecycle data and we don't want it to vanish mid-event.
  await env.TOURNEY_KV.put(`org:meta:${slug}`, JSON.stringify(meta));
}

// GET /judges/get?slug=X — public read of org meta (any client can see the
// owner + head-judge list). Standalone judge login UI calls this to know
// whether to show the owner-only controls.
async function handleJudgesGet(env: Env, slug: string): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const meta = await readOrgMeta(env, slug);
  return jsonResponse(meta);
}

// POST /judges/set — replace the head-judge list. For now, master-key-only
// (auth via X-Master-Key header OR `masterKey` in body). The standalone uses
// X-Auth-Token from OAuth; that path will be added when F2 lands.
// Body: { slug, headJudges: string[], masterKey? }
async function handleJudgesSet(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; headJudges?: unknown; masterKey?: string };

  const slug = String(b.slug || "");
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);

  // Auth: OAuth (X-Auth-Token whose username is the owner or a head-judge)
  // OR master-key (X-Master-Key header / body.masterKey). Master-key bypasses
  // ownership for emergency operations.
  const auth = await requireOrgOwnerOrHeadJudge(env, request, body, slug);
  if (auth instanceof Response) return auth;

  if (!Array.isArray(b.headJudges)) return jsonResponse({ errors: ["headJudges must be array"] }, 400);

  // Normalize: lowercase + dedupe + drop empties.
  const cleaned = Array.from(
    new Set(
      b.headJudges
        .map((u) => String(u || "").trim().toLowerCase())
        .filter((u) => u.length > 0),
    ),
  );

  const meta = await readOrgMeta(env, slug);
  meta.headJudges = cleaned;
  await writeOrgMeta(env, slug, meta);
  return jsonResponse({ ok: true, headJudges: cleaned });
}

// POST /org/tournament/set-owner — emergency-claim path. Master-key required.
// Body: { slug, orgUsername }. Sets meta.orgUsername to the provided username.
// Standalone calls this when meta.orgUsername is null and the user holds the
// master key — gives the org-account holder a way to bootstrap ownership for
// a tournament that was created before OAuth shipped.
async function handleOrgSetOwner(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; orgUsername?: string; masterKey?: string };

  const headerKey = request.headers.get("X-Master-Key") || "";
  const bodyKey = String(b.masterKey || "");
  if (!constantTimeEquals(headerKey || bodyKey, env.ORGANIZER_MASTER_KEY)) {
    return jsonResponse({ errors: ["unauthorized"] }, 401);
  }

  const slug = String(b.slug || "");
  const orgUsername = String(b.orgUsername || "").trim().toLowerCase();
  if (!slug || !orgUsername) return jsonResponse({ errors: ["slug and orgUsername required"] }, 400);

  const meta = await readOrgMeta(env, slug);
  meta.orgUsername = orgUsername;
  await writeOrgMeta(env, slug, meta);
  return jsonResponse({ ok: true, orgUsername });
}

// POST /org/tournament/set-login-mode — F4 toggle. Master-key for now.
// Body: { slug, loginMode: "solo"|"duo", masterKey? }
async function handleOrgSetLoginMode(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; loginMode?: string; masterKey?: string };

  const slug = String(b.slug || "");
  const mode = b.loginMode === "solo" || b.loginMode === "duo" ? b.loginMode : null;
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  if (!mode) return jsonResponse({ errors: ["loginMode must be 'solo' or 'duo'"] }, 400);

  // Auth: OAuth owner/head-judge OR master-key.
  const auth = await requireOrgOwnerOrHeadJudge(env, request, body, slug);
  if (auth instanceof Response) return auth;

  const meta = await readOrgMeta(env, slug);
  meta.loginMode = mode;
  await writeOrgMeta(env, slug, meta);
  return jsonResponse({ ok: true, loginMode: mode });
}

// ─────────────────────────────────────────────────────────────────────────────
// Judge whitelist (per slug) — F6
// Separate KV doc `org:judges:<slug>` — distinct from org:meta because the
// whitelist is potentially much larger and has its own update cadence.
// ─────────────────────────────────────────────────────────────────────────────

interface JudgeWhitelist {
  usernames: string[];
}

// GET /judge-whitelist/get?slug=X — owner-side read.
async function handleJudgeWhitelistGet(env: Env, slug: string): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const raw = await env.TOURNEY_KV.get(`org:judges:${slug}`);
  if (!raw) return jsonResponse({ usernames: [] });
  try {
    const parsed = JSON.parse(raw) as Partial<JudgeWhitelist>;
    return jsonResponse({ usernames: Array.isArray(parsed.usernames) ? parsed.usernames : [] });
  } catch {
    return jsonResponse({ usernames: [] });
  }
}

// POST /judge-whitelist/set — replace the whitelist. Master-key for now.
// Body: { slug, usernames: string[], masterKey? }
async function handleJudgeWhitelistSet(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; usernames?: unknown; masterKey?: string };

  const slug = String(b.slug || "");
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  if (!Array.isArray(b.usernames)) return jsonResponse({ errors: ["usernames must be array"] }, 400);

  // Auth: OAuth owner/head-judge OR master-key.
  const auth = await requireOrgOwnerOrHeadJudge(env, request, body, slug);
  if (auth instanceof Response) return auth;

  const cleaned = Array.from(
    new Set(
      b.usernames
        .map((u) => String(u || "").trim().toLowerCase())
        .filter((u) => u.length > 0),
    ),
  );

  await env.TOURNEY_KV.put(`org:judges:${slug}`, JSON.stringify({ usernames: cleaned }));
  return jsonResponse({ ok: true, usernames: cleaned });
}

// GET /judge-whitelist/check?slug=X&username=Y — public yes/no check used by
// the judge-side login UI to gate access. Returns { allowed: bool }.
async function handleJudgeWhitelistCheck(env: Env, slug: string, username: string): Promise<Response> {
  if (!slug || !username) return jsonResponse({ allowed: false });
  const raw = await env.TOURNEY_KV.get(`org:judges:${slug}`);
  if (!raw) return jsonResponse({ allowed: false });
  try {
    const parsed = JSON.parse(raw) as Partial<JudgeWhitelist>;
    const list = Array.isArray(parsed.usernames) ? parsed.usernames : [];
    return jsonResponse({ allowed: list.includes(username.trim().toLowerCase()) });
  } catch {
    return jsonResponse({ allowed: false });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Judge name map (global — persists across events) — F7
// Maps lowercased Challonge usernames → bracket display names. Single global
// KV doc rather than per-slug because a judge keeps the same Challonge↔name
// mapping across every event they work.
// ─────────────────────────────────────────────────────────────────────────────

interface JudgeNameMap {
  /** key: lowercased Challonge username, value: bracket display name as the
   *  organizer wants it shown to streamers. */
  map: Record<string, string>;
}

const NAMEMAP_KEY = "judge-namemap:global";

// GET /judge-namemap — public read so judges on every device get the same
// map without needing master-key auth.
async function handleJudgeNameMapGet(env: Env): Promise<Response> {
  const raw = await env.TOURNEY_KV.get(NAMEMAP_KEY);
  if (!raw) return jsonResponse({ map: {} });
  try {
    const parsed = JSON.parse(raw) as Partial<JudgeNameMap>;
    return jsonResponse({ map: parsed.map && typeof parsed.map === "object" ? parsed.map : {} });
  } catch {
    return jsonResponse({ map: {} });
  }
}

// POST /judge-namemap — replace the entire map. Master-key only for now.
// Body: { map: Record<string,string>, masterKey? }. Standalone uses
// X-Auth-Token; that path lands when F2 OAuth ships.
async function handleJudgeNameMapSet(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { map?: unknown; masterKey?: string };

  // Auth: OAuth (any authed org user) OR master-key. Name map is global so
  // there's no per-tournament ownership — anyone who can prove they're an
  // org admin can edit it.
  const auth = await requireOrgAuth(env, request, body);
  if (auth instanceof Response) return auth;

  if (typeof b.map !== "object" || b.map === null) {
    return jsonResponse({ errors: ["map required"] }, 400);
  }

  // Normalize: lowercase keys, drop entries with empty values.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.map as Record<string, unknown>)) {
    const key = String(k || "").trim().toLowerCase();
    const val = String(v || "").trim();
    if (key && val) cleaned[key] = val;
  }

  await env.TOURNEY_KV.put(NAMEMAP_KEY, JSON.stringify({ map: cleaned }));
  return jsonResponse({ ok: true, map: cleaned });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stadium assignment (per slug) — F10
// Maps Challonge usernames → stadium letter (A-H). Stored alongside a count
// (1-8) of how many stadiums are running. Drives station queues (F11) and
// per-match badges on the match list.
// ─────────────────────────────────────────────────────────────────────────────

interface StadiumAssign {
  count: number;
  /** key: lowercased Challonge username, value: single uppercase letter A-H */
  assign: Record<string, string>;
}

// GET /stadium-assign?slug=X — public read so judge views can show stadium
// badges without auth. Returns { data: StadiumAssign | null }.
async function handleStadiumAssignGet(env: Env, slug: string): Promise<Response> {
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);
  const raw = await env.TOURNEY_KV.get(`stadium-assign:${slug}`);
  if (!raw) return jsonResponse({ data: null });
  try {
    const parsed = JSON.parse(raw) as Partial<StadiumAssign>;
    return jsonResponse({
      data: {
        count: typeof parsed.count === "number" ? parsed.count : 0,
        assign: typeof parsed.assign === "object" && parsed.assign !== null ? parsed.assign : {},
      },
    });
  } catch {
    return jsonResponse({ data: null });
  }
}

// POST /stadium-assign — replace the assignment doc. Master-key for now.
// Body: { slug, count, assign, masterKey? }
async function handleStadiumAssignSet(request: Request, env: Env, body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return jsonResponse({ errors: ["invalid body"] }, 400);
  const b = body as { slug?: string; count?: number; assign?: unknown; masterKey?: string };

  const slug = String(b.slug || "");
  if (!slug) return jsonResponse({ errors: ["slug required"] }, 400);

  // Auth: OAuth owner/head-judge OR master-key.
  const auth = await requireOrgOwnerOrHeadJudge(env, request, body, slug);
  if (auth instanceof Response) return auth;

  const count = typeof b.count === "number" ? Math.max(1, Math.min(8, Math.floor(b.count))) : 0;
  if (typeof b.assign !== "object" || b.assign === null) {
    return jsonResponse({ errors: ["assign must be object"] }, 400);
  }

  // Normalize: lowercase keys, uppercase single-letter A-H values, drop empties.
  const validLetters = new Set(["A", "B", "C", "D", "E", "F", "G", "H"]);
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.assign as Record<string, unknown>)) {
    const key = String(k || "").trim().toLowerCase();
    const val = String(v || "").trim().toUpperCase();
    if (key && validLetters.has(val)) cleaned[key] = val;
  }

  await env.TOURNEY_KV.put(`stadium-assign:${slug}`, JSON.stringify({ count, assign: cleaned }));
  return jsonResponse({ ok: true, count, assign: cleaned });
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
        const bypass = url.searchParams.get("bypass_cache") === "1";
        return await handleTournamentFetch(env, slug, bypass);
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
      if (url.pathname === "/pairings" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        const bypass = url.searchParams.get("bypass_cache") === "1";
        return await handlePairings(env, slug, bypass);
      }
      if (url.pathname === "/standings" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleStandings(env, slug);
      }
      if (url.pathname === "/submit" && method === "POST") {
        return await handleSubmit(request, env, body);
      }
      if (url.pathname === "/pin/set" && method === "POST") {
        return await handlePinSet(request, env, body);
      }
      if (url.pathname === "/admin/verify" && method === "POST") {
        return await handleAdminVerify(env, body);
      }
      if (url.pathname === "/tournament/create" && method === "POST") {
        return await handleTournamentCreate(request, env, body);
      }

      // OAuth — F2
      if (url.pathname === "/auth/authorize-url" && method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri") || "";
        const state = url.searchParams.get("state") || "";
        return handleAuthAuthorizeUrl(env, redirectUri, state);
      }
      if (url.pathname === "/auth/exchange" && method === "POST") {
        return await handleAuthExchange(env, body);
      }
      if (url.pathname === "/auth/me" && method === "POST") {
        return await handleAuthMe(env, body);
      }
      if (url.pathname === "/org/verify" && method === "POST") {
        return await handleOrgVerify(env, body);
      }

      if (url.pathname === "/approval/set" && method === "POST") {
        return await handleApprovalSet(request, env, body);
      }
      if (url.pathname === "/approval/status" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleApprovalStatus(env, slug);
      }
      if (url.pathname === "/approval/list" && method === "POST") {
        return await handleApprovalList(request, env, body);
      }
      if (url.pathname === "/approval/decide" && method === "POST") {
        return await handleApprovalDecide(request, env, body);
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
      if (url.pathname === "/overlay/all" && method === "GET") {
        return await handleOverlayAll(env);
      }
      // Pings — judge → organizer attention requests
      if (url.pathname === "/pings/send" && method === "POST") {
        return await handlePingsSend(request, env, body);
      }
      if (url.pathname === "/pings/poll" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        const after = Number(url.searchParams.get("after") || "0");
        return await handlePingsPoll(env, slug, after);
      }
      if (url.pathname === "/pings/dismiss" && method === "POST") {
        return await handlePingsDismiss(env, body);
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

      // Score log (judge accountability)
      if (url.pathname === "/scorelog/push" && method === "POST") {
        return await handleScorelogPush(env, body);
      }
      if (url.pathname === "/scorelog/list" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleScorelogList(env, slug);
      }

      // Org meta: head judges, owner, login mode
      if (url.pathname === "/judges/get" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleJudgesGet(env, slug);
      }
      if (url.pathname === "/judges/set" && method === "POST") {
        return await handleJudgesSet(request, env, body);
      }
      if (url.pathname === "/org/tournament/set-owner" && method === "POST") {
        return await handleOrgSetOwner(request, env, body);
      }
      if (url.pathname === "/org/tournament/set-login-mode" && method === "POST") {
        return await handleOrgSetLoginMode(request, env, body);
      }

      // Judge whitelist
      if (url.pathname === "/judge-whitelist/get" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleJudgeWhitelistGet(env, slug);
      }
      if (url.pathname === "/judge-whitelist/set" && method === "POST") {
        return await handleJudgeWhitelistSet(request, env, body);
      }
      if (url.pathname === "/judge-whitelist/check" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        const username = url.searchParams.get("username") || "";
        return await handleJudgeWhitelistCheck(env, slug, username);
      }

      // Judge name map (global)
      if (url.pathname === "/judge-namemap" && method === "GET") {
        return await handleJudgeNameMapGet(env);
      }
      if (url.pathname === "/judge-namemap" && method === "POST") {
        return await handleJudgeNameMapSet(request, env, body);
      }

      // Stadium assignment (per slug)
      if (url.pathname === "/stadium-assign" && method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return await handleStadiumAssignGet(env, slug);
      }
      if (url.pathname === "/stadium-assign" && method === "POST") {
        return await handleStadiumAssignSet(request, env, body);
      }

      return jsonResponse({ errors: ["route not found"] }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return jsonResponse({ errors: [msg] }, 500);
    }
  },
};

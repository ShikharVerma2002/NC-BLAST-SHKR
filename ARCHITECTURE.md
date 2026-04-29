# NC BLAST — Architecture

A pointer file. If you're looking for "where does X live?", start here.

## Monorepo layout

```
ncblast-app/
├── apps/
│   ├── judge/              # The scoring app (most of the complexity)
│   └── overlay/            # The 1920x1080 OBS broadcast overlay
├── packages/
│   └── shared/             # Types, constants, Worker client, storage helpers
├── README.md               # Install / run / build
├── ARCHITECTURE.md         # You are here
└── package.json            # npm workspaces root
```

## Where things live

### Scoring / match state

- **`apps/judge/src/screens/MatchScreen.tsx`** — the big one (~2300 lines). Owns
  ALL match state via useState. Has a TOC comment at the top and section
  banners `═══ SECTION: ... ═══` for fast Ctrl+F navigation.
  - `doScore` — adds a battle to the log, increments sets/points, opens
    side-picker on set wins (tournament mode)
  - `undo` / `redo` — pops/pushes `log[]`, restores snapshots from `LogEntry._pp/_ps/_u1/_u2/_ls`
  - `submitChallongeScore` — POSTs the match to the Worker. Writes to the
    outbox FIRST, then fetches; removes from outbox on confirmed 2xx.
  - `pushOverlay` — fire-and-forget with latest-wins retry queue (1s/3s/8s backoff)
  - `reset` — clears match state, called from "New Match" / "Main Menu" / abandon
  - `goBack` — layered back-button handler (CX picker → picker → deck review →
    side picker → abandon modal → phase rewind → players screen)

### Data flow

```
User taps finish button
  → doScore() updates {log, pts, sets, setScores, curSet, ...}
  → sSave(KEYS.matchLog) persists log to localStorage
  → pushOverlay() → scheduleOverlayPush() → fetch /overlay/push (with retry)
  → if set-won in tournament mode: opens SidePicker modal

Match ends (sets[scorerIdx] >= need)
  → setPhase("over") → match-over screen
  → judge taps Submit in modal
  → submitChallongeScore() enqueues to outbox, POSTs /submit
  → onSendSheets() enqueues to outbox, POSTs Apps Script SHEETS_URL
  → both remove from outbox on confirmed 2xx
```

### Durable submission outbox (at-least-once delivery)

- **`apps/judge/src/submitQueue.ts`** — localStorage-backed queue.
  - `enqueue(item) -> id` — write BEFORE attempting submit (write-ahead)
  - `remove(id)` — only called after confirmed 2xx
  - `list()` — snapshot for the retry flusher
- **`apps/judge/src/App.tsx`** — owns the retry flusher.
  - Runs on mount + on `online` event + polls every 2s for the pending-pill count
  - Uses `BroadcastChannel('ncblast-queue-flush')` to avoid parallel flushes across tabs
  - Client-best-effort dedup via `wasSucceeded(id)` for 24h after delivery
  - Pending-pill floats bottom-right when queue has unflushed items

### Challonge integration

- **`packages/shared/src/worker.ts`** — the Worker client (typed fetch wrappers).
  ALL Challonge traffic goes through the Cloudflare Worker — the API key lives
  server-side as an encrypted env var.
- **`packages/shared/src/constants.ts`** — `WORKER_BASE_URL`, `OVERLAY_WORKER` alias.
  If you need a different worker instance, set `VITE_WORKER_URL` env var.

### Overlay

- **`apps/overlay/src/App.tsx`** — renders the transparent 1920×1080 scoreboard.
  Long-polls Worker `/overlay/poll` for state, displays winner-side flash,
  set/point counts, active combos.
- **`apps/overlay/src/hooks/useDraggable.ts`** — drag-to-move (mouse+touch)
- **`apps/overlay/src/hooks/useResizable.ts`** — 3-handle resize (corner/right/bottom, mouse+touch)
- **`apps/overlay/src/hooks/usePolling.ts`** — etag-based long-poll loop with reset
- All edit controls (reset button, drag handle, resize handles) only render
  when URL has `?edit=1`. OBS streams stay clean.

### Shared package (`packages/shared/src/`)

- **`types.ts`** — `LogEntry`, `Combo`, `OverlayState`, `MatchConfig`, etc.
  Changes here ripple to both apps.
- **`constants.ts`** — `FINISH`, `PENALTY`, `FINISH_LABELS`, `WORKER_BASE_URL`,
  `SHEETS_URL`, `STORAGE_KEYS` (every `bx-*` / `ncblast-*` localStorage key
  lives here as a typed const).
- **`storage.ts`** — `sGet<T>` / `sSave` wrappers around `JSON.parse` /
  `JSON.stringify` + localStorage with try/catch.
- **`worker.ts`** — Cloudflare Worker HTTP client.

### Parts library

- **`apps/judge/src/data/parts.ts`** — `DEFAULT_PARTS`, `CROSSOVER_BLADES`,
  `CX_BLADES`, `CXE_BLADES`, `CXE_OVER_BLADES`, `CX_ASSISTS` (18 canonical),
  `CX_ASSIST_TOP5`, `TOP10`, `BLADE_COLORS`, `QUICK_COMBOS`.
- **`apps/judge/src/components/LibraryManager.tsx`** — modal for managing
  user-added parts.

### In-app docs

- **`apps/judge/src/data/content.ts`** — `GUIDE_SECTIONS` and `CHANGELOG`
  rendered into modals from FormatScreen.

### Diagnostics

- **Format screen logo** — 5 rapid taps downloads `ncblast_debug_*.json`
  with all `bx-*` / `ncblast-*` localStorage + userAgent + viewport.
  Implementation lives in `FormatScreen.tsx` (search for `exportDiagnostics`).
- **Console logs** — `[Challonge submit]` and `[Challonge retry-flush]` log
  every submit / retry attempt so duplicates show up in devtools.

## localStorage keys (every one the app uses)

All keys are declared in `packages/shared/src/constants.ts` as `STORAGE_KEYS`:

| Key | Purpose |
|-----|---------|
| `bx-library-v9` | User's parts library (blades/ratchets/bits) |
| `bx-roster-v2` | Player roster |
| `bx-combos-v1` | Saved combos per player |
| `bx-matchlog-v1` | Match log (capped 500 entries) |
| `bx-match-start-idx-v1` | Index into log where current match starts |
| `bx-challonge-map-v1` | Challonge participant name→id map |
| `bx-overlay-slot-v1` | Selected stream overlay slot (0–4) |
| `bx-submit-queue-v1` | Outbox queue for Sheets/Challonge submissions |
| `ncblast-dark` | Dark mode toggle |
| `bx-challonge-cache-v1` | Device-level Challonge participant cache (30 min) |
| `ncblast-scale/pos/w/h` | Overlay drag/resize state |
| `bx-battle-sizes-v1[:judge]` | Button-size edit mode multipliers (per judge) |
| `bx-submit-succeeded-v1` | Idempotency dedup set (24h TTL, cap 50) |

## Key invariants (don't break these)

1. **Outbox write-ahead.** Every Sheets / Challonge submit must `enqueue()` to
   the outbox BEFORE attempting the network call. `remove(id)` only on confirmed
   2xx. This guarantees at-least-once delivery.
2. **`setScores` and `sets` move together.** Every set-win push to `setScores`
   is paired with a `setSets` increment in the same handler body. undo/redo
   mirror this. Breaking the pairing corrupts Challonge `scores_csv`.
3. **Log snapshots are positional (0/1 indexed by P1/P2).** When sides swap,
   the `⇄ Swap` handler flips log entry positional fields AND clears the redo
   queue AND only rewrites the CURRENT match's entries (not prior matches'
   entries in the persisted log).
4. **Challonge API key never ships client-side.** It lives on the Cloudflare
   Worker as an encrypted env var. Any change that puts it in the app bundle
   is a regression — check the built JS with `grep -c "68330566"`.
5. **`matchStartIdx` must persist.** It's loaded from `KEYS.matchStartIdx` on
   mount and saved on every transition. If it resets to 0, undo crosses match
   boundaries and CSV exports the whole log.

## When you need to...

- **Add a new localStorage key** → add to `STORAGE_KEYS` in shared/constants.ts, not inline.
- **Add a new Worker endpoint** → add a typed wrapper in shared/worker.ts, don't `fetch()` directly in components.
- **Change match scoring logic** → edit `doScore` in MatchScreen.tsx. Update `undo` + `redo` to mirror. Consider what happens on swap.
- **Add a new screen / phase** → add to the `Phase` type in MatchScreen.tsx, add an early-return block with a `// ═══ SECTION: ═══` banner.
- **Debug a production issue** → ask the judge to tap the Format-screen logo 5× and send you the debug JSON.
- **Find the biggest file** → `MatchScreen.tsx`. Use the TOC at the top + `SECTION:` banners.

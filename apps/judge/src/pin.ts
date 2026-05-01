/**
 * Tournament PIN / session token helpers.
 *
 * Flow:
 *   - Organizer calls setPin(master, slug, pin) once per tournament via the Worker.
 *   - Judges call verifyPin(slug, pin) which stores a session token in sessionStorage
 *     (NOT localStorage — clears on tab close so a shared tablet doesn't carry an
 *     authorization from one judge's session to the next).
 *   - getSessionToken(slug) returns the cached token for use in X-Session-Token headers.
 *   - Submission code must include the token (or the raw PIN) on every /submit call.
 *
 * PIN entry is blocked by the Worker's rate limit (5/min per IP per slug).
 * Tokens expire after 12h on the Worker side; we don't track expiry client-side,
 * we just retry PIN entry when a /submit comes back with HTTP 401.
 */
import { WORKER_BASE_URL } from "@ncblast/shared";

const SESSION_PREFIX = "ncblast-pin-token:";

export type PinVerifyResult =
  | { ok: true; sessionToken: string }
  | { ok: false; reason: "no-pin" | "invalid" | "rate-limit" | "network"; message: string };

export function getSessionToken(slug: string): string | null {
  if (!slug) return null;
  try {
    return sessionStorage.getItem(SESSION_PREFIX + slug);
  } catch {
    return null;
  }
}

function storeSessionToken(slug: string, token: string): void {
  try {
    sessionStorage.setItem(SESSION_PREFIX + slug, token);
  } catch {
    /* ignore */
  }
}

export function clearSessionToken(slug: string): void {
  try {
    sessionStorage.removeItem(SESSION_PREFIX + slug);
  } catch {
    /* ignore */
  }
}

/**
 * Ask the Worker to verify a PIN for a slug. On success, cache the returned
 * session token in sessionStorage.
 *
 * Special return: `reason: "no-pin"` when the tournament has no PIN configured.
 * Per the product decision ("block if no PIN configured"), callers should refuse
 * to proceed with tournament-mode submissions in that case.
 */
export async function verifyPin(slug: string, pin: string): Promise<PinVerifyResult> {
  if (!slug || !pin) {
    return { ok: false, reason: "invalid", message: "Slug and PIN required." };
  }
  try {
    const res = await fetch(`${WORKER_BASE_URL}/pin/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, pin }),
      signal: AbortSignal.timeout(8000),
    });
    const data: unknown = await res.json().catch(() => null);
    if (res.status === 429) {
      return {
        ok: false,
        reason: "rate-limit",
        message: "Too many PIN attempts. Wait a minute and try again.",
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        reason: "no-pin",
        message: "This tournament has no PIN configured. Ask the organizer to set one.",
      };
    }
    if (
      res.ok &&
      typeof data === "object" &&
      data !== null &&
      "ok" in data &&
      (data as { ok: unknown }).ok === true &&
      "sessionToken" in data &&
      typeof (data as { sessionToken: unknown }).sessionToken === "string"
    ) {
      const token = (data as { sessionToken: string }).sessionToken;
      storeSessionToken(slug, token);
      return { ok: true, sessionToken: token };
    }
    return { ok: false, reason: "invalid", message: "Invalid PIN." };
  } catch (err) {
    return {
      ok: false,
      reason: "network",
      message: "Could not reach the NC BLAST server — check your connection.",
    };
  }
}

/** Organizer-only: set or update the PIN for a tournament. */
export async function setPin(
  masterKey: string,
  slug: string,
  pin: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!masterKey || !slug || !pin) {
    return { ok: false, message: "Master key, slug, and PIN are all required." };
  }
  if (!/^[0-9]{4,8}$/.test(pin)) {
    return { ok: false, message: "PIN must be 4 to 8 digits." };
  }
  try {
    const res = await fetch(`${WORKER_BASE_URL}/pin/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, pin, masterKey }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    const data: unknown = await res.json().catch(() => null);
    const msg =
      typeof data === "object" && data !== null && "errors" in data && Array.isArray((data as { errors: unknown[] }).errors) && (data as { errors: unknown[] }).errors.length
        ? String((data as { errors: unknown[] }).errors[0])
        : `HTTP ${res.status}`;
    return { ok: false, message: msg };
  } catch {
    return { ok: false, message: "Could not reach the NC BLAST server." };
  }
}

// ─── Organizer master-key session cache ─────────────────────────────────────
// Once validated against /admin/verify, cache the key in sessionStorage so the
// organizer doesn't re-type it for every PIN/setup action. Clears on tab close.

const MASTER_KEY_STORAGE = "ncblast-org-master";

export function getCachedMasterKey(): string | null {
  try { return sessionStorage.getItem(MASTER_KEY_STORAGE); } catch { return null; }
}

export function clearCachedMasterKey(): void {
  try { sessionStorage.removeItem(MASTER_KEY_STORAGE); } catch { /* ignore */ }
}

/**
 * Verify an organizer master key against the Worker. On success, cache it in
 * sessionStorage for subsequent organizer calls.
 */
export async function verifyMasterKey(
  key: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!key) return { ok: false, message: "Master key required." };
  try {
    const res = await fetch(`${WORKER_BASE_URL}/admin/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ masterKey: key }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      try { sessionStorage.setItem(MASTER_KEY_STORAGE, key); } catch { /* ignore */ }
      return { ok: true };
    }
    if (res.status === 401) return { ok: false, message: "Invalid master key." };
    return { ok: false, message: `HTTP ${res.status}` };
  } catch {
    return { ok: false, message: "Could not reach the NC BLAST server." };
  }
}

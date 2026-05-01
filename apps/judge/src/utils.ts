import type { Combo, Finish } from "@ncblast/shared";
export { FINISH, PENALTY } from "@ncblast/shared";

export const emptyCombo = (): Combo => ({ blade: null, ratchet: null, bit: null });

export const comboStr = (c: Combo | null | undefined): string =>
  c?.blade && c?.ratchet && c?.bit ? `${c.blade} ${c.ratchet} ${c.bit}` : "—";

export const comboReady = (c: Combo | null | undefined): boolean =>
  Boolean(c?.blade && c?.ratchet && c?.bit);

/** Truncate display names longer than 15 chars to 12 + ellipsis */
export const tn = (name: string | null | undefined): string =>
  name && name.length > 15 ? name.slice(0, 12) + "…" : (name || "");

/**
 * Split a part name into display lines for buttons.
 * Splits on space or dash (removing dash), returns array of words.
 * keepDash=true: only split on spaces (ratchets keep their dashes e.g. "1-60")
 * keepDash=false (default): also split on dashes (bits e.g. "Low-Rush" → ["Low","Rush"])
 */
export function splitPartName(name: string, keepDash?: boolean): string[] {
  if (keepDash) return name.split(" ").filter(Boolean);
  return name.replace(/-/g, " ").split(" ").filter(Boolean);
}

export type { Combo, Finish };

/**
 * Normalize a Challonge URL or bare slug to a canonical slug.
 * Handles:
 *   - bare slug:                    "blasttest"         → "blasttest"
 *   - full URL:                     "https://challonge.com/blasttest"  → "blasttest"
 *   - community subdomain URL:      "https://ncbl.challonge.com/blastTEST" → "ncbl-blastTEST"
 *   - URL with /participants tail:  "https://ncbl.challonge.com/blastTEST/participants" → "ncbl-blastTEST"
 *   - partial URLs without proto:   "ncbl.challonge.com/blastTEST" → "ncbl-blastTEST"
 * Returns empty string if nothing parseable was found.
 */
export function normalizeChallongeSlug(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  // If it doesn't look like a URL (no slash, no dot), treat as a bare slug.
  if (!raw.includes("/") && !raw.includes(".")) return raw;
  try {
    const url = new URL(raw.startsWith("http") ? raw : "https://" + raw);
    const cleanPath = url.pathname.replace(/\/(participants|standings|teams|matches).*$/i, "");
    const parts = cleanPath.replace(/^\/|\/$/g, "").split("/").filter(Boolean);
    const subdomain = url.hostname.split(".")[0];
    const isCommunity = subdomain !== "challonge" && subdomain !== "www";
    const pathSlug = parts[parts.length - 1] || parts[0] || "";
    if (!pathSlug) return "";
    return isCommunity ? `${subdomain}-${pathSlug}` : pathSlug;
  } catch {
    // Fallback: strip protocol/domain/trailing segments and take the last path component.
    return raw
      .replace(/.*challonge\.com\//i, "")
      .replace(/\/(participants|standings|teams|matches).*/i, "")
      .replace(/\/$/, "")
      .split("/")
      .pop() || "";
  }
}

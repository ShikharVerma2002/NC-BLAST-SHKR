// ┌───────────────────────────────────────────────────────────────────────┐
// │  apps/judge/src/hooks/useChallongeAuthPopup.ts                          │
// │                                                                         │
// │  Challonge OAuth login hook. Opens a popup to Challonge's authorize     │
// │  page, waits for the popup to redirect back to our bare domain (where   │
// │  main.tsx's callback handler exchanges the code for an opaque token),   │
// │  then receives the result via postMessage and writes the token to      │
// │  sessionStorage.                                                        │
// │                                                                         │
// │  Mirrors standalone NC BLAST useChallongeAuthPopup with a few           │
// │  simplifications (no "wrong account" branch; that's handled at the     │
// │  OrgConfirmUsername step). State machine:                               │
// │    idle    — never started                                              │
// │    waiting — popup open, awaiting redirect + postMessage                │
// │    done    — login succeeded, token in sessionStorage                   │
// │    error   — login failed for any reason                                │
// │                                                                         │
// │  Mobile fallback: if the popup is blocked or used as new tab, the       │
// │  callback writes localStorage["ncblast-oauth-result-mobile"] and the    │
// │  hook polls that key for ~3 minutes.                                    │
// └───────────────────────────────────────────────────────────────────────┘
import { useCallback, useEffect, useRef, useState } from "react";
import { WORKER_BASE_URL } from "@ncblast/shared";

export type AuthState = "idle" | "waiting" | "done" | "error";

export interface AuthResult {
  state: AuthState;
  username: string | null;
  errorMsg: string;
  /** Open the popup and start the OAuth flow. */
  start: () => Promise<void>;
  /** Reset to idle (after error or to retry). */
  reset: () => void;
}

interface OAuthMessage {
  type: "ncblast-oauth-result";
  sessionId: string;
  ok: boolean;
  token?: string;
  username?: string;
  error?: string;
}

const REDIRECT_URI = window.location.origin; // e.g. "https://ncblast-judge.pages.dev"

export function useChallongeAuthPopup(): AuthResult {
  const [state, setState] = useState<AuthState>("idle");
  const [username, setUsername] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Stable sessionId per hook instance — routes messages back to this hook
  // even when multiple OAuth flows could conceivably overlap.
  const sessionIdRef = useRef<string>(Math.random().toString(36).slice(2));

  // Mobile-fallback poller — checks localStorage for a result written by a
  // callback page that couldn't postMessage (popup blocked, opened as new tab).
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Popup-closed watcher — if the user closes the popup without finishing,
  // we want to surface that as an error rather than hang in waiting forever.
  const popupRef = useRef<Window | null>(null);
  const popupClosedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback((): void => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (popupClosedRef.current) clearInterval(popupClosedRef.current);
    pollIntervalRef.current = null;
    popupClosedRef.current = null;
  }, []);

  // Receive postMessage from the popup.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      // Origin guard: only accept messages from our own origin.
      if (e.origin !== window.location.origin) return;
      const msg = e.data as Partial<OAuthMessage> | undefined;
      if (!msg || msg.type !== "ncblast-oauth-result") return;
      if (msg.sessionId !== sessionIdRef.current) return;
      cleanup();
      if (!msg.ok) {
        setErrorMsg(msg.error || "Login failed.");
        setState("error");
        return;
      }
      // Persist token + username so org screen can revalidate on refresh.
      try {
        if (msg.token) sessionStorage.setItem("ncblast-auth-token", msg.token);
        if (msg.username) sessionStorage.setItem("ncblast-auth-user", msg.username);
      } catch { /* ignore — storage may be disabled */ }
      setUsername(msg.username || null);
      setState("done");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [cleanup]);

  // Clean up on unmount.
  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async (): Promise<void> => {
    setErrorMsg("");
    setState("waiting");
    try { localStorage.removeItem("ncblast-oauth-result-mobile"); } catch { /* ignore */ }

    // CRITICAL: open the blank popup synchronously during the click handler.
    // Mobile browsers (especially Safari) block popups opened after async work.
    const newTab = window.open("", "_blank");

    try {
      const oauthState =
        sessionIdRef.current + "." + Math.random().toString(36).slice(2);

      const res = await fetch(
        `${WORKER_BASE_URL}/auth/authorize-url?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=${encodeURIComponent(oauthState)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      const data = (await res.json()) as { url?: string; error?: string };
      if (!data.url) {
        if (newTab && !newTab.closed) {
          try { newTab.close(); } catch { /* ignore */ }
        }
        setErrorMsg(data.error || "Couldn't reach Challonge.");
        setState("error");
        return;
      }

      if (newTab && !newTab.closed) {
        newTab.location.href = data.url;
        popupRef.current = newTab;
      } else {
        // Popup blocked — fall back to same-tab navigation. This loses page
        // state but is the only way to recover on mobile when popups are off.
        window.location.href = data.url;
        return;
      }

      // Watch for popup close (user dismissed before finishing).
      popupClosedRef.current = setInterval(() => {
        if (popupRef.current && popupRef.current.closed) {
          cleanup();
          // Don't overwrite a "done" or "error" state set by message handler.
          setState((s) => (s === "waiting" ? "error" : s));
          setErrorMsg("Login cancelled — popup was closed.");
        }
      }, 1000);

      // Mobile poller — checks localStorage for the result key.
      pollIntervalRef.current = setInterval(() => {
        try {
          const raw = localStorage.getItem("ncblast-oauth-result-mobile");
          if (!raw) return;
          localStorage.removeItem("ncblast-oauth-result-mobile");
          const msg = JSON.parse(raw) as Partial<OAuthMessage>;
          cleanup();
          if (!msg.ok) {
            setErrorMsg(msg.error || "Login failed.");
            setState("error");
            return;
          }
          try {
            if (msg.token) sessionStorage.setItem("ncblast-auth-token", msg.token);
            if (msg.username) sessionStorage.setItem("ncblast-auth-user", msg.username);
          } catch { /* ignore */ }
          setUsername(msg.username || null);
          setState("done");
        } catch { /* ignore */ }
      }, 500);

      // Auto-timeout after 3 minutes so a forgotten flow doesn't leak intervals.
      setTimeout(() => {
        if (pollIntervalRef.current || popupClosedRef.current) {
          cleanup();
          setState((s) => (s === "waiting" ? "error" : s));
          setErrorMsg("Login timed out. Please try again.");
        }
      }, 180_000);
    } catch (e) {
      if (newTab && !newTab.closed) {
        try { newTab.close(); } catch { /* ignore */ }
      }
      setErrorMsg((e as Error).message || "Connection error.");
      setState("error");
    }
  }, [cleanup]);

  const reset = useCallback((): void => {
    cleanup();
    setUsername(null);
    setErrorMsg("");
    setState("idle");
  }, [cleanup]);

  return { state, username, errorMsg, start, reset };
}

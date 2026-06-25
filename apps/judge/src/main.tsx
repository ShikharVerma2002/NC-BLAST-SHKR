import React from "react";
import ReactDOM from "react-dom/client";
import { BeyJudgeApp } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WORKER_BASE_URL } from "@ncblast/shared";
import "./styles.css";

// ─── OAuth bare-domain callback handler ──────────────────────────────────────
// When Challonge redirects back to https://ncblast-judge.pages.dev/?code=...&state=...
// we're either:
//   (a) a popup whose `window.opener` is the original tab — postMessage the
//       result back and close.
//   (b) the original tab itself (popup blocked, mobile new-tab flow) — write
//       to a fixed localStorage key so the original tab's poller can read it.
// In either case, we MUST NOT mount the React app, because the URL will look
// like a normal homepage visit and the SPA shouldn't try to render under
// these conditions.
//
// This block runs synchronously at module load — must be before the
// ReactDOM.createRoot call below.
(function handleOAuthCallback(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");
    const errorDesc = params.get("error_description");
    if (!code && !error) return false;

    // Hide the React UI immediately so the app doesn't briefly flash.
    document.documentElement.style.display = "none";
    // Clear the URL so a refresh doesn't re-fire the OAuth exchange.
    window.history.replaceState({}, document.title, "/");

    const stateParam = params.get("state") || "";
    const sessionId = stateParam.split(".")[0] || "";
    const isPopup = !!window.opener && window.opener !== window;

    const signalResult = (msg: { ok: boolean; token?: string; username?: string; error?: string; debug?: unknown }): void => {
      if (isPopup) {
        try {
          window.opener.postMessage(
            { type: "ncblast-oauth-result", sessionId, ...msg },
            window.location.origin,
          );
        } catch { /* ignore — message recipient may have closed */ }
        try { window.close(); } catch { /* ignore */ }
      } else {
        // Mobile / new-tab flow: write result to localStorage so the original
        // tab's poller picks it up, then show a "you can close this tab" page.
        try {
          localStorage.setItem(
            "ncblast-oauth-result-mobile",
            JSON.stringify({ ...msg, ts: Date.now() }),
          );
        } catch { /* ignore */ }
        document.documentElement.style.display = "";
        const ok = msg.ok;
        document.body.innerHTML =
          '<div style="font-family:Outfit,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;color:#94a3b8;padding:32px;text-align:center">' +
          '<div style="font-size:48px;margin-bottom:16px">' + (ok ? "✅" : "❌") + "</div>" +
          '<p style="font-size:20px;font-weight:800;color:' + (ok ? "#22c55e" : "#ef4444") + ';margin:0 0 8px">' +
          (ok ? "Logged in as " + (msg.username || "?") : "Login failed") +
          "</p>" +
          '<p style="font-size:14px;margin:0;color:#64748b">' +
          (ok ? "You can close this tab and return to NC BLAST." : (msg.error || "An unknown error occurred.")) +
          "</p></div>";
      }
    };

    if (error) {
      signalResult({ ok: false, error: "Challonge error: " + (errorDesc || error) });
      return true;
    }
    if (!code) return true;

    // Exchange the code for an opaque token via the Worker.
    // Worker also fetches Challonge /me to resolve the username, so we get
    // {ok, access_token: <opaque>, username} back.
    fetch(`${WORKER_BASE_URL}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        redirect_uri: window.location.origin,
      }),
    })
      .then((r) => r.json())
      .then((d: { ok: boolean; access_token?: string; username?: string; error?: string; debug?: unknown }) => {
        if (!d.ok || !d.access_token) {
          // Include diagnostics in the error message when present so the user
          // can see exactly which Challonge endpoint failed and how, without
          // having to open DevTools on the popup window.
          let msg = d.error || "Login failed";
          if (d.debug) {
            try { msg += " · debug: " + JSON.stringify(d.debug); } catch { /* ignore */ }
          }
          signalResult({ ok: false, error: msg });
          return;
        }
        signalResult({ ok: true, token: d.access_token, username: d.username });
      })
      .catch((e: Error) => {
        signalResult({ ok: false, error: e.message || "Connection error" });
      });

    return true;
  } catch {
    return false;
  }
})();

// Only mount the app if we didn't take over the page for OAuth callback.
// The callback path sets display:none on documentElement — check that.
const rootEl = document.getElementById("root");
if (rootEl && document.documentElement.style.display !== "none") {
  ReactDOM.createRoot(rootEl).render(
    <ErrorBoundary variant="judge">
      <BeyJudgeApp />
    </ErrorBoundary>
  );
}

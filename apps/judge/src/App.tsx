import { useEffect, useRef, useState } from "react";
import type { MatchConfig, Parts, LogEntry, ChallongeParticipantMap, SubmissionQueueItem } from "@ncblast/shared";
import { sGet, sSave, STORAGE_KEYS as KEYS, SHEETS_URL, WORKER_BASE_URL } from "@ncblast/shared";
import { FormatScreen } from "./screens/FormatScreen";
import { PlayersScreen } from "./screens/PlayersScreen";
import { MatchScreen } from "./screens/MatchScreen";
import type { DownloadCsvMeta, SendSheetsMeta } from "./screens/MatchScreen";
import { LibraryManager } from "./components/LibraryManager";
import { useScale } from "./hooks/useScale";
import { useDarkMode } from "./hooks/useDarkMode";
// useRefreshGuard moved into MatchScreen (scoped to active battle/deck phases).
import { mergeWithDefaults } from "./data/parts";
import { makeS, S } from "./styles";
import { comboStr } from "./utils";
import { enqueue, remove as removeFromQueue, list as listQueue } from "./submitQueue";
import { getSessionToken } from "./pin";

type Screen = "format" | "players" | "match";

// ── Idempotency dedup (client-best-effort) ────────────────────────────────
// Keep a ring of recently-succeeded queue item ids (capped 50, TTL 24h).
// Before retrying a queued item, consult this list — if the id already
// succeeded, drop the duplicate instead of re-POSTing.
const SUCCEEDED_CAP = 50;
const SUCCEEDED_TTL_MS = 24 * 60 * 60 * 1000;
type SucceededEntry = { id: string; at: number };
function readSucceeded(): SucceededEntry[] {
  try {
    const raw = localStorage.getItem(KEYS.submitSucceeded) || "[]";
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter((e): e is SucceededEntry =>
        typeof e === "object" && e !== null && "id" in e && "at" in e
        && typeof (e as SucceededEntry).id === "string"
        && typeof (e as SucceededEntry).at === "number"
      )
      .filter(e => now - e.at < SUCCEEDED_TTL_MS);
  } catch { return []; }
}
function markSucceeded(id: string): void {
  const fresh: SucceededEntry[] = [...readSucceeded(), { id, at: Date.now() }].slice(-SUCCEEDED_CAP);
  try { localStorage.setItem(KEYS.submitSucceeded, JSON.stringify(fresh)); } catch {/* ignore */}
}
function wasSucceeded(id: string): boolean {
  return readSucceeded().some(e => e.id === id);
}

// ── BroadcastChannel single-flusher election (best-effort) ───────────────
// When multiple tabs are open, avoid parallel flushes (which can cause
// double-submits on slow-response timeouts). Each tab generates a random
// tabId; the tab with the LOWEST id wins. If BroadcastChannel is unsupported,
// fall back to running unconditionally.
const TAB_ID = Math.random().toString(36).slice(2, 10);
let bc: BroadcastChannel | null = null;
try { bc = new BroadcastChannel("ncblast-queue-flush"); } catch { bc = null; }
const peerAnnouncements = new Set<string>();
if (bc) {
  bc.onmessage = (e: MessageEvent): void => {
    const data = e.data as unknown;
    if (typeof data === "object" && data !== null && "tabId" in data) {
      const tid = (data as { tabId: unknown }).tabId;
      if (typeof tid === "string") peerAnnouncements.add(tid);
    }
  };
}
async function claimFlusherLease(): Promise<boolean> {
  if (!bc) return true;
  peerAnnouncements.clear();
  bc.postMessage({ tabId: TAB_ID, at: Date.now() });
  await new Promise(r => setTimeout(r, 50));
  // If any peer announced a lower tabId, yield to them.
  for (const tid of peerAnnouncements) {
    if (tid < TAB_ID) return false;
  }
  return true;
}

/**
 * MAIN APP — BeyJudgeApp. Hosts the screen router, dark mode, library modal,
 * scale hook, Challonge context, and the Sheets/CSV/offline-queue handlers.
 */
export function BeyJudgeApp() {
  const sc = useScale();
  S.current = makeS(sc); // update module-level S so all components see it
  const [dark, toggleDark] = useDarkMode();
  const [screen,setScreen] = useState<Screen>("format");
  const [config,setConfig] = useState<MatchConfig>({pts:4,bo:3,tm:false,tournamentName:""});
  const [parts,setParts] = useState<Parts>({blades:[],ratchets:[],bits:[]});
  const [players,setPlayers] = useState<string[]>([]);
  const [libOpen,setLibOpen] = useState(false);
  // Block refresh when a match is actively in progress
  // Refresh-guard moved into MatchScreen (scoped to active battle/deck phases).
  const [judge,setJudge] = useState("");
  const [sheetsStatus,setSheetsStatus] = useState<null | "success" | "error" | "queued">(null);
  const [challongeSlug,setChallongeSlug] = useState("");
  const [challongeParticipants,setChallongeParticipants] = useState<ChallongeParticipantMap>({});

  useEffect(()=>{
    const saved=sGet(KEYS.parts, {} as Partial<Parts>);
    const merged=mergeWithDefaults(saved);
    setParts(merged); sSave(KEYS.parts,merged);
    setPlayers(sGet(KEYS.players, [] as string[]));
    // Restore last Challonge tournament context
    const savedMap = sGet(KEYS.challongeMap, {} as { slug?: string; participants?: ChallongeParticipantMap });
    if(savedMap.slug) setChallongeSlug(savedMap.slug);
    if(savedMap.participants) setChallongeParticipants(savedMap.participants);
  },[]);

  // Download CSV to device — always available, never sends to sheets
  const handleDownloadCSV = (roundLog: LogEntry[], meta: DownloadCsvMeta): void => {
    let csv="Round,Set,Shuffle,Judge,Tournament,Winner,WinnerCombo,FinishType,Points,Penalty,P1,P1Side,P1Score,P1Combo,P2,P2Side,P2Score,P2Combo,Timestamp\n";
    roundLog.forEach(r=>{csv+=`${r.round},${r.set},${r.shuffle},"${r.judge||""}","${meta.config?.tournamentName||""}","${r.scorer}","${r.winnerCombo}",${r.type},${r.points},${r.penalty?1:0},"${r.p1Name}",${r.p1Side||""},"${r.p1Score}","${comboStr(r.p1Combo)}","${r.p2Name}",${r.p2Side||""},"${r.p2Score}","${comboStr(r.p2Combo)}",${r.time}\n`;});
    const blob=new Blob([csv],{type:"text/csv"}); const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`ncblast_${meta.p1||"p1"}_vs_${meta.p2||"p2"}_${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  // Send to Google Sheets only — no CSV download
  const handleSendSheets = async (roundLog: LogEntry[], meta: SendSheetsMeta): Promise<void> => {
    const flagged = meta.flagged || false;
    const comment = meta.comment || "";
    // Sheet 1: existing summary rows
    const rows: unknown[][] = roundLog.map(r=>[
      r.time,
      r.judge||"",
      meta.config?.tournamentName||"",
      `${r.p1Name} vs ${r.p2Name}`,
      r.p1Name, r.p1Side||"", r.p2Name, r.p2Side||"",
      r.set, r.shuffle, r.round,
      r.scorer, r.winnerCombo,
      r.typeName, r.points,
      r.penalty?1:0,
      r.p1Score, r.p2Score,
      comboStr(r.p1Combo), comboStr(r.p2Combo)
    ]);

    // Sheet 2: one row per battle with specific battle-level detail
    const battleRows: unknown[][] = roundLog.map(r=>{
      // Format time as PST XX:XXam/pm
      const d = new Date(r.time);
      const pst = new Date(d.toLocaleString("en-US",{timeZone:"America/Los_Angeles"}));
      const h = pst.getHours(); const m = pst.getMinutes();
      const ampm = h>=12?"pm":"am";
      const h12 = h%12||12;
      const mm = String(m).padStart(2,"0");
      const mo = String(pst.getMonth()+1).padStart(2,"0");
      const dy = String(pst.getDate()).padStart(2,"0");
      const yr = pst.getFullYear();
      const dateTime = `${mo}/${dy}/${yr} ${h12}:${mm}${ampm}`;

      // Win condition: e.g. "XTR+3", "OVR+2", "OF+2", "LER+1"
      const winCondition = r.penalty
        ? `${r.type===("OF2")||r.type===("OF3")?"OF":"LER"}+${r.points}`
        : `${r.type}+${r.points}`;

      const winnerIsP1 = r.scorerIdx===0;
      const winnerName = winnerIsP1 ? r.p1Name : r.p2Name;
      const loserName  = winnerIsP1 ? r.p2Name : r.p1Name;
      const winnerCombo = r.winnerCombo;
      const loserCombo  = winnerIsP1 ? comboStr(r.p2Combo) : comboStr(r.p1Combo);

      return [
        dateTime,
        r.judge||"",
        r.p1Name, r.p1Side||"", comboStr(r.p1Combo),
        r.p2Name, r.p2Side||"", comboStr(r.p2Combo),
        winnerName, winnerCombo,
        winCondition,
        loserCombo, loserName
      ];
    });

    try {
      // Write-ahead: persist to outbox FIRST, then try to submit.
      const queueId = enqueue({ kind: "sheets", type: "sheets", payload: {rows, battleRows, flagged, comment} });
      const resp = await fetch(SHEETS_URL, {
        method:"POST",
        body: JSON.stringify({rows, battleRows, flagged, comment, idempotencyKey: queueId}),
        signal: AbortSignal.timeout(10000),
      });
      const result: unknown = await resp.json();
      const ok = typeof result === "object" && result !== null && "status" in result && (result as { status: unknown }).status === "ok";
      if (ok) {
        markSucceeded(queueId);
        removeFromQueue(queueId);
        setSheetsStatus("success");
      } else {
        // Leave queued — retry loop will pick it up.
        setSheetsStatus("queued");
      }
    } catch(_err) {
      // Timeout or network failure — item already persisted, retry loop will pick it up.
      setSheetsStatus("queued");
    }
  };

  // Pending-queue count shown in the status pill; recomputed after every
  // flush and on a 10s interval so the judge can tell when a submission is stuck.
  const [pendingCount, setPendingCount] = useState<number>(() => listQueue().length);
  const flushRef = useRef<() => Promise<void>>(async () => {});

  // Retry queued submissions when network reconnects (and once on mount).
  useEffect(() => {
    const flush = async (): Promise<void> => {
      // Coordinate with any other open tabs — avoid parallel flushes that
      // would double-submit on slow-response timeouts.
      const leased = await claimFlusherLease();
      if (!leased) return;
      // Process items serially to avoid double-submits within this tab too.
      const queue: SubmissionQueueItem[] = listQueue();
      for (const item of queue) {
        if (!item.id) continue;
        // Client-best-effort dedup: if this id already reached a 2xx, skip the POST.
        if (wasSucceeded(item.id)) {
          removeFromQueue(item.id);
          console.log(`[submitQueue] skipped already-delivered item ${item.id}`);
          continue;
        }
        const kind = item.kind ?? (item.type === "sheets" ? "sheets" : undefined);
        try {
          if (kind === "sheets") {
            const resp = await fetch(SHEETS_URL, {
              method: "POST",
              // Include idempotencyKey so Apps Script CAN dedup if extended later.
              body: JSON.stringify({ ...(item.payload as object), idempotencyKey: item.id }),
              signal: AbortSignal.timeout(10000),
            });
            const result: unknown = await resp.json();
            const ok = resp.ok && typeof result === "object" && result !== null && "status" in result && (result as { status: unknown }).status === "ok";
            if (ok) {
              markSucceeded(item.id);
              removeFromQueue(item.id);
              console.log(`[submitQueue] flushed sheets item ${item.id}`);
            }
          } else if (kind === "challonge") {
            // Diagnostic: log exactly what we're retrying so duplicate submits show up in console.
            console.log("[Challonge retry-flush]", { itemId: item.id, payload: item.payload });
            // Attach the session token for this tournament if we have one (the
            // Worker needs it to admit the /submit when the tournament is PIN-gated).
            const rtHeaders: Record<string, string> = { "Content-Type": "application/json" };
            const payloadObj = item.payload as { slug?: string };
            const rtToken = payloadObj.slug ? getSessionToken(payloadObj.slug) : null;
            if (rtToken) rtHeaders["X-Session-Token"] = rtToken;
            const resp = await fetch(`${WORKER_BASE_URL}/submit`, {
              method: "POST",
              headers: rtHeaders,
              body: JSON.stringify({ ...(item.payload as object), idempotencyKey: item.id }),
              signal: AbortSignal.timeout(10000),
            });
            // Only remove on confirmed HTTP 2xx (and no Challonge-reported errors).
            if (resp.ok) {
              const data: unknown = await resp.json().catch((): unknown => null);
              const hasErrors = typeof data === "object" && data !== null && "errors" in data && Array.isArray((data as { errors: unknown }).errors) && ((data as { errors: unknown[] }).errors).length > 0;
              if (!hasErrors) {
                markSucceeded(item.id);
                removeFromQueue(item.id);
                console.log(`[submitQueue] flushed challonge item ${item.id}`);
              }
            }
          }
        } catch {
          // Leave item queued for next flush.
        }
      }
      setPendingCount(listQueue().length);
    };
    flushRef.current = flush;
    // Fire once on mount in case items are sitting from a prior session/crash.
    flush();
    window.addEventListener("online", flush);
    // Poll queue count every 2s so the pill appears quickly after an enqueue
    // from any call site (Sheets, Challonge, etc.) and clears after flush success.
    const iv = setInterval(() => setPendingCount(listQueue().length), 2000);
    return () => {
      window.removeEventListener("online", flush);
      clearInterval(iv);
    };
  }, []);


  return (
    <div style={{background:"var(--bg)",minHeight:"100vh",fontFamily:"'Outfit',sans-serif"}}>
      {libOpen&&<LibraryManager parts={parts} setParts={setParts} onClose={()=>setLibOpen(false)}/>}
      {screen==="format"&&<FormatScreen config={config} setConfig={setConfig} parts={parts} onNext={()=>setScreen("players")} onOpenLib={()=>setLibOpen(true)} dark={dark} toggleDark={toggleDark}/>}
      {screen==="players"&&<PlayersScreen players={players} setPlayers={setPlayers} onNext={()=>setScreen("match")} onBack={()=>setScreen("format")} toggleDark={toggleDark} dark={dark} config={config} onChallongeImport={(slug,pmap)=>{setChallongeSlug(slug);setChallongeParticipants(pmap);sSave(KEYS.challongeMap,{slug,participants:pmap});}}/>}
      {screen==="match"&&<MatchScreen config={config} parts={parts} players={players} setPlayers={setPlayers} judge={judge} setJudge={setJudge} sheetsStatus={sheetsStatus} setSheetsStatus={setSheetsStatus} onBack={()=>setScreen("players")} onMainMenu={()=>setScreen("format")} onDownloadCSV={handleDownloadCSV} onSendSheets={handleSendSheets} onOpenLib={()=>setLibOpen(true)} dark={dark} toggleDark={toggleDark} challongeSlug={challongeSlug} challongeParticipants={challongeParticipants}/>}
      {/* Pending-submissions status pill — floats bottom-right so judges always
          see when the outbox has unflushed items, regardless of which screen they're on. */}
      {pendingCount > 0 && (
        <button
          type="button"
          onClick={()=>{ void flushRef.current(); }}
          style={{position:"fixed",bottom:12,right:12,zIndex:900,padding:"8px 14px",borderRadius:999,border:"none",background:"#EA580C",color:"#fff",fontSize:12,fontWeight:800,fontFamily:"'Outfit',sans-serif",cursor:"pointer",boxShadow:"0 4px 12px rgba(0,0,0,0.25)"}}
          title={`${pendingCount} submission${pendingCount===1?"":"s"} pending — tap to retry now`}
        >
          📡 {pendingCount} pending · retry
        </button>
      )}
    </div>
  );
}

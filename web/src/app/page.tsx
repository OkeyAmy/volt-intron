"use client";

/**
 * Make an invoice — the Speak → Check → Create flow.
 *
 * Speaking captures the microphone as 16 kHz PCM16 (via the AudioWorklet in
 * /pcm-recorder-worklet.js -- NOT MediaRecorder, whose Opus the Intron socket
 * cannot read) and streams it to the gateway. Typing reaches the SAME review, so
 * the whole task works even when the microphone doesn't. The gateway holds the
 * Intron credentials; this page only moves audio and renders state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import DraftReview from "./DraftReview";

type Phase = "idle" | "starting" | "recording" | "finalizing" | "done" | "error";

const LANGS: { code: string; label: string }[] = [
  { code: "pcm", label: "Pidgin + English" },
  { code: "yo", label: "Yoruba + English" },
  { code: "ig", label: "Igbo + English" },
  { code: "ha", label: "Hausa + English" },
  { code: "en", label: "English" },
];

// Trader-facing messages: state the problem and the way forward, never blame the speaker.
const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: "Microphone access is off. Allow it in your browser settings, or type instead.",
  NotFoundError: "No microphone was found. Connect one, or type your invoice details instead.",
  NotReadableError: "The microphone is busy in another app. Close it and try again, or type instead.",
  SecurityError: "Recording needs a secure (https) page. You can type your invoice details instead.",
};

// How many gateway connections one recording will tolerate before giving up. Each
// failed pre-session connect costs nothing (no session was billed), so transparently
// reconnecting keeps the recording alive through the upstream's own hiccups.
const MAX_GENS = 3;

const STATUS: Record<Phase, string> = {
  idle: "",
  starting: "Getting ready…",
  recording: "You can speak now.",
  finalizing: "Turning your recording into text…",
  done: "Check your invoice details.",
  error: "",
};

function Mark() {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="Sautice" width="34" height="34">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 13 Q5.5 3.5 8.5 13 Q11.5 22.5 14.5 13 L29.5 13" stroke="currentColor" strokeWidth="2.6" />
        <path d="M17 20.5 L29.5 20.5" stroke="var(--tally)" strokeWidth="2.6" />
      </g>
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [language, setLanguage] = useState("pcm");
  const [partial, setPartial] = useState("");
  const [finalText, setFinalText] = useState("");
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [meta, setMeta] = useState<string | null>(null);
  const [flow, setFlow] = useState<"compose" | "review" | "issued">("compose");
  const [issued, setIssued] = useState<{ id: string; number: string } | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [shareNote, setShareNote] = useState("");

  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const queueRef = useRef<ArrayBuffer[]>([]);
  const openRef = useRef(false);
  const intronReadyRef = useRef(false);
  const gensRef = useRef(0);
  const commitPendingRef = useRef(false);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const teardownAudio = useCallback(() => {
    if (timerRef.current != null) { clearInterval(timerRef.current); timerRef.current = null; }
    nodeRef.current?.port.close();
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (ctxRef.current && ctxRef.current.state !== "closed") ctxRef.current.close();
    ctxRef.current = null;
    setLevel(0);
  }, []);

  const closeAll = useCallback(() => {
    teardownAudio();
    openRef.current = false;
    intronReadyRef.current = false;
    gensRef.current = 0;
    commitPendingRef.current = false;
    queueRef.current = [];
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }, [teardownAudio]);

  useEffect(() => closeAll, [closeAll]);

  const fail = useCallback((message: string) => {
    setError(message);
    setPhase("error");
    closeAll();
  }, [closeAll]);

  const [reconnectKey, setReconnectKey] = useState(0);
  const languageRef = useRef(language);
  useEffect(() => { languageRef.current = language; }, [language]);

  /**
   * Open (or transparently re-open) the gateway WebSocket for the current
   * recording. Called once from `start()` and again when `reconnectKey` changes
   * (the upstream failed BEFORE a session was confirmed - a pre-session failure
   * bills nothing, so replaying the audio costs nothing). The live language is
   * read through `languageRef` so a stale closure can't freeze an old selection
   * into a reconnect.
   */
  const openGateway = useCallback(() => {
    intronReadyRef.current = false;
    openRef.current = false; // the new socket is not writable until its `open` fires
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/voice/stream?lang=${encodeURIComponent(languageRef.current)}`);
    ws.binaryType = "arraybuffer";
    const prior = wsRef.current;
    wsRef.current = ws;
    if (prior && prior.readyState <= WebSocket.OPEN) prior.close(); // retire a still-alive socket

    // `torn` makes reconnect-once-per-generation: after we choose to reconnect,
    // the eventual error/close events of this dead socket must not double up.
    let torn = false;
    const reconnect = () => {
      if (torn) return;
      torn = true;
      gensRef.current += 1;
      if (gensRef.current >= MAX_GENS) {
        fail("The connection couldn't be established. Please record again or type the details.");
        return;
      }
      // Let the reconnect effect below call openGateway in the next render.
      setReconnectKey((k) => k + 1);
    };

    ws.onopen = () => {
      openRef.current = true;
      for (const buf of queueRef.current) ws.send(buf);
      queueRef.current = [];
      if (commitPendingRef.current) ws.send(JSON.stringify({ type: "commit" }));
      startedAtRef.current = Date.now();
      setPhase("recording");
      timerRef.current = setInterval(() => setElapsed((Date.now() - startedAtRef.current) / 1000), 100);
    };
    ws.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "open") {
        intronReadyRef.current = true; // a session exists now: this connect is billed
        setMeta(`session ${(String(msg.sessionId ?? "")).slice(0, 8)}… · credits ${msg.creditBalance}`);
      } else if (msg.type === "partial") {
        setPartial(String(msg.text ?? ""));
      } else if (msg.type === "final") {
        const r = msg.result as { transcript?: string; msStopToFinal?: number | null; partialCount?: number };
        setFinalText(r?.transcript ?? "");
        setPartial("");
        setMeta(`heard in ${Math.round((r?.msStopToFinal ?? 0) / 100) / 10}s`);
        setPhase("done");
        closeAll();
      } else if (msg.type === "error") {
        // Pre-session errors never billed a session, so ride through them by
        // reconnecting; the audio kept arriving and will be replayed on open.
        if (phaseRef.current === "recording" && !intronReadyRef.current) { reconnect(); return; }
        fail(String(msg.message ?? "We couldn't use this recording. Please record again or type the details."));
      }
    };
    ws.onerror = () => {
      if (phaseRef.current === "recording" && !intronReadyRef.current) reconnect();
      else if (phaseRef.current !== "done") fail("The connection stopped. Please record again or type the details.");
    };
    ws.onclose = () => {
      if (phaseRef.current === "recording") {
        if (!intronReadyRef.current) reconnect();
        else fail("The connection stopped while we were still listening. Please record again or type the details.");
      } else if (phaseRef.current === "finalizing") {
        fail("The connection stopped before we got the text. Please record again or type the details.");
      }
    };
  }, [fail, closeAll]);

  // A reconnect bumps this key; the effect performs the actual re-open so the
  // next render's `openGateway` (with fresh closures) does the work.
  useEffect(() => {
    if (reconnectKey > 0) openGateway();
  }, [reconnectKey, openGateway]);

  const start = useCallback(async () => {
    setError(""); setPartial(""); setFinalText(""); setMeta(null); setElapsed(0);
    setFlow("compose"); setIssued(null); setTyping(false); setShareNote("");
    setPhase("starting");
    gensRef.current = 0;
    commitPendingRef.current = false;
    setReconnectKey(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-recorder-worklet.js");
      if (ctx.state === "suspended") await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-recorder");
      nodeRef.current = node;
      node.port.onmessage = (e) => {
        const d = e.data;
        if (d.type === "level") { setLevel(Math.min(1, d.value * 1.6)); return; }
        if (d.type === "audio") {
          // Always keep the audio so a pre-session reconnect can replay it whole.
          queueRef.current.push(d.buffer);
          if (openRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(d.buffer);
          }
        }
      };
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);

      openGateway();
    } catch (e) {
      const name = (e as Error).name;
      fail(MIC_ERRORS[name] ?? `Could not start recording: ${(e as Error).message}. You can type instead.`);
    }
  }, [openGateway, fail]);

  const stop = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    teardownAudio();
    setPhase("finalizing");
    commitPendingRef.current = true;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "commit" }));
    }
  }, [teardownAudio]);

  const cancel = useCallback(() => { closeAll(); setPhase("idle"); setPartial(""); setError(""); }, [closeAll]);

  const useTyped = useCallback(() => {
    const t = typed.trim();
    if (!t) return;
    closeAll();
    setError(""); setPartial(""); setFinalText(t); setPhase("done"); setFlow("review");
  }, [typed, closeAll]);

  const shareInvoice = useCallback(async () => {
    if (!issued) return;
    const url = `${location.origin}/invoice/${issued.id}`;
    const text = `Invoice ${issued.number} from Sautice`;
    try {
      if (navigator.share) { await navigator.share({ title: text, text, url }); setShareNote("Share sheet opened. Sharing isn't confirmed until you send it."); return; }
      await navigator.clipboard.writeText(url);
      setShareNote("Invoice link copied. Paste it wherever you want to send it.");
    } catch {
      setShareNote(`Copy this link to share: ${url}`);
    }
  }, [issued]);

  const busy = phase === "starting" || phase === "recording" || phase === "finalizing";
  const langLabel = LANGS.find((l) => l.code === language)?.label ?? language;

  return (
    <main id="main" className="sr-page">
      <div className="sr-card">
        <header className="sr-brand">
          <Mark />
          <div className="sr-wordmark">Make an invoice</div>
        </header>

        {flow === "compose" && phase !== "recording" && phase !== "finalizing" && (
          <>
            <p className="sr-tagline">Say the customer, what you sold, the quantity, and the price.</p>
            <p className="sr-example">
              Example: <span lang="en">&ldquo;Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each.&rdquo;</span>
            </p>
          </>
        )}

        <div className="sr-row">
          <label className="sr-label" htmlFor="lang">Speech language</label>
          <select id="lang" className="sr-select" value={language} disabled={busy} onChange={(e) => setLanguage(e.target.value)}>
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
          <Link className="sr-help-link" href="/help">Need help?</Link>
        </div>

        {/* Compose: speak or type */}
        {flow === "compose" && !typing && phase !== "recording" && phase !== "finalizing" && (
          <>
            <div className="sr-controls">
              <button className="sr-btn sr-primary" onClick={start} disabled={phase === "starting"}>
                <MicIcon /> {phase === "starting" ? "Starting…" : phase === "done" || phase === "error" ? "Record again" : "Start speaking"}
              </button>
              <button className="sr-btn sr-ghost" onClick={() => { setTyping(true); setTyped(finalText); }}>Type instead</button>
            </div>
            <p className="sr-expect">You&apos;ll check the details before creating the invoice.</p>
          </>
        )}

        {flow === "compose" && typing && (
          <div className="rev">
            <label className="sr-label" htmlFor="typed">Type your sale</label>
            <textarea id="typed" className="type-area" value={typed} disabled={busy}
              placeholder="e.g. Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each"
              onChange={(e) => setTyped(e.target.value)} />
            <div className="sr-controls">
              <button className="sr-btn sr-primary" onClick={useTyped} disabled={!typed.trim()}>Check the details</button>
              <button className="sr-btn sr-ghost" onClick={() => setTyping(false)}>Speak instead</button>
            </div>
          </div>
        )}

        {/* Recording controls */}
        {(phase === "recording" || phase === "finalizing") && (
          <>
            <div className="sr-controls">
              {phase === "recording" ? (
                <>
                  <button className="sr-btn sr-danger" onClick={stop}>
                    <span className="sr-dot" aria-hidden /> Stop recording
                  </button>
                  <button className="sr-btn sr-ghost" onClick={cancel}>Cancel</button>
                  <span className="sr-timer" aria-hidden>{elapsed.toFixed(1)}s</span>
                </>
              ) : (
                <span className="sr-timer">Turning your recording into text…</span>
              )}
            </div>
            <div className="sr-meter" role="progressbar" aria-label="Microphone level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="sr-meterFill" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <p className="sr-meta">Speaking {langLabel}</p>
          </>
        )}

        <div className="sr-status" role="status" aria-live="polite">
          {STATUS[phase] && <span>{STATUS[phase]}</span>}
          {meta && <span className="sr-meta">· {meta}</span>}
        </div>

        {/* Body: error / issued / review / transcript */}
        {error ? (
          <div className="rev">
            <div className="sr-error" role="alert">{error}</div>
            <div className="sr-controls">
              <button className="sr-btn sr-primary" onClick={start}><MicIcon /> Record again</button>
              <button className="sr-btn sr-ghost" onClick={() => { setError(""); setPhase("idle"); setTyping(true); setTyped(""); }}>Type instead</button>
            </div>
          </div>
        ) : flow === "issued" && issued ? (
          <div className="sr-created">
            <div><span className="sr-badge sr-badgeFinal">Invoice created</span></div>
            <p>Invoice <strong>{issued.number}</strong> is saved. It&apos;s a request for payment — not a receipt.</p>
            <div className="sr-controls">
              <Link className="sr-btn sr-primary" href={`/invoice/${issued.id}`}>View invoice</Link>
              <button className="sr-btn sr-ghost" onClick={shareInvoice}>Share invoice</button>
              <button className="sr-btn sr-ghost" onClick={start}>Create another</button>
            </div>
            {shareNote && <p className="sr-meta" role="status">{shareNote}</p>}
          </div>
        ) : flow === "review" && finalText ? (
          <DraftReview
            transcript={finalText}
            onIssued={(id, number) => { setIssued({ id, number }); setFlow("issued"); }}
            onCancel={() => { setFlow("compose"); setPhase("idle"); }}
          />
        ) : (phase === "recording" || phase === "finalizing" || finalText) ? (
          <>
            <div className="sr-transcript" aria-live="polite">
              {finalText ? (
                <><span className="sr-badge sr-badgeFinal">Final</span> {finalText}</>
              ) : partial ? (
                <><span className="sr-label">Words heard so far</span><br /><span className="sr-partial">{partial}</span></>
              ) : (
                <span className="sr-placeholder">Your words will appear here.</span>
              )}
            </div>
            {finalText && phase === "done" && (
              <div className="sr-controls">
                <button className="sr-btn sr-primary" onClick={() => setFlow("review")}>Check the details</button>
                <button className="sr-btn sr-ghost" onClick={start}>Record again</button>
              </div>
            )}
          </>
        ) : null}
      </div>

      <p className="sr-foot">
        Audio streams to this app&apos;s voice gateway, which holds the Intron key — the key never
        reaches the browser. Recordings aren&apos;t stored by this page.
      </p>
    </main>
  );
}

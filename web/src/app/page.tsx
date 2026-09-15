"use client";

/**
 * Make an invoice — the Speak → Check → Create flow.
 *
 * Speaking captures the microphone as 16 kHz PCM16 (via the AudioWorklet in
 * /pcm-recorder-worklet.js -- NOT MediaRecorder, whose Opus the Intron socket
 * cannot read). Two transports carry the audio:
 *  - "stream": live, to the WebSocket gateway in server.mts (container hosts), so
 *    words appear while the trader speaks.
 *  - "upload": record first, then POST once to /api/voice/transcribe. This is what
 *    a serverless host (Vercel) can run. A stream recording whose gateway can't be
 *    reached before a session exists switches to upload instead of failing.
 * Either way the words land in an editable box, and typing reaches the SAME box, so
 * the whole task works even when the microphone doesn't. The server holds the
 * Intron credentials; this page only moves audio and renders state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import DraftReview from "./DraftReview";
import ShareButton from "./ShareButton";
import { OFFLINE_TEXT, readJson } from "@/lib/http";
import { checkUploadSize, friendlySttError, UPLOAD_LIMITS } from "@/lib/speech/upload";

type Phase = "idle" | "starting" | "recording" | "finalizing" | "done" | "error";
type Transport = "stream" | "upload";

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

// How many gateway connections one recording will tolerate before switching to
// upload. Each failed pre-session connect costs nothing (no session was billed).
const MAX_GENS = 3;

// NEXT_PUBLIC_VOICE_ENABLED=false hides the microphone entirely; the app then leads with typing.
const VOICE = process.env.NEXT_PUBLIC_VOICE_ENABLED !== "false";
// Chosen at build time in next.config.ts ("upload" on Vercel).
const DEFAULT_TRANSPORT: Transport = process.env.NEXT_PUBLIC_VOICE_TRANSPORT === "upload" ? "upload" : "stream";
// Session ids, credit balances and latencies help developers, not traders.
const SHOW_META = process.env.NODE_ENV !== "production";

const STATUS: Record<Phase, string> = {
  idle: "",
  starting: "Getting the microphone ready…",
  recording: "Listening. Speak now, then tap Stop recording.",
  finalizing: "Turning your recording into text…",
  done: "",
  error: "",
};

function formatClock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

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

function MicIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const labels = [VOICE ? "Say or type" : "Type", "Check", "Create"];
  return (
    <ol className="steps" aria-label="Progress">
      {labels.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <li key={label} className={`step step-${state}`} aria-current={n === current ? "step" : undefined}>
            <span className="step-n" aria-hidden="true">{n < current ? "✓" : n}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
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
  const [transport, setTransport] = useState<Transport>(DEFAULT_TRANSPORT);
  const [flow, setFlow] = useState<"compose" | "review" | "issued">("compose");
  const [issued, setIssued] = useState<{ id: string; number: string; total: string | null } | null>(null);
  const [typing, setTyping] = useState(!VOICE);
  const [typed, setTyped] = useState("");
  // True when the text box holds words we heard (so it is labelled as such).
  const [heard, setHeard] = useState(false);
  // Set when the gateway's live stream broke and it is buffering for Intron's file API.
  const [degradedNote, setDegradedNote] = useState("");

  // Written synchronously alongside setPhase, so socket callbacks that fire in the
  // same tick as a state change never read a stale phase.
  const phaseRef = useRef<Phase>(phase);
  const go = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const openRef = useRef(false);
  const intronReadyRef = useRef(false);
  const gensRef = useRef(0);
  const commitPendingRef = useRef(false);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // One id per recording. Every async callback (worklet, socket, upload) checks it,
  // so events from a cancelled or superseded recording change nothing.
  const recordingIdRef = useRef(0);
  const transportRef = useRef<Transport>(DEFAULT_TRANSPORT);
  // The whole recording, kept so a pre-session reconnect or the upload can send all of it.
  const recordingRef = useRef<ArrayBuffer[]>([]);
  const recordedBytesRef = useRef(0);
  // Exactly one upload per recording.
  const uploadingRef = useRef(false);
  const uploadAbortRef = useRef<AbortController | null>(null);

  const errorRef = useRef<HTMLDivElement | null>(null);
  const languageRef = useRef(language);
  useEffect(() => { languageRef.current = language; }, [language]);

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
    recordingRef.current = [];
    recordedBytesRef.current = 0;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    uploadingRef.current = false;
    const ws = wsRef.current;
    wsRef.current = null; // retires the socket: its late events are ignored
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }, [teardownAudio]);

  useEffect(() => closeAll, [closeAll]);

  // Move focus to a new error so screen reader and keyboard users land on it.
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const fail = useCallback((message: string) => {
    setError(message);
    go("error");
    closeAll();
  }, [closeAll, go]);

  /** Put transcribed words into the editable box for the trader to check. */
  const acceptTranscript = useCallback((text: string) => {
    closeAll();
    if (!text.trim()) { setError(friendlySttError("INSUFFICIENT_AUDIO_ACTIVITY")); go("error"); return; }
    setPartial(""); setError("");
    setTyped(text.trim()); setHeard(true); setTyping(true);
    go("done");
  }, [closeAll, go]);

  const beginRecording = useCallback(() => {
    if (timerRef.current == null) {
      timerRef.current = setInterval(() => setElapsed((Date.now() - startedAtRef.current) / 1000), 200);
    }
    go("recording");
  }, [go]);

  const uploadRecording = useCallback(async (id: number) => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    // A stream recording that fell back late may be longer than the upload limit;
    // send the first two minutes rather than refuse the whole thing.
    let total = Math.min(recordedBytesRef.current, UPLOAD_LIMITS.maxBytes);
    total -= total % 2;
    const size = checkUploadSize(total);
    if (!size.ok) { fail(size.message); return; }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const buf of recordingRef.current) {
      if (offset >= total) break;
      const chunk = new Uint8Array(buf, 0, Math.min(buf.byteLength, total - offset));
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const ctrl = new AbortController();
    uploadAbortRef.current = ctrl;
    try {
      const res = await fetch(`/api/voice/transcribe?lang=${encodeURIComponent(languageRef.current)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
        signal: ctrl.signal,
      });
      const data = await readJson(res);
      if (recordingIdRef.current !== id) return;
      if (data.ok && typeof data.transcript === "string") {
        if (SHOW_META && typeof data.msStopToFinal === "number") setMeta(`heard in ${Math.round(data.msStopToFinal / 100) / 10}s · upload`);
        acceptTranscript(data.transcript);
      } else {
        fail(String(data.error ?? friendlySttError(undefined)));
      }
    } catch (e) {
      if (recordingIdRef.current !== id || (e as Error).name === "AbortError") return;
      fail(`${OFFLINE_TEXT} You can also type the details.`);
    }
  }, [fail, acceptTranscript]);

  /**
   * Switch this recording from the live gateway to record-then-upload. Only called
   * while no Intron session exists, so nothing was billed or transcribed on the
   * socket being retired; retiring it first means its late events are ignored.
   */
  const fallbackToUpload = useCallback((id: number) => {
    if (recordingIdRef.current !== id || transportRef.current === "upload") return;
    transportRef.current = "upload";
    setTransport("upload");
    setPartial("");
    const ws = wsRef.current;
    wsRef.current = null;
    openRef.current = false;
    intronReadyRef.current = false;
    commitPendingRef.current = false;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    if (phaseRef.current === "finalizing") void uploadRecording(id);
    else beginRecording();
  }, [beginRecording, uploadRecording]);

  const openGatewayRef = useRef<(id: number) => void>(() => {});

  /**
   * Open (or re-open) the gateway WebSocket for recording `id`. A failure before
   * the socket ever opens means there is no gateway here (e.g. a serverless host),
   * so the recording switches to upload at once. A pre-session failure after it
   * opened reconnects (free), up to MAX_GENS, then switches to upload. A failure
   * after the session exists is reported, never retried.
   */
  const openGateway = useCallback((id: number) => {
    intronReadyRef.current = false;
    openRef.current = false; // the new socket is not writable until its `open` fires
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/voice/stream?lang=${encodeURIComponent(languageRef.current)}`);
    ws.binaryType = "arraybuffer";
    const prior = wsRef.current;
    wsRef.current = ws;
    if (prior && prior.readyState <= WebSocket.OPEN) prior.close(); // retire a still-alive socket

    const live = () => recordingIdRef.current === id && wsRef.current === ws;
    let opened = false;
    // `torn` makes reconnect-once-per-socket: after we choose to reconnect, the
    // eventual error/close events of this dead socket must not double up.
    let torn = false;
    const reconnect = () => {
      if (torn) return;
      torn = true;
      if (!opened) { fallbackToUpload(id); return; }
      gensRef.current += 1;
      if (gensRef.current >= MAX_GENS) { fallbackToUpload(id); return; }
      setTimeout(() => { if (recordingIdRef.current === id && transportRef.current === "stream") openGatewayRef.current(id); }, 250);
    };

    ws.onopen = () => {
      if (!live()) return;
      opened = true;
      openRef.current = true;
      // Replay the whole recording: nothing reached a session on an earlier socket.
      for (const buf of recordingRef.current) ws.send(buf);
      if (commitPendingRef.current) ws.send(JSON.stringify({ type: "commit" }));
      if (phaseRef.current === "starting") beginRecording();
    };
    ws.onmessage = (e) => {
      if (!live()) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "open") {
        intronReadyRef.current = true; // a session exists now: this connect is billed
        if (SHOW_META) setMeta(`session ${(String(msg.sessionId ?? "")).slice(0, 8)}… · credits ${msg.creditBalance}`);
      } else if (msg.type === "partial") {
        setPartial(String(msg.text ?? ""));
      } else if (msg.type === "degraded") {
        // Live streaming broke, but the gateway is buffering the recording and will
        // transcribe it via Intron's file API when the user stops. Keep recording.
        setDegradedNote(String(msg.message ?? "Live transcription is temporarily unavailable. Keep speaking — we'll process your recording when you stop."));
        setPartial("");
      } else if (msg.type === "final") {
        const r = msg.result as { transcript?: string; msStopToFinal?: number | null; transport?: string };
        setDegradedNote("");
        if (SHOW_META) setMeta(r?.msStopToFinal ? `heard in ${Math.round(r.msStopToFinal / 100) / 10}s` : `processed via ${r?.transport ?? "gateway"}`);
        acceptTranscript(r?.transcript ?? "");
      } else if (msg.type === "error") {
        // The gateway owns recovery (it retries upstream and falls back to Intron's
        // file API). An error MESSAGE is its final decision, not a transport blip:
        // show it, never reconnect (that would be a retry storm).
        fail(String(msg.message ?? friendlySttError(String(msg.code ?? ""))));
      }
    };
    ws.onerror = () => {
      if (!live()) return;
      if (!intronReadyRef.current) reconnect();
      else fail("The connection stopped. Please record again or type the details.");
    };
    ws.onclose = () => {
      if (!live()) return;
      if (!intronReadyRef.current) { reconnect(); return; }
      if (phaseRef.current === "recording") {
        fail("The connection stopped while we were still listening. Please record again or type the details.");
      } else if (phaseRef.current === "finalizing") {
        fail("The connection stopped before we got the text. Please record again or type the details.");
      }
    };
  }, [fail, acceptTranscript, beginRecording, fallbackToUpload]);

  useEffect(() => { openGatewayRef.current = openGateway; }, [openGateway]);

  const stop = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    const id = recordingIdRef.current;
    teardownAudio();
    go("finalizing");
    if (transportRef.current === "upload") { void uploadRecording(id); return; }
    commitPendingRef.current = true;
    if (openRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "commit" }));
    }
  }, [teardownAudio, go, uploadRecording]);

  const stopRef = useRef(stop);
  useEffect(() => { stopRef.current = stop; }, [stop]);

  const start = useCallback(async () => {
    closeAll();
    const id = ++recordingIdRef.current;
    transportRef.current = DEFAULT_TRANSPORT;
    setTransport(DEFAULT_TRANSPORT);
    setError(""); setPartial(""); setMeta(null); setElapsed(0); setDegradedNote("");
    setFlow("compose"); setIssued(null); setTyping(false); setHeard(false);
    go("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (recordingIdRef.current !== id) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-recorder-worklet.js");
      if (recordingIdRef.current !== id) return; // cancelled meanwhile; closeAll released the context
      if (ctx.state === "suspended") await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-recorder");
      nodeRef.current = node;
      node.port.onmessage = (e) => {
        if (recordingIdRef.current !== id) return;
        const d = e.data;
        if (d.type === "level") { setLevel(Math.min(1, d.value * 1.6)); return; }
        if (d.type === "audio") {
          const buf = d.buffer as ArrayBuffer;
          // One cap for both transports: the gateway (server.mts) and the upload route
          // both refuse more than 60 s, the length Intron's file API is used for.
          if (recordedBytesRef.current + buf.byteLength > UPLOAD_LIMITS.maxBytes) {
            stopRef.current(); // the limit is reached: finish with what we have
            return;
          }
          recordingRef.current.push(buf);
          recordedBytesRef.current += buf.byteLength;
          if (transportRef.current === "stream" && openRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(buf);
          }
        }
      };
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);

      startedAtRef.current = Date.now();
      if (DEFAULT_TRANSPORT === "upload") beginRecording();
      else openGateway(id);
    } catch (e) {
      if (recordingIdRef.current !== id) return;
      const name = (e as Error).name;
      fail(MIC_ERRORS[name] ?? "We couldn't start recording. You can type the details instead.");
    }
  }, [closeAll, go, beginRecording, openGateway, fail]);

  const cancel = useCallback(() => {
    recordingIdRef.current++;
    closeAll();
    go("idle");
    setPartial(""); setError("");
  }, [closeAll, go]);

  const typeInstead = useCallback(() => {
    recordingIdRef.current++;
    closeAll();
    setError(""); go("idle"); setHeard(false); setTyping(true);
  }, [closeAll, go]);

  // Return to a clean compose screen (after an invoice is created).
  const reset = useCallback(() => {
    recordingIdRef.current++;
    closeAll();
    setError(""); setPartial(""); setFinalText(""); setMeta(null); setElapsed(0);
    setFlow("compose"); setIssued(null); setTyped(""); setHeard(false); setTyping(!VOICE); go("idle");
  }, [closeAll, go]);

  const checkTyped = useCallback(() => {
    const t = typed.trim();
    if (!t) return;
    recordingIdRef.current++;
    closeAll();
    setError(""); setPartial(""); setFinalText(t); go("done"); setFlow("review");
  }, [typed, closeAll, go]);

  const busy = phase === "starting" || phase === "recording" || phase === "finalizing";
  const langLabel = LANGS.find((l) => l.code === language)?.label ?? language;
  const step = flow === "compose" ? 1 : flow === "review" ? 2 : 3;
  const remaining = UPLOAD_LIMITS.maxSeconds - elapsed;
  const showIntro = flow === "compose" && !busy && !error && !heard;

  return (
    <main id="main" className="sr-page">
      <div className="sr-card">
        <header className="sr-brand">
          <Mark />
          <h1 className="sr-wordmark">Make an invoice</h1>
          <Link className="sr-help-link" href="/help">Need help?</Link>
        </header>

        <Steps current={step} />

        {showIntro && (
          <>
            <p className="sr-tagline">
              {VOICE && !typing ? "Say" : "Write"} the customer, what you sold, the quantity, and the price.
            </p>
            <p className="sr-example">
              Example: <span lang="en">&ldquo;Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each.&rdquo;</span>
            </p>
          </>
        )}

        {/* Screen reader announcements for recording progress. */}
        <div className="sr-visually-hidden" role="status" aria-live="polite">{STATUS[phase]}</div>

        {/* Compose: start speaking */}
        {VOICE && flow === "compose" && !typing && !busy && !error && (
          <div className="voice-start">
            <button className="sr-btn sr-primary sr-btn-lg" onClick={start}>
              <MicIcon size={22} /> Start speaking
            </button>
            <div className="lang-row">
              <label className="sr-label" htmlFor="lang">Speech language</label>
              <select id="lang" className="sr-select" value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
            <p className="sr-expect">You&apos;ll check the words and the details before anything is created.</p>
            <button className="sr-linkbtn" onClick={typeInstead}>Type instead</button>
          </div>
        )}

        {/* Starting */}
        {phase === "starting" && (
          <div className="rec-panel" aria-busy="true">
            <div className="rec-working"><span className="spinner" aria-hidden="true" /> Getting the microphone ready…</div>
            <div className="sr-controls">
              <button className="sr-btn sr-ghost" onClick={cancel}>Cancel</button>
            </div>
          </div>
        )}

        {/* Recording */}
        {phase === "recording" && (
          <div className="rec-panel">
            <div className="rec-head">
              <span className="rec-live"><span className="sr-dot" aria-hidden="true" /> Listening</span>
              <span className="sr-timer" aria-hidden="true">{formatClock(elapsed)}</span>
            </div>
            <div className="sr-meter" role="progressbar" aria-label="Microphone level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="sr-meterFill" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            {degradedNote
              ? <p className="sr-degraded" role="status">{degradedNote}</p>
              : <p className="sr-meta">Speaking {langLabel} · up to {UPLOAD_LIMITS.maxSeconds} seconds</p>}
            {transport === "stream" && !degradedNote && (
              <div className="sr-transcript" aria-live="polite">
                {partial
                  ? <><span className="sr-label">Words heard so far</span><br /><span className="sr-partial">{partial}</span></>
                  : <span className="sr-placeholder">Your words will appear here.</span>}
              </div>
            )}
            {remaining <= 15 && (
              <p className="rec-warn" role="status">Recording stops in {Math.max(0, Math.ceil(remaining))}s</p>
            )}
            <div className="sr-controls">
              <button className="sr-btn sr-danger sr-btn-lg" onClick={stop}>
                <StopIcon /> Stop recording
              </button>
              <button className="sr-btn sr-ghost" onClick={cancel}>Cancel</button>
            </div>
          </div>
        )}

        {/* Turning audio into text */}
        {phase === "finalizing" && (
          <div className="rec-panel" aria-busy="true">
            <div className="rec-working"><span className="spinner" aria-hidden="true" /> Turning your recording into text…</div>
            {transport === "stream" && partial && (
              <div className="sr-transcript"><span className="sr-partial">{partial}</span></div>
            )}
            <div className="sr-controls">
              <button className="sr-btn sr-ghost" onClick={cancel}>Cancel</button>
            </div>
          </div>
        )}

        {/* Compose: type, or fix the words we heard */}
        {flow === "compose" && typing && !busy && !error && (
          <div className="rev">
            <label className="rev-h2" htmlFor="typed">{heard ? "Here’s what we heard" : "Type your sale"}</label>
            {heard && <p className="sr-expect">Fix any wrong words, then check the details.</p>}
            <textarea id="typed" className="type-area" value={typed}
              placeholder="e.g. Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); checkTyped(); } }} />
            <div className="sr-controls">
              <button className="sr-btn sr-primary" onClick={checkTyped} disabled={!typed.trim()}>Check the details</button>
              {VOICE && (heard
                ? <button className="sr-btn sr-ghost" onClick={start}><MicIcon /> Record again</button>
                : <button className="sr-btn sr-ghost" onClick={() => setTyping(false)}><MicIcon /> Speak instead</button>)}
            </div>
            <p className="sr-meta kbd-hint">Tip: press Ctrl + Enter to continue.</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rev">
            <div className="sr-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>
            <div className="sr-controls">
              {VOICE ? (
                <>
                  <button className="sr-btn sr-primary" onClick={start}><MicIcon /> Record again</button>
                  <button className="sr-btn sr-ghost" onClick={typeInstead}>Type instead</button>
                </>
              ) : (
                <button className="sr-btn sr-primary" onClick={typeInstead}>Type again</button>
              )}
            </div>
          </div>
        )}

        {flow === "review" && finalText && !error && (
          <DraftReview
            transcript={finalText}
            onIssued={(id, number, total) => { setIssued({ id, number, total }); setFlow("issued"); }}
            onEditWords={() => { setFlow("compose"); setTyping(true); }}
          />
        )}

        {flow === "issued" && issued && (
          <div className="sr-created">
            <div><span className="sr-badge sr-badgeFinal">Invoice created</span></div>
            <p className="created-line">Invoice <strong>{issued.number}</strong></p>
            {issued.total && <p className="sr-created-total">{issued.total}</p>}
            <p className="sr-expect">It&apos;s saved. It&apos;s a request for payment — not a receipt.</p>
            <div className="sr-controls">
              <Link className="sr-btn sr-primary" href={`/invoice/${issued.id}`}>View invoice</Link>
              <ShareButton id={issued.id} number={issued.number} />
              <button className="sr-btn sr-ghost" onClick={reset}>Create another</button>
            </div>
          </div>
        )}

        {SHOW_META && meta && <p className="sr-meta">dev · {meta}</p>}
      </div>

      <p className="sr-foot">
        {VOICE
          ? "Your recording is only used to turn your words into text. This page doesn't store it."
          : "Type a sale in your own words and check the details before creating the invoice."}
      </p>
    </main>
  );
}

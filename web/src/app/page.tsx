"use client";

/**
 * Sautice recorder.
 *
 * Captures the microphone as 16 kHz PCM16 (via the AudioWorklet in
 * /pcm-recorder-worklet.js -- NOT MediaRecorder, whose Opus output the Intron
 * socket cannot read), streams it to the voice gateway at /api/voice/stream, and
 * shows interim and final transcripts. The gateway holds the Intron credentials
 * and speaks the streaming protocol; this page only moves audio and renders state.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "starting" | "recording" | "finalizing" | "done" | "error";

const LANGS: { code: string; label: string }[] = [
  { code: "pcm", label: "Pidgin · English" },
  { code: "yo", label: "Yoruba · English" },
  { code: "ig", label: "Igbo · English" },
  { code: "ha", label: "Hausa · English" },
  { code: "en", label: "English" },
];

const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: "Microphone access was blocked. Allow it in your browser and try again.",
  NotFoundError: "No microphone was found. Connect one and try again.",
  NotReadableError: "The microphone is in use by another app. Close it and try again.",
  SecurityError: "Recording needs a secure (https) page or localhost.",
};

function Mark() {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="Sautice">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 13 Q5.5 3.5 8.5 13 Q11.5 22.5 14.5 13 L29.5 13" stroke="currentColor" strokeWidth="2.6" />
        <path d="M17 20.5 L29.5 20.5" stroke="var(--tally)" strokeWidth="2.6" />
      </g>
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

  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const queueRef = useRef<ArrayBuffer[]>([]);
  const openRef = useRef(false);
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
    queueRef.current = [];
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }, [teardownAudio]);

  // Release everything if the component unmounts mid-recording.
  useEffect(() => closeAll, [closeAll]);

  const fail = useCallback((message: string) => {
    setError(message);
    setPhase("error");
    closeAll();
  }, [closeAll]);

  const start = useCallback(async () => {
    setError(""); setPartial(""); setFinalText(""); setMeta(null); setElapsed(0);
    setPhase("starting");
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
          if (openRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(d.buffer);
          } else {
            queueRef.current.push(d.buffer); // buffer until the gateway socket opens
          }
        }
      };
      // A capture-only worklet must still be pulled by the graph, so route it to the
      // destination through a muted gain -- silent output, no echo of the microphone.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/voice/stream?lang=${encodeURIComponent(language)}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        openRef.current = true;
        for (const buf of queueRef.current) ws.send(buf);
        queueRef.current = [];
        startedAtRef.current = Date.now();
        setPhase("recording");
        timerRef.current = setInterval(() => setElapsed((Date.now() - startedAtRef.current) / 1000), 100);
      };
      ws.onmessage = (e) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === "open") {
          setMeta(`session ${(String(msg.sessionId ?? "")).slice(0, 8)}… · credits ${msg.creditBalance}`);
        } else if (msg.type === "partial") {
          setPartial(String(msg.text ?? ""));
        } else if (msg.type === "final") {
          const r = msg.result as { transcript?: string; msStopToFinal?: number | null; partialCount?: number };
          setFinalText(r?.transcript ?? "");
          setPartial("");
          setMeta(`${r?.partialCount ?? 0} partials · ${Math.round(r?.msStopToFinal ?? 0)}ms to final`);
          setPhase("done");
          closeAll();
        } else if (msg.type === "error") {
          fail(String(msg.message ?? "Transcription failed. Please try again."));
        }
      };
      ws.onerror = () => { if (phaseRef.current !== "done") fail("Lost the connection to the voice service."); };
      ws.onclose = () => {
        // A close before a final result, with no explicit error, is still a failure.
        if (openRef.current && phaseRef.current === "recording") fail("The connection closed before a transcript arrived.");
      };
    } catch (e) {
      const name = (e as Error).name;
      fail(MIC_ERRORS[name] ?? `Could not start recording: ${(e as Error).message}`);
    }
  }, [language, closeAll, fail]);

  const stop = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    // Stop capturing, ask the gateway to commit, and wait for the final transcript.
    teardownAudio();
    setPhase("finalizing");
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "commit" }));
    }
  }, [teardownAudio]);

  const cancel = useCallback(() => { closeAll(); setPhase("idle"); setPartial(""); setError(""); }, [closeAll]);

  const busy = phase === "starting" || phase === "recording" || phase === "finalizing";
  const statusText = {
    idle: "Ready when you are.",
    starting: "Requesting the microphone…",
    recording: "Listening…",
    finalizing: "Transcribing…",
    done: "Done.",
    error: "",
  }[phase];

  return (
    <div className="sr-page">
      <main className="sr-card">
        <header className="sr-brand">
          <Mark />
          <div>
            <div className="sr-wordmark">Sautice</div>
          </div>
        </header>
        <p className="sr-tagline">
          Speak a sale the way you would to a customer. Sautice turns it into a transcript you can
          review — the first step to an invoice.
        </p>

        <div className="sr-row">
          <label className="sr-label" htmlFor="lang">Language</label>
          <select
            id="lang"
            className="sr-select"
            value={language}
            disabled={busy}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>

        <div className="sr-controls">
          {phase !== "recording" && phase !== "finalizing" && (
            <button className="sr-btn sr-primary" onClick={start} disabled={phase === "starting"}>
              {phase === "starting" ? "Starting…" : phase === "done" || phase === "error" ? "Record again" : "Record"}
            </button>
          )}
          {phase === "recording" && (
            <>
              <button className="sr-btn sr-danger" onClick={stop}>
                <span className="sr-dot" aria-hidden /> Stop
              </button>
              <button className="sr-btn sr-ghost" onClick={cancel}>Cancel</button>
              <span className="sr-timer" aria-hidden>{elapsed.toFixed(1)}s</span>
            </>
          )}
          {phase === "finalizing" && <span className="sr-timer">Transcribing…</span>}
        </div>

        {(phase === "recording" || phase === "finalizing") && (
          <div className="sr-meter" role="progressbar" aria-label="Microphone level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="sr-meterFill" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        )}

        <div className="sr-status" role="status" aria-live="polite">
          {statusText && <span>{statusText}</span>}
          {meta && <span className="sr-meta">· {meta}</span>}
        </div>

        {error ? (
          <div className="sr-error" role="alert">{error}</div>
        ) : (
          <div className="sr-transcript" aria-live="polite">
            {finalText ? (
              <>
                <span className="sr-badge sr-badgeFinal">Final</span>{" "}
                {finalText}
              </>
            ) : partial ? (
              <span className="sr-partial">{partial}</span>
            ) : (
              <span className="sr-placeholder">Your transcript will appear here.</span>
            )}
          </div>
        )}
      </main>

      <p className="sr-foot">
        Audio streams to this app&apos;s voice gateway, which holds the Intron credentials — the key
        never reaches the browser. Recordings are not stored server-side by this page.
      </p>
    </div>
  );
}

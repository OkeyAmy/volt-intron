/**
 * Custom server: Next.js plus a WebSocket voice gateway on one port.
 *
 * Why this exists: Intron authenticates its STT socket with an `Authorization`
 * header on the HTTP handshake, and browser JavaScript cannot set handshake
 * headers. Next.js Route Handlers cannot upgrade a connection to a WebSocket, so
 * a custom server is the supported way to host one alongside the app. Forced by
 * the protocol rather than chosen.
 *
 * This file is NOT compiled by Next, so it runs through tsx, and it must not be
 * combined with `output: "standalone"`.
 */
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { IntronStreamSession } from "./src/lib/speech/intron-stream.js";
import { transcribeFile } from "./src/lib/speech/intron-file.js";
import { friendlyVoiceError } from "./src/lib/speech/errors.js";
import { parseLanguage, isAllowedOrigin, originAllowlist, LIMITS } from "./src/lib/gateway/guards.js";

// One documented env-loading strategy: read the repo-root `.env` then this app's
// `web/.env`, so the gateway finds INTRON_API_KEY the same way whether started from
// the repo root or from web/. A missing file is fine; the later load wins.
for (const rel of ["../.env", "./.env"]) {
  try { process.loadEnvFile(new URL(rel, import.meta.url)); } catch { /* optional */ }
}

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const VOICE_PATH = "/api/voice/stream";
const ALLOWED_ORIGINS = originAllowlist(process.env.APP_URL, dev, port);

const app = next({ dev });

// Both handlers must be acquired AFTER prepare(); getUpgradeHandler() throws otherwise.
await app.prepare();
const handle = app.getRequestHandler();
const upgradeHandler = app.getUpgradeHandler();

const server = createServer((req, res) => { handle(req, res); });

// maxPayload is enforced by ws itself, before a frame is buffered into memory.
const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });

let activeSessions = 0;

/** Refuse an upgrade before it becomes a socket. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head) => {
  const { pathname, searchParams } = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // Claim only our own path. Everything else - crucially Next's HMR socket in dev -
  // goes back to Next, otherwise hot reload silently dies.
  if (pathname !== VOICE_PATH) {
    upgradeHandler(req, socket, head);
    return;
  }

  // A WebSocket handshake is not subject to the same-origin policy, so without this
  // check any page the user visits could open this socket and spend Intron credits.
  // Always allow the gateway's OWN origin (the browser loaded the page from this same
  // host, so origin === host is same-origin and safe) in addition to the configured
  // APP_URL allowlist. This lets a container deploy work without setting APP_URL.
  const host = req.headers.host;
  const selfOrigins = host ? [`https://${host}`, `http://${host}`] : [];
  if (!isAllowedOrigin(req.headers.origin, [...ALLOWED_ORIGINS, ...selfOrigins])) {
    rejectUpgrade(socket, 403, "Forbidden");
    return;
  }

  const language = parseLanguage(searchParams.get("lang"));
  if (!language) {
    rejectUpgrade(socket, 400, "Bad Request");
    return;
  }

  if (activeSessions >= LIMITS.maxConcurrentSessions) {
    rejectUpgrade(socket, 503, "Service Unavailable");
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => onVoiceSocket(ws, language));
});

// One invoice recording is intentionally bounded so the buffered utterance always
// fits Intron's 120s file-API limit and never grows memory without bound.
// 60s of 16kHz mono PCM16 ≈ 60 × 16000 × 2 = 1.92 MB.
const RECORDING_MAX_BYTES = 60 * 16000 * 2;

function onVoiceSocket(ws: WebSocket, language: ReturnType<typeof parseLanguage> & string) {
  const apiKey = process.env.INTRON_API_KEY ?? process.env.API_KEY;
  const send = (msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const rec = randomUUID().slice(0, 8);
  const log = (m: string) => console.log(`[voice] rec=${rec} ${m}`);
  const startedAt = Date.now();

  if (!apiKey) {
    send({ type: "error", code: "NO_API_KEY", message: friendlyVoiceError("NO_API_KEY") });
    ws.close();
    return;
  }

  activeSessions++;
  log("browser-connected");

  // A complete copy of the current utterance, for the file fallback. Bounded.
  const pcmChunks: Buffer[] = [];
  let bytesReceived = 0;
  let committed = false;   // the user pressed Stop
  let degraded = false;    // streaming failed recoverably; buffering for the file API
  let settled = false;     // exactly one result wins
  let closed = false;
  let partialCount = 0;

  const clearBuffer = () => { pcmChunks.length = 0; };

  const settleFinal = (transcript: string, transport: "stream" | "file", extra: Record<string, unknown> = {}) => {
    if (settled) return;
    settled = true;
    log(`completed transport=${transport} latency=${Date.now() - startedAt}ms bytes=${bytesReceived}`);
    send({ type: "final", result: { transcript, transport, partialCount, ...extra } });
    clearBuffer();
    ws.close();
  };

  const settleError = (code: string) => {
    if (settled) return;
    settled = true;
    log(`failed code=${code} latency=${Date.now() - startedAt}ms`);
    send({ type: "error", code, message: friendlyVoiceError(code) });
    clearBuffer();
    ws.close();
  };

  const runFallback = async () => {
    if (settled) return;
    const pcm = Buffer.concat(pcmChunks, bytesReceived);
    if (pcm.length < 2 * 16000 * 0.3) { settleError("EMPTY_RECORDING"); return; } // < ~0.3s of audio
    log(`switching-to=file-fallback bytes=${pcm.length}`);
    try {
      const r = await transcribeFile(pcm, { apiKey, language });
      if (settled) return;
      log(`fallback-success dur=${r.durationSec}s`);
      settleFinal(r.transcript, "file", { durationSec: r.durationSec });
    } catch (e) {
      if (settled) return;
      const code = (e as { code?: string }).code ?? "FALLBACK_FAILED";
      log(`fallback-error code=${code} recoverable=${(e as { recoverable?: boolean }).recoverable}`);
      settleError(code === "AUTHENTICATION_ERROR" ? "AUTHENTICATION_ERROR" : "FALLBACK_FAILED");
    }
  };

  const session = new IntronStreamSession({ apiKey, language, paceMs: 50, maxAttempts: 6 }, (event) => {
    if (settled) return;
    if (event.type === "open") { log("session-created"); send(event); return; }
    if (event.type === "partial") { partialCount++; send(event); return; }
    if (event.type === "final") { settleFinal(event.result.transcript, "stream", { msStopToFinal: event.result.msStopToFinal }); return; }
    // event.type === "error"
    const detail = (event as { detail?: { recoverable?: boolean; stage?: string } }).detail;
    const recoverable = detail?.recoverable !== false;
    log(`upstream-error code=${event.code} stage=${detail?.stage} recoverable=${recoverable}`);
    if (!recoverable) {
      // Auth/quota/bad-input: the same provider path won't help. No fallback, no retry.
      settleError(event.code === "AUTHENTICATION_ERROR" ? "AUTHENTICATION_ERROR"
        : event.code === "QUOTA_EXCEEDED" ? "QUOTA_EXCEEDED" : "STREAM_FATAL");
      return;
    }
    // Recoverable transport/protocol failure (WS_ERR_EXPECTED_FIN, SOCKET_ERROR,
    // CLOSED_EARLY, timeouts): keep the recording. Fall back to the file API — now if
    // the user already stopped, otherwise the moment they do.
    degraded = true;
    session.close();
    if (committed) { void runFallback(); }
    else { send({ type: "degraded", message: "Live transcription is temporarily unavailable. Keep speaking — we'll process your recording when you stop." }); }
  });

  const teardown = () => {
    if (closed) return;
    closed = true;
    activeSessions--;
    session.close();
    if (!settled) clearBuffer();
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (settled) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      bytesReceived += chunk.length;
      if (bytesReceived > RECORDING_MAX_BYTES) { settleError("AUDIO_TOO_LONG"); return; }
      pcmChunks.push(chunk);                 // always buffer, for the fallback
      if (!degraded) session.push(chunk);    // and stream while the socket is healthy
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "commit") {
        committed = true;
        log(`commit bytes=${bytesReceived} degraded=${degraded}`);
        if (degraded) { void runFallback(); }
        else { session.commit(); }
      }
    } catch {
      send({ type: "error", code: "BAD_MESSAGE", message: friendlyVoiceError("BAD_MESSAGE") });
    }
  });

  // A closed tab must not leave an upstream session burning credits.
  ws.on("close", teardown);
  ws.on("error", teardown);
}

server.listen(port, () => {
  console.log(`> Sautice on http://localhost:${port}  (voice gateway at ${VOICE_PATH})`);
  console.log(`  origins allowed: ${ALLOWED_ORIGINS.join(", ") || "(none - gateway refuses all)"}`);
});

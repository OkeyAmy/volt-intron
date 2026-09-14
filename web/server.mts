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
import { IntronStreamSession } from "./src/lib/speech/intron-stream.js";
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
  if (!isAllowedOrigin(req.headers.origin, ALLOWED_ORIGINS)) {
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

function onVoiceSocket(ws: WebSocket, language: ReturnType<typeof parseLanguage> & string) {
  const apiKey = process.env.INTRON_API_KEY ?? process.env.API_KEY;
  const send = (msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

  if (!apiKey) {
    // Say what is wrong and how to fix it, in the interface's voice.
    send({ type: "error", code: "NO_API_KEY",
           message: "Speech is not configured on the server. Set INTRON_API_KEY and restart." });
    ws.close();
    return;
  }

  activeSessions++;
  let bytesReceived = 0;
  let closed = false;

  const session = new IntronStreamSession({ apiKey, language }, (event) => {
    send(event);
    if (event.type === "final" || event.type === "error") ws.close();
  });

  const teardown = () => {
    if (closed) return;
    closed = true;
    activeSessions--;
    session.close();
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      bytesReceived += chunk.length;
      // Past Intron's own 300s ceiling the upstream session dies anyway, so accepting
      // more audio only wastes memory and credits.
      if (bytesReceived > LIMITS.maxAudioBytes) {
        send({ type: "error", code: "AUDIO_TOO_LONG",
               message: "That recording is longer than five minutes. Please record a shorter one." });
        ws.close();
        return;
      }
      session.push(chunk);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "commit") session.commit();
    } catch {
      send({ type: "error", code: "BAD_MESSAGE",
             message: "Expected binary audio or a JSON control message." });
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

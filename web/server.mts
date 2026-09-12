/**
 * Custom server: Next.js plus a WebSocket gateway on one port.
 *
 * Why this exists: Intron authenticates its STT socket with an `Authorization`
 * header on the HTTP handshake, and browser JavaScript cannot set handshake
 * headers. Next.js Route Handlers cannot upgrade a connection to a WebSocket, so
 * a custom server is the supported way to host one alongside the app. This is
 * forced by the protocol rather than chosen.
 *
 * Note: this file is NOT compiled by Next, so it runs through tsx.
 * It also must not be combined with `output: "standalone"`.
 */
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { IntronStreamSession, type LanguageCode } from "./src/lib/speech/intron-stream.js";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const VOICE_PATH = "/api/voice/stream";

const app = next({ dev });

// Both handlers must be acquired AFTER prepare(); getUpgradeHandler() throws otherwise.
await app.prepare();
const handle = app.getRequestHandler();
const upgradeHandler = app.getUpgradeHandler();

const server = createServer((req, res) => { handle(req, res); });
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket: Duplex, head) => {
  const { pathname, searchParams } = new URL(req.url ?? "/", `http://${req.headers.host}`);
  // Claim only our own path. Everything else — crucially Next's HMR socket in dev —
  // goes back to Next, otherwise hot reload silently dies.
  if (process.env.LOG_UPGRADES) console.log(`  [upgrade] ${pathname}`);
  if (pathname === VOICE_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => onVoiceSocket(ws, searchParams));
  } else {
    upgradeHandler(req, socket, head);
  }
});

function onVoiceSocket(ws: WebSocket, params: URLSearchParams) {
  const apiKey = process.env.INTRON_API_KEY ?? process.env.API_KEY;
  const language = (params.get("lang") ?? "pcm") as LanguageCode;

  const send = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  if (!apiKey) {
    // State what is wrong and what to do about it, in the interface's voice.
    send({ type: "error", code: "NO_API_KEY",
           message: "Speech is not configured on the server. Set INTRON_API_KEY and restart." });
    ws.close();
    return;
  }

  const session = new IntronStreamSession({ apiKey, language }, (event) => {
    send(event);
    if (event.type === "final" || event.type === "error") ws.close();
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "commit") session.commit();
    } catch {
      send({ type: "error", code: "BAD_MESSAGE", message: "Expected binary audio or a JSON control message." });
    }
  });

  // The speaker closing the tab must not leave an Intron session burning credits.
  ws.on("close", () => session.close());
  ws.on("error", () => session.close());
}

server.listen(port, () => {
  console.log(`> Sautice on http://localhost:${port}  (voice gateway at ${VOICE_PATH})`);
});

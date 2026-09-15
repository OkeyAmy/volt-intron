/**
 * Record-then-upload transcription: the voice path for hosts that cannot keep the
 * live WebSocket gateway (web/server.mts) running, such as Vercel.
 *
 * The browser POSTs one whole utterance as raw 16 kHz mono PCM16. This handler wraps
 * it as a WAV and sends it to Intron's synchronous file API (the same Sahara
 * transcription the gateway falls back to), then answers with the transcript. The
 * Intron key stays on the server exactly as it does in the gateway.
 */
import { transcribeFile, IntronFileError } from "@/lib/speech/intron-file";
import { isAllowedOrigin, parseLanguage } from "@/lib/gateway/guards";
import { checkUploadSize, friendlySttError, isSameHostOrigin, uploadOriginAllowlist, UPLOAD_LIMITS } from "@/lib/speech/upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Our own ceiling, inside maxDuration, so a stuck upstream fails with a message instead of a platform kill. */
const UPSTREAM_TIMEOUT_MS = 50_000;

function fail(status: number, code: string, message = friendlySttError(code)): Response {
  return Response.json({ ok: false, code, error: message }, { status });
}

export async function POST(req: Request) {
  // This endpoint spends Intron credits, so only this site's own pages may call it.
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const allowlist = uploadOriginAllowlist(process.env, process.env.NODE_ENV !== "production");
  if (!isSameHostOrigin(origin, host) && !isAllowedOrigin(origin, allowlist)) {
    return fail(403, "FORBIDDEN_ORIGIN", "This request isn't allowed.");
  }

  const language = parseLanguage(new URL(req.url).searchParams.get("lang"));
  if (!language) return fail(400, "BAD_LANGUAGE", "That speech language isn't supported.");

  const apiKey = process.env.INTRON_API_KEY ?? process.env.API_KEY;
  if (!apiKey) {
    console.error("[voice/transcribe] INTRON_API_KEY is not set");
    return fail(503, "NO_API_KEY");
  }

  // Refuse an oversized body from its declared length before reading it.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > UPLOAD_LIMITS.maxBytes) return fail(413, "TOO_LONG");

  let pcm: Buffer;
  try {
    pcm = Buffer.from(await req.arrayBuffer());
  } catch {
    return fail(400, "BAD_BODY", "We couldn't read that recording. Please record again.");
  }
  // PCM16 at 16 kHz mono, so this checks the real duration (bytes / 32,000).
  const size = checkUploadSize(pcm.length);
  if (!size.ok) return fail(size.status, size.code, size.message);

  try {
    const result = await transcribeFile(pcm, { apiKey, language, timeoutMs: UPSTREAM_TIMEOUT_MS });
    const transcript = result.transcript.trim();
    if (!transcript) return fail(422, "INSUFFICIENT_AUDIO_ACTIVITY");
    return Response.json({ ok: true, transcript, durationSec: result.durationSec });
  } catch (e) {
    if (e instanceof IntronFileError) {
      console.error("[voice/transcribe]", e.code, e.message, { recoverable: e.recoverable });
      return fail(e.recoverable ? 503 : 502, e.code);
    }
    console.error("[voice/transcribe]", e);
    return fail(500, "INTERNAL");
  }
}

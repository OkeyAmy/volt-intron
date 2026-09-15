/**
 * Record-then-upload voice path. Serverless hosts (Vercel) cannot keep the live
 * WebSocket gateway open, so the browser records the whole utterance and POSTs it
 * once; the server then runs the same Intron client the gateway uses.
 *
 * The body is raw 16 kHz mono PCM16 (32,000 bytes/second). Vercel rejects request
 * bodies over 4.5 MB, so recordings are capped at two minutes (3.84 MB).
 */

export const PCM_BYTES_PER_SECOND = 16000 * 2;

export const UPLOAD_LIMITS = {
  maxSeconds: 120,
  maxBytes: 120 * PCM_BYTES_PER_SECOND,
  /** Under ~0.3 s there is nothing to transcribe; refuse before spending credits. */
  minBytes: Math.round(0.3 * PCM_BYTES_PER_SECOND),
} as const;

export type UploadCheck =
  | { ok: true }
  | { ok: false; status: number; code: "TOO_SHORT" | "TOO_LONG" | "ODD_LENGTH"; message: string };

export function checkUploadSize(bytes: number): UploadCheck {
  if (bytes > UPLOAD_LIMITS.maxBytes) {
    return { ok: false, status: 413, code: "TOO_LONG", message: "That recording is longer than two minutes. Please record a shorter one, or type the details." };
  }
  if (bytes < UPLOAD_LIMITS.minBytes) {
    return { ok: false, status: 400, code: "TOO_SHORT", message: "That recording was too short. Tap Start speaking and say the whole sale." };
  }
  if (bytes % 2 !== 0) {
    return { ok: false, status: 400, code: "ODD_LENGTH", message: "We couldn't read that recording. Please record again." };
  }
  return { ok: true };
}

/**
 * Trader-facing text for a transcription failure. States the way forward and never
 * blames the speaker; provider detail stays in the server log.
 */
export function friendlySttError(code: string | undefined): string {
  switch (code) {
    case "INSUFFICIENT_AUDIO_ACTIVITY":
      return "We didn't hear any speech. Move closer to the microphone and try again, or type the details.";
    case "NO_API_KEY":
    case "AUTHENTICATION_ERROR":
    case "QUOTA_EXCEEDED":
      return "Speech isn't available right now. Please type the details instead.";
    case "SESSION_TIME_LIMIT_EXCEEDED":
    case "AUDIO_TOO_LONG":
    case "TOO_LONG":
      return "That recording is too long. Please record a shorter one, or type the details.";
    case "ABORTED":
      return "That took too long to turn into text. Please try again, or type the details.";
    default:
      return "We couldn't turn that recording into text. Please try again, or type the details.";
  }
}

/** Origins the upload route accepts, from configuration. The request's own host is checked separately. */
export function uploadOriginAllowlist(env: Record<string, string | undefined>, dev: boolean): string[] {
  const list: string[] = [];
  if (env.APP_URL) list.push(env.APP_URL);
  for (const host of [env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_BRANCH_URL]) {
    if (host) list.push(`https://${host}`);
  }
  if (dev) list.push("http://localhost:3000", "http://127.0.0.1:3000");
  return list;
}

/**
 * Same-origin check: a browser always sends Origin on a cross-origin POST and a
 * page on another site cannot forge it, so Origin host === request host means the
 * request came from this site's own page (the check Next's Server Actions use).
 */
export function isSameHostOrigin(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

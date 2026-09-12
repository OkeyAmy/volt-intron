/**
 * Guards for the voice gateway.
 *
 * Every connection here spends Intron credits, so the endpoint must not be an open
 * relay. The important one is the Origin check: WebSocket handshakes are NOT subject
 * to the same-origin policy, and CORS does not apply to them, so without an explicit
 * check any page a user visits can open a socket to localhost and spend their money.
 * That is cross-site WebSocket hijacking, and the Origin header is the defence.
 */

/** The only values Intron accepts from us. A code-switched pair is how Sahara is selected. */
export const SUPPORTED_LANGUAGES = ["yo", "ig", "ha", "pcm", "en"] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

const SUPPORTED = new Set<string>(SUPPORTED_LANGUAGES);

/**
 * Validate a language code. Returns null for anything unsupported rather than
 * casting, so an attacker-controlled string never reaches the upstream URL and a
 * typo fails loudly instead of producing a confusing upstream error.
 * A Set lookup is used rather than object indexing so inherited keys such as
 * "constructor" cannot match.
 */
export function parseLanguage(input: string | null | undefined): LanguageCode | null {
  if (input === null || input === undefined) return "pcm";
  return SUPPORTED.has(input) ? (input as LanguageCode) : null;
}

/**
 * Exact-match an Origin against an allowlist.
 *
 * Compared by parsed origin rather than string prefix, because
 * "http://localhost:3000.evil.example" starts with an allowed value and
 * "https://evil.example/?x=http://localhost:3000" contains one. An absent Origin is
 * refused: browsers always send it on a cross-origin WS handshake, so its absence
 * means a non-browser client, which should be using a server-side path instead.
 */
export function isAllowedOrigin(origin: string | undefined | null, allowlist: string[]): boolean {
  if (!origin || allowlist.length === 0) return false;
  const normalise = (value: string): string | null => {
    try {
      // URL lowercases scheme and host but preserves port, which is what we want.
      return new URL(value).origin.toLowerCase();
    } catch {
      return null;
    }
  };
  const candidate = normalise(origin);
  if (!candidate) return false;
  return allowlist.some((entry) => normalise(entry) === candidate);
}

/** Build the allowlist from configuration. Dev adds localhost; production does not. */
export function originAllowlist(appUrl: string | undefined, dev: boolean, port: number): string[] {
  const list: string[] = [];
  if (appUrl) list.push(appUrl);
  if (dev) list.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  return list;
}

export const LIMITS = {
  /** Intron terminates a session at 300s, so more audio than that can never be transcribed. */
  maxAudioBytes: 300 * 16000 * 2,
  /** A 100ms frame at 16kHz mono is 3200 bytes; this leaves generous headroom. */
  maxFrameBytes: 64 * 1024,
  /** One client should not be able to drain the credit balance in parallel. */
  maxConcurrentSessions: 4,
} as const;

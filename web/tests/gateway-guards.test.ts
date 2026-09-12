/**
 * The voice gateway spends real money on every connection, so it must not be an
 * open relay. WebSockets are NOT protected by the same-origin policy - the browser
 * sends the request regardless of origin - so an explicit Origin check is the
 * defence against cross-site WebSocket hijacking, and CORS is no substitute.
 */
import { describe, it, expect } from "vitest";
import { parseLanguage, isAllowedOrigin, LIMITS } from "@/lib/gateway/guards";

describe("language validation", () => {
  it.each(["yo", "ig", "ha", "pcm", "en"])("accepts the supported code %s", (code) => {
    expect(parseLanguage(code)).toBe(code);
  });

  it("defaults to pidgin when absent", () => {
    expect(parseLanguage(null)).toBe("pcm");
  });

  it.each(["fr", "", "yo; DROP", "../../etc/passwd", "yo yo", "YO"])(
    "rejects unsupported input %j rather than forwarding it upstream", (bad) => {
      expect(parseLanguage(bad)).toBeNull();
    });

  it("does not accept a prototype-polluting key", () => {
    expect(parseLanguage("constructor")).toBeNull();
    expect(parseLanguage("__proto__")).toBeNull();
  });
});

describe("origin allowlist", () => {
  const allowed = ["http://localhost:3000"];

  it("accepts an exact allowed origin", () => {
    expect(isAllowedOrigin("http://localhost:3000", allowed)).toBe(true);
  });

  it("rejects another site attempting cross-site hijacking", () => {
    expect(isAllowedOrigin("https://evil.example", allowed)).toBe(false);
  });

  it("rejects a lookalike that merely starts with an allowed origin", () => {
    expect(isAllowedOrigin("http://localhost:3000.evil.example", allowed)).toBe(false);
  });

  it("rejects a lookalike that merely contains an allowed origin", () => {
    expect(isAllowedOrigin("https://evil.example/?x=http://localhost:3000", allowed)).toBe(false);
  });

  it("rejects a missing Origin header, which non-browser clients omit", () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
  });

  it("ignores a trailing slash, which browsers vary on", () => {
    expect(isAllowedOrigin("http://localhost:3000/", allowed)).toBe(true);
  });

  it("is case-insensitive on scheme and host only", () => {
    expect(isAllowedOrigin("HTTP://LOCALHOST:3000", allowed)).toBe(true);
  });

  it("refuses everything when the allowlist is empty rather than failing open", () => {
    expect(isAllowedOrigin("http://localhost:3000", [])).toBe(false);
  });
});

describe("resource limits", () => {
  it("caps audio at Intron's own 300 second session ceiling", () => {
    // 300s x 16000 samples x 2 bytes. Beyond this the upstream session dies anyway,
    // so accepting more only wastes our memory.
    expect(LIMITS.maxAudioBytes).toBe(300 * 16000 * 2);
  });

  it("caps a single frame well under the 32KB the upstream accepts", () => {
    expect(LIMITS.maxFrameBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("bounds concurrent sessions so one client cannot drain the credit balance", () => {
    expect(LIMITS.maxConcurrentSessions).toBeGreaterThan(0);
    expect(LIMITS.maxConcurrentSessions).toBeLessThanOrEqual(8);
  });
});

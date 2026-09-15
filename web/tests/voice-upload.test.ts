/**
 * The upload route is the voice path on Vercel. It spends Intron credits, so it
 * must refuse other sites, bad languages and oversized bodies before calling
 * upstream, and it must never leak provider detail to the browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkUploadSize, friendlySttError, isSameHostOrigin, uploadOriginAllowlist, UPLOAD_LIMITS } from "@/lib/speech/upload";

const transcribeFile = vi.fn();
vi.mock("@/lib/speech/intron-file", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/speech/intron-file")>();
  return { ...real, transcribeFile: (...args: unknown[]) => transcribeFile(...args) };
});

const { POST } = await import("@/app/api/voice/transcribe/route");
const { IntronFileError } = await import("@/lib/speech/intron-file");

function request(opts: { bytes?: number; lang?: string; origin?: string | null; host?: string } = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-host": opts.host ?? "sautice.example" };
  const origin = opts.origin === undefined ? "https://sautice.example" : opts.origin;
  if (origin) headers.origin = origin;
  return new Request(`https://sautice.example/api/voice/transcribe?lang=${opts.lang ?? "pcm"}`, {
    method: "POST",
    headers,
    body: new Uint8Array(opts.bytes ?? 32000),
  });
}

describe("upload limits", () => {
  it("caps a recording at 60 s, matching the gateway and inside Intron's 120 s file limit", () => {
    expect(UPLOAD_LIMITS.maxSeconds).toBe(60);
    expect(UPLOAD_LIMITS.maxBytes).toBe(60 * 16000 * 2);
    expect(UPLOAD_LIMITS.maxBytes).toBeLessThan(4.5 * 1024 * 1024);
  });

  it("accepts a normal recording", () => {
    expect(checkUploadSize(5 * 32000)).toEqual({ ok: true });
  });

  it("refuses too long, too short, and half-sample bodies", () => {
    expect(checkUploadSize(UPLOAD_LIMITS.maxBytes + 2)).toMatchObject({ ok: false, status: 413, code: "TOO_LONG" });
    expect(checkUploadSize(100)).toMatchObject({ ok: false, code: "TOO_SHORT" });
    expect(checkUploadSize(32001)).toMatchObject({ ok: false, code: "ODD_LENGTH" });
  });
});

describe("friendly speech errors", () => {
  it("tells the trader to type when speech is not configured or out of credit", () => {
    for (const code of ["NO_API_KEY", "AUTHENTICATION_ERROR", "QUOTA_EXCEEDED"]) {
      expect(friendlySttError(code)).toMatch(/type/i);
    }
  });

  it("explains silence without blaming the speaker", () => {
    expect(friendlySttError("INSUFFICIENT_AUDIO_ACTIVITY")).toMatch(/didn't hear any speech/);
  });

  it("has a way-forward fallback for unknown codes", () => {
    expect(friendlySttError("SOMETHING_NEW")).toMatch(/record again/i);
  });
});

describe("origin checks", () => {
  it("accepts a request from the site's own host", () => {
    expect(isSameHostOrigin("https://sautice.example", "sautice.example")).toBe(true);
  });

  it("rejects another site and a missing origin", () => {
    expect(isSameHostOrigin("https://evil.example", "sautice.example")).toBe(false);
    expect(isSameHostOrigin(null, "sautice.example")).toBe(false);
  });

  it("builds the allowlist from APP_URL and Vercel's system URLs", () => {
    expect(uploadOriginAllowlist({ APP_URL: "https://app.example", VERCEL_URL: "x-123.vercel.app" }, false))
      .toEqual(["https://app.example", "https://x-123.vercel.app"]);
  });
});

describe("POST /api/voice/transcribe", () => {
  const env = { ...process.env };
  beforeEach(() => {
    transcribeFile.mockReset();
    process.env.INTRON_API_KEY = "test-key";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("sends the recording to Intron's file API and returns the transcript", async () => {
    transcribeFile.mockResolvedValue({ transcript: " Adebayo bought cement ", durationSec: 1, fileId: "f1" });
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, transcript: "Adebayo bought cement", durationSec: 1 });
    const [pcm, opts] = transcribeFile.mock.calls[0];
    expect((pcm as Buffer).length).toBe(32000);
    expect(opts).toMatchObject({ apiKey: "test-key", language: "pcm" });
    expect((opts as { timeoutMs: number }).timeoutMs).toBeLessThan(60_000); // inside maxDuration
  });

  it("refuses another site's page before spending credits", async () => {
    const res = await POST(request({ origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it("refuses an unsupported language", async () => {
    const res = await POST(request({ lang: "fr" }));
    expect(res.status).toBe(400);
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it("refuses a recording over the 60 s limit", async () => {
    const res = await POST(request({ bytes: UPLOAD_LIMITS.maxBytes + 2 }));
    expect(res.status).toBe(413);
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it("says speech isn't available when no key is configured", async () => {
    delete process.env.INTRON_API_KEY;
    delete process.env.API_KEY;
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "NO_API_KEY" });
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it("maps a non-recoverable provider error to friendly text without leaking its detail", async () => {
    transcribeFile.mockRejectedValue(new IntronFileError("secret upstream detail", "AUTHENTICATION_ERROR", false));
    const res = await POST(request());
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.code).toBe("AUTHENTICATION_ERROR");
    expect(JSON.stringify(body)).not.toContain("secret upstream detail");
  });

  it("marks a recoverable provider error as retryable (503)", async () => {
    transcribeFile.mockRejectedValue(new IntronFileError("rate limited", "RESOURCE_EXHAUSTED", true));
    const res = await POST(request());
    expect(res.status).toBe(503);
  });

  it("treats an empty transcript as no speech heard", async () => {
    transcribeFile.mockResolvedValue({ transcript: "   ", durationSec: 1, fileId: "f1" });
    const res = await POST(request());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "INSUFFICIENT_AUDIO_ACTIVITY" });
  });
});

/**
 * Invoice draft builder.
 *
 * The authoritative money and resolution logic lives in Python (src/sautice) and
 * is faithfully ported to TypeScript under ./core, so this runs IN-PROCESS with no
 * subprocess and no filesystem read. That is what lets the invoice API run on a
 * serverless platform (Vercel), where spawning `python` and writing a SQLite file
 * are both impossible. Parity with Python is checked in tests/invoice-parity.test.ts.
 */
import type { Intent } from "./core/extract";
import type { Selections } from "./core/executor";

export interface DraftRequest {
  transcript?: string;
  intent?: unknown;
  selections?: unknown;
  today?: string;
  roster_path?: string;
}

export interface DraftQuestion {
  id: string;
  kind: "choice" | "confirm_new" | "text" | "number" | "amount";
  field: "customer" | "product" | "qty" | "price";
  line?: number;
  prompt: string;
  options?: { value: string | number; label: string }[];
}

export interface DraftLine {
  index: number;
  query: string;
  product: { status: string; resolved?: { id: string | null; name: string; unit?: string; unit_price_kobo: number | null; new?: boolean } | null; candidates?: unknown[] };
  qty: number | null;
  unit_price_kobo: number | null;
  unit_price_display: string | null;
  unit_price_source: "spoken" | "catalog" | "corrected" | null;
  line_total_kobo: number | null;
  line_total_display: string | null;
}

export interface Draft {
  customer: { status: string; query: string; resolved?: { id: string | null; name: string; new?: boolean } | null; candidates?: { id: string; name: string }[] };
  lines: DraftLine[];
  terms: { text: string; days: number | null; rule?: string | null; due_date: string | null };
  total_kobo: number | null;
  total_display: string | null;
  questions: DraftQuestion[];
  ready: boolean;
}

export interface BridgeResponse {
  ok: boolean;
  draft?: Draft;
  intent?: unknown;
  error?: string;
}

/**
 * Build a draft in-process. Async only to preserve the previous signature so the
 * route handlers are unchanged; it does no I/O and cannot time out.
 */
export async function runBridge(req: DraftRequest): Promise<BridgeResponse> {
  const { draftFromRequest } = await import("./core");
  try {
    return draftFromRequest({
      transcript: req.transcript,
      intent: req.intent as Intent | undefined,
      selections: req.selections as Selections | undefined,
      today: req.today,
    });
  } catch (e) {
    return { ok: false, error: `could not build a draft: ${(e as Error).message}` };
  }
}

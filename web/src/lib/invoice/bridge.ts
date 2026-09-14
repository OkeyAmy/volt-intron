/**
 * Server-only bridge to the Python invoice core.
 *
 * The authoritative money and resolution logic lives in Python (src/sautice). Node
 * invokes it as a short-lived subprocess with a JSON request on stdin and reads a
 * JSON response on stdout. No shell, and no data in argv — so there is nothing to
 * interpolate. Bounded by a timeout and an output cap.
 */
import { spawn } from "node:child_process";
import path from "node:path";

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

const MAX_OUTPUT = 1024 * 1024;

function repoRoot(): string {
  if (process.env.SAUTICE_ROOT) return process.env.SAUTICE_ROOT;
  const cwd = process.cwd();
  return path.basename(cwd) === "web" ? path.dirname(cwd) : cwd;
}

export function runBridge(req: DraftRequest, opts: { timeoutMs?: number } = {}): Promise<BridgeResponse> {
  const python = process.env.SAUTICE_PYTHON || "python";
  const root = repoRoot();

  return new Promise((resolve) => {
    let child;
    try {
      // turbopackIgnore: this is a fixed command, not a dynamic import of app files;
      // the annotation stops the bundler tracing source into the server output.
      child = spawn(/* turbopackIgnore: true */ python, ["-m", "sautice.bridge"], {
        cwd: root,
        env: { ...process.env, PYTHONPATH: "src", PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: `bridge spawn failed: ${(e as Error).message}` });
      return;
    }

    let out = "";
    let err = "";
    let settled = false;
    const done = (r: BridgeResponse) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };

    const timer = setTimeout(() => { child.kill(); done({ ok: false, error: "bridge timed out" }); }, opts.timeoutMs ?? 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { out += d; if (out.length > MAX_OUTPUT) { child.kill(); done({ ok: false, error: "bridge output too large" }); } });
    child.stderr.on("data", (d: string) => { err += d; });
    child.on("error", (e: Error) => done({ ok: false, error: `bridge failed to run (${process.env.SAUTICE_PYTHON || "python"}): ${e.message}` }));
    child.on("close", (code: number | null) => {
      try { done(JSON.parse(out) as BridgeResponse); }
      catch { done({ ok: false, error: (err.trim() || `bridge exited ${code} without valid JSON`).slice(0, 500) }); }
    });

    child.stdin.on("error", () => { /* the close/error handlers cover this */ });
    child.stdin.end(JSON.stringify({ action: "draft", ...req }));
  });
}

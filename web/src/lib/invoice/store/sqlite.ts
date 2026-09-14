/**
 * Local/dev store on Node's built-in SQLite. Used when no DATABASE_URL is set.
 * node:sqlite is imported dynamically so this module never loads on a platform
 * (e.g. Vercel) that lacks it — the Postgres backend is used there instead.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Draft } from "../bridge";
import type { ConfirmResult, DraftRow, InvoiceListItem, InvoiceRow, Store } from "./types";

function repoRoot(): string {
  if (process.env.SAUTICE_ROOT) return process.env.SAUTICE_ROOT;
  const cwd = process.cwd();
  return path.basename(cwd) === "web" ? path.dirname(cwd) : cwd;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;

async function connect() {
  if (db) return db;
  const { DatabaseSync } = await import("node:sqlite");
  const file = process.env.SAUTICE_DB || path.join(repoRoot(), "web", ".data", "sautice.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, workspace TEXT NOT NULL DEFAULT 'demo', version INTEGER NOT NULL, transcript TEXT, selections TEXT, draft TEXT NOT NULL, ready INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, number TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT 'demo', draft_id TEXT NOT NULL, draft_version INTEGER NOT NULL, customer_name TEXT, total_kobo INTEGER, snapshot TEXT NOT NULL, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  `);
  return db;
}

const now = () => new Date().toISOString();

function hydrateInvoice(row: Record<string, unknown>): InvoiceRow {
  return {
    id: row.id as string, number: row.number as string, workspace: row.workspace as string,
    draft_id: row.draft_id as string, draft_version: row.draft_version as number,
    customer_name: (row.customer_name as string) ?? null, total_kobo: (row.total_kobo as number) ?? null,
    snapshot: JSON.parse(row.snapshot as string) as Draft, created_at: row.created_at as string,
  };
}

export const sqliteStore: Store = {
  async saveNewDraft(input) {
    const d = await connect();
    const id = randomUUID();
    const ts = now();
    d.prepare(`INSERT INTO drafts (id, workspace, version, transcript, selections, draft, ready, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.workspace ?? "demo", input.transcript, JSON.stringify(input.selections ?? {}), JSON.stringify(input.draft), input.draft.ready ? 1 : 0, ts, ts);
    return { id, workspace: input.workspace ?? "demo", version: 1, transcript: input.transcript, selections: input.selections ?? {}, draft: input.draft, ready: input.draft.ready };
  },

  async updateDraft(id, input) {
    const d = await connect();
    const row = d.prepare(`SELECT id, workspace, version, transcript FROM drafts WHERE id = ?`).get(id) as { workspace: string; version: number; transcript: string | null } | undefined;
    if (!row) return null;
    const version = row.version + 1;
    d.prepare(`UPDATE drafts SET version = ?, selections = ?, draft = ?, ready = ?, updated_at = ? WHERE id = ?`)
      .run(version, JSON.stringify(input.selections ?? {}), JSON.stringify(input.draft), input.draft.ready ? 1 : 0, now(), id);
    return { id, workspace: row.workspace, version, transcript: row.transcript, selections: input.selections ?? {}, draft: input.draft, ready: input.draft.ready };
  },

  async getDraft(id) {
    const d = await connect();
    const row = d.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string, workspace: row.workspace as string, version: row.version as number,
      transcript: (row.transcript as string) ?? null, selections: JSON.parse((row.selections as string) || "{}"),
      draft: JSON.parse(row.draft as string) as Draft, ready: (row.ready as number) === 1,
    } satisfies DraftRow;
  },

  async confirmDraft(input) {
    const d = await connect();
    const existing = d.prepare(`SELECT * FROM invoices WHERE idempotency_key = ?`).get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return { status: "duplicate", invoice: hydrateInvoice(existing) };

    const draft = await this.getDraft(input.draftId);
    if (!draft) return { status: "not_found" };
    if (draft.version !== input.version) return { status: "version_conflict", currentVersion: draft.version };
    if (!draft.ready) return { status: "not_ready" };

    const id = randomUUID();
    d.prepare(`INSERT INTO counters (name, value) VALUES ('invoice', 0) ON CONFLICT(name) DO NOTHING`).run();
    d.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'invoice'`).run();
    const { value } = d.prepare(`SELECT value FROM counters WHERE name = 'invoice'`).get() as { value: number };
    const number = `INV-${String(value).padStart(5, "0")}`;
    const ts = now();
    const customer = draft.draft.customer.resolved?.name ?? null;
    try {
      d.prepare(`INSERT INTO invoices (id, number, workspace, draft_id, draft_version, customer_name, total_kobo, snapshot, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, number, draft.workspace, draft.id, draft.version, customer, draft.draft.total_kobo, JSON.stringify(draft.draft), input.idempotencyKey, ts);
    } catch {
      const raced = d.prepare(`SELECT * FROM invoices WHERE idempotency_key = ?`).get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (raced) return { status: "duplicate", invoice: hydrateInvoice(raced) };
      throw new Error("invoice insert failed");
    }
    d.prepare(`INSERT INTO audit (id, invoice_id, event, at) VALUES (?, ?, 'issued', ?)`).run(randomUUID(), id, ts);
    return { status: "created", invoice: hydrateInvoice(d.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id) as Record<string, unknown>) } satisfies ConfirmResult;
  },

  async getInvoice(id) {
    const d = await connect();
    const row = d.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? hydrateInvoice(row) : null;
  },

  async listInvoices(opts = {}) {
    const d = await connect();
    const workspace = opts.workspace ?? "demo";
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const q = (opts.q ?? "").trim();
    const rows = q
      ? d.prepare(`SELECT id, number, customer_name, total_kobo, created_at FROM invoices WHERE workspace = ? AND (number LIKE ? OR customer_name LIKE ? COLLATE NOCASE) ORDER BY created_at DESC LIMIT ?`).all(workspace, `%${q}%`, `%${q}%`, limit)
      : d.prepare(`SELECT id, number, customer_name, total_kobo, created_at FROM invoices WHERE workspace = ? ORDER BY created_at DESC LIMIT ?`).all(workspace, limit);
    return rows as unknown as InvoiceListItem[];
  },
};

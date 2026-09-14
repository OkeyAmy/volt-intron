/**
 * Durable store for drafts and issued invoices, on SQLite via Node's built-in
 * `node:sqlite`. Issuance must not live in process memory: an invoice is a record,
 * and a restart or a second server instance must still see it.
 *
 * Note for deployment: the file must sit on a persistent volume, not an ephemeral
 * container filesystem. Configure the path with SAUTICE_DB.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Draft } from "./bridge";

function repoRoot(): string {
  if (process.env.SAUTICE_ROOT) return process.env.SAUTICE_ROOT;
  const cwd = process.cwd();
  return path.basename(cwd) === "web" ? path.dirname(cwd) : cwd;
}

let db: DatabaseSync | null = null;

function connect(): DatabaseSync {
  if (db) return db;
  const file = process.env.SAUTICE_DB || path.join(repoRoot(), "web", ".data", "sautice.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT 'demo',
      version INTEGER NOT NULL,
      transcript TEXT,
      selections TEXT,
      draft TEXT NOT NULL,
      ready INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT 'demo',
      draft_id TEXT NOT NULL,
      draft_version INTEGER NOT NULL,
      customer_name TEXT,
      total_kobo INTEGER,
      snapshot TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      event TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  `);
  return db;
}

const now = () => new Date().toISOString();

export interface DraftRow {
  id: string;
  workspace: string;
  version: number;
  transcript: string | null;
  selections: unknown;
  draft: Draft;
  ready: boolean;
}

export function saveNewDraft(input: { transcript: string; selections: unknown; draft: Draft; workspace?: string }): DraftRow {
  const d = connect();
  const id = randomUUID();
  const ts = now();
  d.prepare(
    `INSERT INTO drafts (id, workspace, version, transcript, selections, draft, ready, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.workspace ?? "demo", input.transcript, JSON.stringify(input.selections ?? {}), JSON.stringify(input.draft), input.draft.ready ? 1 : 0, ts, ts);
  return { id, workspace: input.workspace ?? "demo", version: 1, transcript: input.transcript, selections: input.selections ?? {}, draft: input.draft, ready: input.draft.ready };
}

/** Update a draft with recomputed content, bumping the version. A new version
 *  invalidates any prior confirmation, which is bound to (draftId, version). */
export function updateDraft(id: string, input: { selections: unknown; draft: Draft }): DraftRow | null {
  const d = connect();
  const row = d.prepare(`SELECT id, workspace, version, transcript FROM drafts WHERE id = ?`).get(id) as
    | { id: string; workspace: string; version: number; transcript: string | null }
    | undefined;
  if (!row) return null;
  const version = row.version + 1;
  d.prepare(`UPDATE drafts SET version = ?, selections = ?, draft = ?, ready = ?, updated_at = ? WHERE id = ?`)
    .run(version, JSON.stringify(input.selections ?? {}), JSON.stringify(input.draft), input.draft.ready ? 1 : 0, now(), id);
  return { id, workspace: row.workspace, version, transcript: row.transcript, selections: input.selections ?? {}, draft: input.draft, ready: input.draft.ready };
}

export function getDraft(id: string): DraftRow | null {
  const d = connect();
  const row = d.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    workspace: row.workspace as string,
    version: row.version as number,
    transcript: (row.transcript as string) ?? null,
    selections: JSON.parse((row.selections as string) || "{}"),
    draft: JSON.parse(row.draft as string) as Draft,
    ready: (row.ready as number) === 1,
  };
}

export interface InvoiceRow {
  id: string;
  number: string;
  workspace: string;
  draft_id: string;
  draft_version: number;
  customer_name: string | null;
  total_kobo: number | null;
  snapshot: Draft;
  created_at: string;
}

function nextInvoiceNumber(d: DatabaseSync): string {
  d.prepare(`INSERT INTO counters (name, value) VALUES ('invoice', 0) ON CONFLICT(name) DO NOTHING`).run();
  d.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'invoice'`).run();
  const { value } = d.prepare(`SELECT value FROM counters WHERE name = 'invoice'`).get() as { value: number };
  return `INV-${String(value).padStart(5, "0")}`;
}

export type ConfirmResult =
  | { status: "created" | "duplicate"; invoice: InvoiceRow }
  | { status: "not_found" }
  | { status: "version_conflict"; currentVersion: number }
  | { status: "not_ready" };

/** Issue an invoice from a specific draft version. Idempotent on idempotencyKey:
 *  a repeated confirmation returns the original invoice rather than a second one. */
export function confirmDraft(input: { draftId: string; version: number; idempotencyKey: string }): ConfirmResult {
  const d = connect();

  const existing = d.prepare(`SELECT * FROM invoices WHERE idempotency_key = ?`).get(input.idempotencyKey) as
    | Record<string, unknown>
    | undefined;
  if (existing) return { status: "duplicate", invoice: hydrateInvoice(existing) };

  const draft = getDraft(input.draftId);
  if (!draft) return { status: "not_found" };
  if (draft.version !== input.version) return { status: "version_conflict", currentVersion: draft.version };
  if (!draft.ready) return { status: "not_ready" };

  const id = randomUUID();
  const number = nextInvoiceNumber(d);
  const ts = now();
  const customer = draft.draft.customer.resolved?.name ?? null;
  try {
    d.prepare(
      `INSERT INTO invoices (id, number, workspace, draft_id, draft_version, customer_name, total_kobo, snapshot, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, number, draft.workspace, draft.id, draft.version, customer, draft.draft.total_kobo, JSON.stringify(draft.draft), input.idempotencyKey, ts);
  } catch (e) {
    // A concurrent confirm with the same key won the UNIQUE race; return theirs.
    const raced = d.prepare(`SELECT * FROM invoices WHERE idempotency_key = ?`).get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (raced) return { status: "duplicate", invoice: hydrateInvoice(raced) };
    throw e;
  }
  d.prepare(`INSERT INTO audit (id, invoice_id, event, at) VALUES (?, ?, 'issued', ?)`).run(randomUUID(), id, ts);

  return { status: "created", invoice: hydrateInvoice(d.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id) as Record<string, unknown>) };
}

export function getInvoice(id: string): InvoiceRow | null {
  const d = connect();
  const row = d.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? hydrateInvoice(row) : null;
}

export interface InvoiceListItem {
  id: string;
  number: string;
  customer_name: string | null;
  total_kobo: number | null;
  created_at: string;
}

/** Issued invoices for a workspace, newest first, optionally filtered by a query
 *  over the invoice number or customer name. */
export function listInvoices(opts: { workspace?: string; q?: string; limit?: number } = {}): InvoiceListItem[] {
  const d = connect();
  const workspace = opts.workspace ?? "demo";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const q = (opts.q ?? "").trim();
  const rows = q
    ? d.prepare(
        `SELECT id, number, customer_name, total_kobo, created_at FROM invoices
         WHERE workspace = ? AND (number LIKE ? OR customer_name LIKE ? COLLATE NOCASE)
         ORDER BY created_at DESC LIMIT ?`,
      ).all(workspace, `%${q}%`, `%${q}%`, limit)
    : d.prepare(
        `SELECT id, number, customer_name, total_kobo, created_at FROM invoices
         WHERE workspace = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(workspace, limit);
  return rows as unknown as InvoiceListItem[];
}

function hydrateInvoice(row: Record<string, unknown>): InvoiceRow {
  return {
    id: row.id as string,
    number: row.number as string,
    workspace: row.workspace as string,
    draft_id: row.draft_id as string,
    draft_version: row.draft_version as number,
    customer_name: (row.customer_name as string) ?? null,
    total_kobo: (row.total_kobo as number) ?? null,
    snapshot: JSON.parse(row.snapshot as string) as Draft,
    created_at: row.created_at as string,
  };
}

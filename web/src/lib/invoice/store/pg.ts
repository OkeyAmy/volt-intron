/**
 * Serverless store on Postgres (Vercel Postgres / Neon / any Postgres via
 * DATABASE_URL). Used whenever a database URL is configured. `prepare: false` and a
 * small pool suit a pooled/pgBouncer endpoint and short-lived serverless invocations.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Draft } from "../bridge";
import type { ConfirmResult, InvoiceListItem, InvoiceRow, Store } from "./types";

export const PG_URL =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || "";

type Sql = ReturnType<typeof postgres>;
let sqlSingleton: Sql | null = null;
let ready: Promise<void> | null = null;

function client(): Sql {
  if (sqlSingleton) return sqlSingleton;
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(PG_URL);
  sqlSingleton = postgres(PG_URL, { max: 1, prepare: false, idle_timeout: 20, ssl: local ? undefined : "require" });
  return sqlSingleton;
}

async function db(): Promise<Sql> {
  const sql = client();
  if (!ready) {
    ready = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, workspace TEXT NOT NULL DEFAULT 'demo', version INTEGER NOT NULL, transcript TEXT, selections TEXT, draft TEXT NOT NULL, ready BOOLEAN NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
      await sql`CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, number TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT 'demo', draft_id TEXT NOT NULL, draft_version INTEGER NOT NULL, customer_name TEXT, total_kobo BIGINT, snapshot TEXT NOT NULL, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL)`;
      await sql`CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL)`;
      await sql`CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value BIGINT NOT NULL)`;
    })().catch((e) => { ready = null; throw e; });
  }
  await ready;
  return sql;
}

const now = () => new Date().toISOString();
const num = (v: unknown): number | null => (v == null ? null : Number(v));

function hydrateInvoice(r: Record<string, unknown>): InvoiceRow {
  return {
    id: r.id as string, number: r.number as string, workspace: r.workspace as string,
    draft_id: r.draft_id as string, draft_version: num(r.draft_version)!, customer_name: (r.customer_name as string) ?? null,
    total_kobo: num(r.total_kobo), snapshot: JSON.parse(r.snapshot as string) as Draft, created_at: r.created_at as string,
  };
}

export const pgStore: Store = {
  async saveNewDraft(input) {
    const sql = await db();
    const id = randomUUID();
    const ts = now();
    await sql`INSERT INTO drafts (id, workspace, version, transcript, selections, draft, ready, created_at, updated_at)
      VALUES (${id}, ${input.workspace ?? "demo"}, 1, ${input.transcript}, ${JSON.stringify(input.selections ?? {})}, ${JSON.stringify(input.draft)}, ${input.draft.ready}, ${ts}, ${ts})`;
    return { id, workspace: input.workspace ?? "demo", version: 1, transcript: input.transcript, selections: input.selections ?? {}, draft: input.draft, ready: input.draft.ready };
  },

  async updateDraft(id, input) {
    const sql = await db();
    const rows = await sql`SELECT workspace, version, transcript FROM drafts WHERE id = ${id}`;
    if (rows.length === 0) return null;
    const row = rows[0];
    const version = num(row.version)! + 1;
    await sql`UPDATE drafts SET version = ${version}, selections = ${JSON.stringify(input.selections ?? {})}, draft = ${JSON.stringify(input.draft)}, ready = ${input.draft.ready}, updated_at = ${now()} WHERE id = ${id}`;
    return { id, workspace: row.workspace as string, version, transcript: (row.transcript as string) ?? null, selections: input.selections ?? {}, draft: input.draft, ready: input.draft.ready };
  },

  async getDraft(id) {
    const sql = await db();
    const rows = await sql`SELECT * FROM drafts WHERE id = ${id}`;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id as string, workspace: r.workspace as string, version: num(r.version)!,
      transcript: (r.transcript as string) ?? null, selections: JSON.parse((r.selections as string) || "{}"),
      draft: JSON.parse(r.draft as string) as Draft, ready: r.ready === true,
    };
  },

  async confirmDraft(input) {
    const sql = await db();
    const existing = await sql`SELECT * FROM invoices WHERE idempotency_key = ${input.idempotencyKey}`;
    if (existing.length) return { status: "duplicate", invoice: hydrateInvoice(existing[0]) };

    const draft = await this.getDraft(input.draftId);
    if (!draft) return { status: "not_found" };
    if (draft.version !== input.version) return { status: "version_conflict", currentVersion: draft.version };
    if (!draft.ready) return { status: "not_ready" };

    const id = randomUUID();
    const ts = now();
    const customer = draft.draft.customer.resolved?.name ?? null;
    try {
      await sql.begin(async (tx) => {
        const c = await tx`INSERT INTO counters (name, value) VALUES ('invoice', 1)
          ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value`;
        const number = `INV-${String(num(c[0].value)).padStart(5, "0")}`;
        await tx`INSERT INTO invoices (id, number, workspace, draft_id, draft_version, customer_name, total_kobo, snapshot, idempotency_key, created_at)
          VALUES (${id}, ${number}, ${draft.workspace}, ${draft.id}, ${draft.version}, ${customer}, ${draft.draft.total_kobo}, ${JSON.stringify(draft.draft)}, ${input.idempotencyKey}, ${ts})`;
        await tx`INSERT INTO audit (id, invoice_id, event, at) VALUES (${randomUUID()}, ${id}, 'issued', ${ts})`;
      });
      const rows = await sql`SELECT * FROM invoices WHERE id = ${id}`;
      return { status: "created", invoice: hydrateInvoice(rows[0]) } satisfies ConfirmResult;
    } catch {
      // A concurrent confirm with the same key won the UNIQUE race; return theirs.
      const raced = await sql`SELECT * FROM invoices WHERE idempotency_key = ${input.idempotencyKey}`;
      if (raced.length) return { status: "duplicate", invoice: hydrateInvoice(raced[0]) };
      throw new Error("invoice insert failed");
    }
  },

  async getInvoice(id) {
    const sql = await db();
    const rows = await sql`SELECT * FROM invoices WHERE id = ${id}`;
    return rows.length ? hydrateInvoice(rows[0]) : null;
  },

  async listInvoices(opts = {}) {
    const sql = await db();
    const workspace = opts.workspace ?? "demo";
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const q = (opts.q ?? "").trim();
    const rows = q
      ? await sql`SELECT id, number, customer_name, total_kobo, created_at FROM invoices WHERE workspace = ${workspace} AND (number ILIKE ${"%" + q + "%"} OR customer_name ILIKE ${"%" + q + "%"}) ORDER BY created_at DESC LIMIT ${limit}`
      : await sql`SELECT id, number, customer_name, total_kobo, created_at FROM invoices WHERE workspace = ${workspace} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id as string, number: r.number as string, customer_name: (r.customer_name as string) ?? null, total_kobo: num(r.total_kobo), created_at: r.created_at as string })) as InvoiceListItem[];
  },
};

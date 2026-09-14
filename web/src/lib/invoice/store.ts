/**
 * Durable store for drafts and issued invoices. Picks a backend at runtime:
 *   - Postgres  when a database URL is set (DATABASE_URL / POSTGRES_URL) — required
 *     on serverless platforms like Vercel, where the filesystem is not writable.
 *   - SQLite (node:sqlite) otherwise — zero-setup local development.
 *
 * Both back an invoice as a durable record with a unique number, an audit row, and
 * idempotent, version-bound issuance. All operations are async.
 */
import type { Store } from "./store/types";
import { PG_URL } from "./store/pg";

export type { DraftRow, InvoiceRow, InvoiceListItem, ConfirmResult } from "./store/types";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    if (!PG_URL && (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)) {
      // Serverless has no writable disk for SQLite. Fail with a clear message instead
      // of a cryptic filesystem error, so whoever configures the deploy sees the fix.
      storePromise = Promise.reject(
        new Error("No database configured. Add a Postgres database and set DATABASE_URL / POSTGRES_URL (see docs/deploy-vercel.md)."),
      );
    } else {
      storePromise = PG_URL
        ? import("./store/pg").then((m) => m.pgStore)
        : import("./store/sqlite").then((m) => m.sqliteStore);
    }
  }
  return storePromise;
}

export const usingPostgres = Boolean(PG_URL);

export const saveNewDraft: Store["saveNewDraft"] = async (input) => (await getStore()).saveNewDraft(input);
export const updateDraft: Store["updateDraft"] = async (id, input) => (await getStore()).updateDraft(id, input);
export const getDraft: Store["getDraft"] = async (id) => (await getStore()).getDraft(id);
export const confirmDraft: Store["confirmDraft"] = async (input) => (await getStore()).confirmDraft(input);
export const getInvoice: Store["getInvoice"] = async (id) => (await getStore()).getInvoice(id);
export const listInvoices: Store["listInvoices"] = async (opts) => (await getStore()).listInvoices(opts);

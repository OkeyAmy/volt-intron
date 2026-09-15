/**
 * Durable store for drafts and issued invoices. Picks a backend at runtime:
 *   - Postgres  when a postgres:// database URL is set (DATABASE_URL / POSTGRES_URL)
 *     — required on serverless platforms like Vercel, where the filesystem is not
 *     writable.
 *   - SQLite (node:sqlite) otherwise — zero-setup local development.
 *
 * Both back an invoice as a durable record with a unique number, an audit row, and
 * idempotent, version-bound issuance. All operations are async.
 */
import type { Store } from "./store/types";
import { StoreNotConfiguredError, storeBackend } from "./store/config";

export type { DraftRow, InvoiceRow, InvoiceListItem, ConfirmResult } from "./store/types";
export { isStoreNotConfigured, storeBackend } from "./store/config";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    const backend = storeBackend();
    if (backend === "missing") {
      // Any production host (Vercel, Render, Railway, Fly, …) should use Postgres;
      // SQLite needs a writable disk that serverless lacks and containers lose on
      // restart. Fail with a typed error the routes turn into a clear message.
      // Not cached: a redeploy with the variable set gets a fresh process anyway.
      return Promise.reject(new StoreNotConfiguredError());
    }
    storePromise = backend === "postgres"
      ? import("./store/pg").then((m) => m.pgStore)
      : import("./store/sqlite").then((m) => m.sqliteStore);
  }
  return storePromise;
}

export const saveNewDraft: Store["saveNewDraft"] = async (input) => (await getStore()).saveNewDraft(input);
export const updateDraft: Store["updateDraft"] = async (id, input) => (await getStore()).updateDraft(id, input);
export const getDraft: Store["getDraft"] = async (id) => (await getStore()).getDraft(id);
export const confirmDraft: Store["confirmDraft"] = async (input) => (await getStore()).confirmDraft(input);
export const getInvoice: Store["getInvoice"] = async (id) => (await getStore()).getInvoice(id);
export const listInvoices: Store["listInvoices"] = async (opts) => (await getStore()).listInvoices(opts);

/** Cheap connectivity probe for /api/health. Never throws. */
export async function pingStore(): Promise<boolean> {
  try {
    await (await getStore()).listInvoices({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The boundary between server failures and what a browser sees. Raw driver errors
 * can carry hostnames, SQL and constraint names, so they are logged here and only
 * a stable code plus fixed, plain-language text leaves the server.
 */
import { isStoreNotConfigured } from "@/lib/invoice/store/config";

export type ApiErrorCode = "DB_NOT_CONFIGURED" | "INTERNAL";

export const STORE_NOT_CONFIGURED_TEXT =
  "Saving invoices isn't set up on this site yet. The site owner needs to connect a database.";

export function storeFailure(e: unknown, context: string, retryText: string): Response {
  console.error(`[${context}]`, e);
  if (isStoreNotConfigured(e)) {
    return Response.json({ ok: false, code: "DB_NOT_CONFIGURED", error: STORE_NOT_CONFIGURED_TEXT }, { status: 503 });
  }
  return Response.json({ ok: false, code: "INTERNAL", error: retryText }, { status: 503 });
}

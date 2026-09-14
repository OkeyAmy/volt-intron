import type { Draft } from "../bridge";

export interface DraftRow {
  id: string;
  workspace: string;
  version: number;
  transcript: string | null;
  selections: unknown;
  draft: Draft;
  ready: boolean;
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

export interface InvoiceListItem {
  id: string;
  number: string;
  customer_name: string | null;
  total_kobo: number | null;
  created_at: string;
}

export type ConfirmResult =
  | { status: "created" | "duplicate"; invoice: InvoiceRow }
  | { status: "not_found" }
  | { status: "version_conflict"; currentVersion: number }
  | { status: "not_ready" };

export interface Store {
  saveNewDraft(input: { transcript: string; selections: unknown; draft: Draft; workspace?: string }): Promise<DraftRow>;
  updateDraft(id: string, input: { selections: unknown; draft: Draft }): Promise<DraftRow | null>;
  getDraft(id: string): Promise<DraftRow | null>;
  confirmDraft(input: { draftId: string; version: number; idempotencyKey: string }): Promise<ConfirmResult>;
  getInvoice(id: string): Promise<InvoiceRow | null>;
  listInvoices(opts?: { workspace?: string; q?: string; limit?: number }): Promise<InvoiceListItem[]>;
}

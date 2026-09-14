/**
 * In-process invoice core (TypeScript port of the Python bridge). Runs inside a
 * serverless function with no subprocess and no filesystem — so the invoice API
 * works on Vercel. The Python core stays authoritative and is the parity oracle.
 */
import { heuristicExtract, type Intent } from "./extract";
import { buildDraft, type Selections } from "./executor";
import { ROSTER } from "./roster";
import type { Draft } from "../bridge";

export interface CoreRequest {
  transcript?: string;
  intent?: Intent;
  selections?: Selections;
  today?: string;
}

export function draftFromRequest(req: CoreRequest): { ok: true; draft: Draft; intent: Intent } {
  const intent = req.intent ?? heuristicExtract(String(req.transcript ?? ""));
  const draft = buildDraft(intent, ROSTER, req.selections ?? {}, req.today);
  return { ok: true, draft, intent };
}

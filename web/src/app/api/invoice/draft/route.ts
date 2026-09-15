/**
 * Create or refine an invoice draft from a transcript. Refinement (with a draftId)
 * re-runs the SAME transcript through the invoice core (an in-process TypeScript
 * port of the Python engine) with the reviewer's selections, and bumps the version.
 */
import { runBridge } from "@/lib/invoice/bridge";
import { getDraft, saveNewDraft, updateDraft } from "@/lib/invoice/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30; // allow a serverless DB cold start (Neon idle wake)

function lagosToday(): string {
  // Explicit timezone: due dates are computed against the business's local day.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

export async function POST(req: Request) {
  let body: { transcript?: string; selections?: unknown; draftId?: string; intent?: unknown };
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 }); }

  const { transcript, selections, draftId, intent } = body ?? {};

  try {
    let baseTranscript = transcript;
    if (draftId) {
      const existing = await getDraft(draftId);
      if (!existing) return Response.json({ ok: false, error: "draft not found" }, { status: 404 });
      baseTranscript = existing.transcript ?? transcript; // re-resolve the same words
    }
    if (!baseTranscript && !intent) {
      return Response.json({ ok: false, error: "transcript is required" }, { status: 400 });
    }

    const resp = await runBridge({ transcript: baseTranscript, intent, selections, today: lagosToday() });
    if (!resp.ok || !resp.draft) {
      return Response.json({ ok: false, error: resp.error ?? "could not build a draft" }, { status: 502 });
    }

    const row = draftId
      ? await updateDraft(draftId, { selections, draft: resp.draft })
      : await saveNewDraft({ transcript: baseTranscript ?? "", selections, draft: resp.draft });
    if (!row) return Response.json({ ok: false, error: "draft not found" }, { status: 404 });

    return Response.json({ ok: true, draftId: row.id, version: row.version, draft: row.draft });
  } catch (e) {
    // Always answer with JSON (a store/DB hiccup must not become an empty 500 that
    // the browser can't parse). The message is safe to show; retrying usually works.
    return Response.json({ ok: false, error: `Couldn't save the draft. Please try again. (${(e as Error).message})` }, { status: 503 });
  }
}

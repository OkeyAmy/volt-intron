/**
 * Issue an invoice from a reviewed draft. Confirmation is bound to (draftId,
 * version): if the draft changed after review, the version no longer matches and
 * this returns 409 so the reviewer sees the new numbers before issuing. Idempotent
 * on idempotencyKey, so a double-click or retry never issues twice.
 */
import { confirmDraft } from "@/lib/invoice/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { draftId?: string; version?: number; idempotencyKey?: string };
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 }); }

  const { draftId, version, idempotencyKey } = body ?? {};
  if (!draftId || typeof version !== "number" || !idempotencyKey) {
    return Response.json({ ok: false, error: "draftId, version and idempotencyKey are required" }, { status: 400 });
  }

  const r = await confirmDraft({ draftId, version, idempotencyKey });
  switch (r.status) {
    case "not_found":
      return Response.json({ ok: false, error: "draft not found" }, { status: 404 });
    case "version_conflict":
      return Response.json({ ok: false, error: "This draft changed after you reviewed it. Reload and check the numbers.", currentVersion: r.currentVersion }, { status: 409 });
    case "not_ready":
      return Response.json({ ok: false, error: "This draft still has questions to answer." }, { status: 400 });
    default:
      return Response.json(
        { ok: true, duplicate: r.status === "duplicate", invoice: { id: r.invoice.id, number: r.invoice.number } },
        { status: r.status === "created" ? 201 : 200 },
      );
  }
}

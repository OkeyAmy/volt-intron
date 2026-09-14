/** Fetch one issued invoice as JSON, scoped to its workspace. */
import { getInvoice } from "@/lib/invoice/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inv = getInvoice(id);
  if (!inv) return Response.json({ ok: false, error: "invoice not found" }, { status: 404 });
  return Response.json({ ok: true, invoice: inv });
}

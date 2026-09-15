/** Fetch one issued invoice as JSON, scoped to its workspace. */
import { getInvoice } from "@/lib/invoice/store";
import { storeFailure } from "@/lib/api/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30; // allow a serverless DB cold start (Neon idle wake)

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const inv = await getInvoice(id);
    if (!inv) return Response.json({ ok: false, error: "invoice not found" }, { status: 404 });
    return Response.json({ ok: true, invoice: inv });
  } catch (e) {
    return storeFailure(e, "invoice/get", "Couldn't load the invoice. Please try again.");
  }
}

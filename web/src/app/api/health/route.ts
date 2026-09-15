/**
 * Deployment self-check: is a database configured and reachable, and is speech
 * configured? Reports booleans and names only — never a URL or key.
 */
import { pingStore, storeBackend } from "@/lib/invoice/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30; // allow a serverless DB cold start (Neon idle wake)

export async function GET() {
  const database = storeBackend();
  const databaseReachable = database === "missing" ? false : await pingStore();
  const voiceEnabled = process.env.NEXT_PUBLIC_VOICE_ENABLED !== "false";
  const body = {
    ok: databaseReachable,
    database,
    databaseReachable,
    voice: {
      enabled: voiceEnabled,
      transport: process.env.NEXT_PUBLIC_VOICE_TRANSPORT === "upload" ? "upload" : "stream",
      apiKeyConfigured: Boolean(process.env.INTRON_API_KEY ?? process.env.API_KEY),
    },
  };
  return Response.json(body, { status: databaseReachable ? 200 : 503, headers: { "cache-control": "no-store" } });
}

/**
 * Parse a response as JSON without throwing on an empty or non-JSON body (e.g. a
 * platform timeout page), so the user sees a clear message, not a parser error.
 */
export async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return { ok: false, error: "The server didn't respond. Please try again." };
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { return { ok: false, error: "Something went wrong on the server. Please try again." }; }
}

export const OFFLINE_TEXT = "We couldn't reach the server. Check your connection and try again.";

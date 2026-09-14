/**
 * Display-only naira formatting, matching the Python Money.format() output
 * (thousands separators, kobo shown only when non-zero). The authoritative amount
 * is always the integer kobo; this only renders it. Never compute totals here.
 */
export function formatKobo(kobo: number | null | undefined): string {
  if (kobo == null) return "—";
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / 100);
  const k = abs % 100;
  const body = k === 0 ? whole.toLocaleString("en-US") : `${whole.toLocaleString("en-US")}.${String(k).padStart(2, "0")}`;
  return `${sign}₦${body}`;
}

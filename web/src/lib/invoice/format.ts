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

const LAGOS_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric" });

/**
 * A timestamp as the business's local calendar date, e.g. "15 Sep 2026". Issued
 * dates were previously the UTC date, which is a day off late at night in Lagos.
 */
export function formatDateLagos(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : LAGOS_DATE.format(d);
}

/** A YYYY-MM-DD calendar date (no time zone) as "15 Sep 2026". */
export function formatIsoDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return day ?? "—";
  return formatDateLagos(`${day}T12:00:00+01:00`);
}

/**
 * Integer-kobo money, ported from src/sautice/core/money.py.
 *
 * The Python engine remains authoritative and is proven by its own tests; this TS
 * port exists so the invoice API can run in a serverless function (Vercel) without
 * spawning Python. Parity is checked in web/tests/invoice-parity.test.ts against
 * the same fixtures. Every amount is an integer count of kobo; no binary floats.
 */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const KOBO_PER_NAIRA = 100;

/** Parse a naira amount (string like "12,500.50", or a whole-number) to integer kobo. */
export function nairaToKobo(amount: string | number): number {
  let s: string;
  if (typeof amount === "number") {
    if (!Number.isInteger(amount)) {
      throw new MoneyError(`naira amount ${amount} must be a whole number or a string; floats lose kobo`);
    }
    s = String(amount);
  } else {
    s = amount;
  }
  s = s.trim().replace(/,/g, "").replace(/₦/g, "").replace(/\bN(?=\d)/gi, "").trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new MoneyError(`cannot read ${JSON.stringify(amount)} as an amount of naira`);
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]);
  const frac = m[3] ? Number(m[3].padEnd(2, "0")) : 0;
  return sign * (whole * KOBO_PER_NAIRA + frac);
}

/** Multiply a kobo amount by a whole quantity. */
export function mulKobo(kobo: number, quantity: number): number {
  if (!Number.isInteger(quantity)) throw new MoneyError(`quantity must be a whole number, got ${quantity}`);
  return kobo * quantity;
}

/** Human-readable, matching Money.format(): thousands separators, kobo only when non-zero. */
export function formatKobo(kobo: number | null | undefined): string {
  if (kobo == null) return "—";
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / KOBO_PER_NAIRA);
  const k = abs % KOBO_PER_NAIRA;
  const body = k === 0 ? whole.toLocaleString("en-US") : `${whole.toLocaleString("en-US")}.${String(k).padStart(2, "0")}`;
  return `${sign}₦${body}`;
}

/** Canonical naira-string form of a kobo amount ("250.00"), matching str(Money.naira). */
export function koboToNairaString(kobo: number): string {
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / KOBO_PER_NAIRA);
  const k = abs % KOBO_PER_NAIRA;
  return `${sign}${whole}.${String(k).padStart(2, "0")}`;
}

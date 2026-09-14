/**
 * Reading spoken Nigerian money, quantities and payment terms — ported from
 * src/sautice/nlp/naira.py (the authoritative version). A reading may say "I can't
 * tell" (multiple candidates) but never guesses. Amounts are integer kobo.
 */
import { formatKobo } from "./money";

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000 };
const EXTRA_QUANTITY: [string, number][] = [["a dozen", 12], ["dozen", 12], ["a pair", 2], ["pair", 2]];

const CURRENCY = /₦|\bN(?=[\d,])|\bnaira\b/gi;
const NOISE = /\b(?:about|around|like|say|abeg|make|am|each|per|only|just|plus)\b/gi;

export interface Reading {
  candidates: number[]; // kobo for amounts, integers for quantities
  note: string;
}
export const isAmbiguous = (r: Reading): boolean => r.candidates.length > 1;
export const single = (r: Reading): number | null => (r.candidates.length === 1 ? r.candidates[0] : null);

function clean(text: string): string {
  return text.toLowerCase().trim().replace(NOISE, " ").replace(/\s+/g, " ").replace(/^[\s.,]+|[\s.,]+$/g, "");
}

function wordsToInt(tokens: string[]): number | null {
  if (tokens.length === 0) return null;
  let total = 0, current = 0, seen = false;
  for (const tok of tokens) {
    if (tok === "and") continue;
    if (tok in UNITS) { current += UNITS[tok]; seen = true; }
    else if (tok in TENS) { current += TENS[tok]; seen = true; }
    else if (tok in SCALES) {
      if (!seen && SCALES[tok] >= 1000) return null;
      const scale = SCALES[tok];
      if (scale === 100) current = (current || 1) * 100;
      else { total += (current || 1) * scale; current = 0; }
      seen = true;
    } else return null;
  }
  return seen ? total + current : null;
}

/** Parse a plain decimal-ish token to a naira value (number), or null. */
function digits(text: string): number | null {
  const m = /^(\d[\d,]*)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const whole = m[1].replace(/,/g, "");
  return m[2] ? Number(`${whole}.${m[2]}`) : Number(whole);
}

/** naira value -> integer kobo (round tames any float dust from k/m scaling). */
function money(nairaValue: number): number {
  return Math.round(nairaValue * 100);
}

export function readAmount(text: string): Reading {
  const raw = text.trim();
  const hadCurrency = CURRENCY.test(raw); CURRENCY.lastIndex = 0;
  const t = clean(raw.replace(CURRENCY, " ")); CURRENCY.lastIndex = 0;
  if (!t) return { candidates: [], note: "nothing to read" };

  // 12.5k / 500k / 1.5m
  const m = /^([\d.,]+)\s*([km])\b/i.exec(t);
  if (m) {
    const d = digits(m[1]);
    if (d !== null) {
      const mult = m[2].toLowerCase() === "k" ? 1000 : 1_000_000;
      return { candidates: [money(d * mult)], note: "" };
    }
  }
  // bare digits
  const d = digits(t);
  if (d !== null) return { candidates: [money(d)], note: "" };

  const tokens = t.replace(/-/g, " ").split(/\s+/).filter(Boolean);

  // explicit scale word => the magnitude is stated
  if (tokens.some((tok) => tok in SCALES)) {
    const n = wordsToInt(tokens);
    if (n !== null) return { candidates: [money(n)], note: "" };
  }

  // Trader shorthand "twelve-five" = 12,500 (unit + single-digit unit, hyphenated)
  if (tokens.length === 2 && tokens[0] in UNITS && tokens[1] in UNITS) {
    const first = UNITS[tokens[0]], second = UNITS[tokens[1]];
    if (first >= 1 && second >= 1 && second <= 9 && t.includes("-")) {
      return { candidates: [money(first * 1000 + second * 100)], note: "" };
    }
  }

  const n = wordsToInt(tokens);
  if (n === null) return { candidates: [], note: `could not read an amount from ${JSON.stringify(text)}` };

  // "twelve five" (no hyphen) and "two fifty": the magnitude was never said.
  if (tokens.length === 2) {
    const a = tokens[0], b = tokens[1];
    if (a in UNITS && b in UNITS && UNITS[b] >= 1 && UNITS[b] <= 9) {
      return { candidates: [money(UNITS[a] * 1000 + UNITS[b] * 100)], note: "" };
    }
    if (a in UNITS && b in TENS) {
      const first = UNITS[a];
      const cands = [money(first * 100 + TENS[b]), money(first * 1000 + TENS[b] * 10), money((first * 100 + TENS[b]) * 1000)];
      return { candidates: cands, note: `could mean ${cands.map((c) => formatKobo(c)).join(", ")}` };
    }
  }

  if (hadCurrency || n >= 1000) return { candidates: [money(n)], note: "" };

  return {
    candidates: [money(n), money(n * 1000)],
    note: `could mean ₦${n.toLocaleString("en-US")} or ₦${(n * 1000).toLocaleString("en-US")}`,
  };
}

export function readQuantity(text: string): Reading {
  const t = clean(text);
  for (const [phrase, val] of EXTRA_QUANTITY) if (t.includes(phrase)) return { candidates: [val], note: "" };
  const m = /\b(\d+)\b/.exec(t);
  if (m) {
    if (/\b\d+\.\d+\b/.test(t)) return { candidates: [], note: "quantities must be whole" };
    const n = Number(m[1]);
    return n > 0 ? { candidates: [n], note: "" } : { candidates: [], note: "quantity must be at least 1" };
  }
  const words = t.replace(/-/g, " ").split(/\s+/).filter((w) => w in UNITS || w in TENS || w in SCALES || w === "and");
  const n = wordsToInt(words);
  if (n === null || n <= 0) return { candidates: [], note: `could not read a quantity from ${JSON.stringify(text)}` };
  return { candidates: [n], note: "" };
}

export function readTermDays(text: string): number | "end_of_month" | null {
  const t = clean(text);
  if (/\bend of (the )?month\b|\bmonth end\b/.test(t)) return "end_of_month";
  if (/\b(on delivery|cash|now|immediately|upfront)\b/.test(t)) return 0;
  let m = /\b(\d+)\s*(day|week|month)s?\b/.exec(t);
  if (m) return Number(m[1]) * { day: 1, week: 7, month: 30 }[m[2] as "day" | "week" | "month"];
  m = /\b([a-z ]+?)\s*(day|week|month)s?\b/.exec(t);
  if (m) {
    const words = m[1].split(/\s+/).filter((w) => w !== "a");
    const n = wordsToInt(words) ?? (m[1].trim() === "a" || m[1].trim() === "" ? 1 : null);
    if (n !== null) return n * { day: 1, week: 7, month: 30 }[m[2] as "day" | "week" | "month"];
  }
  return null;
}

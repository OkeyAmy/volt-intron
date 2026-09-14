/**
 * Heuristic transcript -> intent, ported from src/sautice/invoice/extract.py.
 * Conservative: recognises the common shapes of a spoken sale, leaves anything
 * uncertain empty so the executor asks. Never invents a quantity, price, or name.
 */
export interface IntentLine { qty_text: string; product_query: string; price_text: string }
export interface Intent { customer_query: string; terms_text: string; lines: IntentLine[] }

const UNITS_RE = "(?:bags?|bag|lengths?|buckets?|tins?|sheets?|trips?|rolls?|pieces?|pcs?|units?)";
const SPLIT_RE = /\s*(?:,|\band\b|\bplus\b|\balso\b|\bthen\b)\s+/i;
const FILLER_RE = /\b(please|kindly|good (morning|afternoon|evening)|record|create|make|raise|an?|the|invoice|receipt|bill|for me|i want to|i want|let me|okay|ok|so|abeg|biko|oya)\b/gi;

const NUMWORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety", "hundred", "thousand", "a", "couple", "dozen", "half",
]);

const trimPunct = (s: string) => s.replace(/^[\s.,]+|[\s.,]+$/g, "");
const stripFiller = (t: string) => trimPunct(t.replace(FILLER_RE, " ").replace(/\s+/g, " "));

export function heuristicExtract(transcript: string): Intent {
  let text = transcript.trim();
  let customer = "";

  // 0. Leading subject: "<Name> bought/wants/ordered ... <rest>".
  let m = /^\s*([A-Z][\w&.'-]*(?:\s+[A-Z0-9][\w&.'-]*){0,4})\s+(?:bought|buys?|wants?|ordered|orders?|needs?|took|purchased|purchases?|is buying|would like)\b/.exec(text);
  if (m && !/\d/.test(m[1])) { customer = trimPunct(m[1]); text = text.slice(m.index + m[0].length); }

  // 1. Trailing "for/to customer <name>".
  if (!customer) {
    m = /\bfor\s+(?:customer|client)\s+(.+?)\s*[.?!]*\s*$/i.exec(text);
    if (m) { customer = trimPunct(m[1]); text = text.slice(0, m.index); }
  }
  if (!customer) {
    m = /\bto\s+(?:customer|client)\s+(.+?)\s*[.?!]*\s*$/i.exec(text);
    if (m) { customer = trimPunct(m[1]); text = text.slice(0, m.index); }
  }
  if (!customer) {
    // Trailing "for <Capitalised Name>" with no digit is a customer, not a price.
    m = /\bfor\s+([A-Z][\w&.'-]*(?:\s+[A-Z0-9][\w&.'-]*){0,4})\s*[.?!]*\s*$/.exec(text);
    if (m && !/\d/.test(m[1])) { customer = trimPunct(m[1]); text = text.slice(0, m.index); }
  }

  // 2. Payment terms.
  let terms = "";
  m = /\b((?:net\s+\d+|\d+\s*days?|\d+\s*weeks?|end of (?:the )?month|on delivery|cash|upfront|immediately)\b.*)$/i.exec(text);
  if (m) { terms = trimPunct(m[1]); text = text.slice(0, m.index); }

  const body = stripFiller(text).replace(/^\s*for\b\s*/i, "");
  if (!body) return { customer_query: customer, terms_text: terms, lines: [] };

  const lines: IntentLine[] = [];
  for (let seg of body.split(SPLIT_RE)) {
    seg = trimPunct(seg);
    if (!seg) continue;
    const line = parseSegment(seg);
    if (line.product_query || line.qty_text || line.price_text) lines.push(line);
  }
  return { customer_query: customer, terms_text: terms, lines };
}

function parseSegment(segIn: string): IntentLine {
  let seg = segIn;
  let price = "";
  let m = /\b(?:at|@)\s+(.+?)(?:\s+(?:each|per\b.*|apiece))?\s*$/i.exec(seg);
  if (!m) m = /(?<=.)\bfor\s+(.+?)(?:\s+(?:each|per\b.*|apiece))?\s*$/i.exec(seg);
  if (m) { price = trimPunct(m[1]); seg = trimPunct(seg.slice(0, m.index)); }

  let qty = "";
  const md = /^\s*(\d+)\b/.exec(seg);
  if (md) { qty = md[1]; seg = seg.slice(md.index + md[0].length); }
  else {
    const toks = seg.split(/\s+/).filter(Boolean);
    let run = 0;
    for (const t of toks) { if (NUMWORDS.has(t.toLowerCase().replace(/-/g, ""))) run++; else break; }
    if (run) { qty = toks.slice(0, run).join(" "); seg = toks.slice(run).join(" "); }
  }

  seg = seg.replace(new RegExp("^\\s*" + UNITS_RE + "\\b", "i"), "");
  seg = seg.replace(/^\s*of\b/i, "");
  const product = trimPunct(seg.replace(/\s+/g, " "));

  return { qty_text: qty, product_query: product, price_text: price };
}

/**
 * Heuristic transcript -> intent, ported from src/sautice/invoice/extract.py.
 * Conservative: recognises the common shapes of a spoken sale, leaves anything
 * uncertain empty so the executor asks. Never invents a quantity, price, or name.
 */
import { readAmount } from "./naira";

export interface IntentLine { qty_text: string; product_query: string; price_text: string }
export interface Intent { customer_query: string; terms_text: string; lines: IntentLine[] }

const UNITS_RE = "(?:bags?|bag|lengths?|buckets?|tins?|sheets?|trips?|rolls?|pieces?|pcs?|units?)";
const SPLIT_RE = /\s*(?:,|\band\b|\bplus\b|\balso\b|\bthen\b)\s+/i;
const FILLER_RE = /\b(please|kindly|good (morning|afternoon|evening)|record|create|make|raise|an?|the|invoice|receipt|bill|for me|i want to|i want|let me|okay|ok|so|abeg|biko|oya)\b/gi;

// Polite openers said before the customer's name ("Abeg, Adebayo Stores buy ...").
// Stripped only at the very start, so they can never eat a name or number mid-sentence.
const LEAD_FILLER_RE = new RegExp(
  "^\\s*(?:(?:abeg|biko|oya|please|kindly|jowo|jọ̀wọ́|ẹ jọ̀ọ́|e jo|don allah|hello|oga|madam|sir|" +
  "good (?:morning|afternoon|evening))[\\s,.!]+)+",
  "i",
);
// Purchase verbs that follow a leading customer name, including common Pidgin forms.
const SUBJECT_VERBS =
  "(?:bought|buys?|wants?|ordered|orders?|needs?|took|takes?|purchased|purchases?|" +
  "is buying|would like|collected|collects?|carried|" +
  "(?:wan|don|go|dey|come)\\s+(?:buy|take|collect|carry|order|get))";
const NUMWORD =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|" +
  "fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|a)";
// Payment terms, with an optional spoken lead-in ("pay in", "make dem pay in", "due in")
// so the lead-in is not left behind as a bogus product line.
const TERMS_RE = new RegExp(
  "\\b((?:(?:and\\s+)?(?:make\\s+(?:dem|dey|him|am|e|she|he|they|them)\\s+)?" +
  "(?:(?:pay(?:ment)?|due)\\s+(?:in|for|within|after|on|by)\\s+|next\\s+|within\\s+|in\\s+))?" +
  "(?:net\\s+\\d+|\\d+\\s*days?|\\d+\\s*weeks?|" +
  NUMWORD + "(?:[\\s-]+" + NUMWORD + ")*\\s+(?:days?|weeks?)|" +
  "end of (?:the |di |de )?month|month end|on delivery|cash|upfront|immediately)\\b.*)$",
  "i",
);
const EACH_RE = /^(.+?)\s+(?:each|apiece|per\s+\w+)$/i;

// --- customer phrasing -------------------------------------------------------
// Speech recognition returns lowercase names ("send 5 bags to adebayo stores"), so
// customer detection cannot rely on capitalisation. Every rule below needs an
// explicit marker (a purchase verb, "to"/"for", or "invoice <name> for"), and the
// captured phrase must contain no digits and must not start with a unit or filler
// word — otherwise a product ("for cement") could be mistaken for a customer.
const TITLE = "(?:mr|mrs|ms|miss|madam|alhaji|alhaja|chief|oga|sir|dr|engr|pastor|mallam|malam)\\.?\\s+";
// Lazy repetition: the SHORTEST name that still leaves a valid verb/marker wins, so
// "Adebayo Stores wan buy ..." captures "Adebayo Stores" and leaves "wan buy" as the verb.
const NAME = "(?:[^\\W\\d_][\\w&.'-]*(?:\\s+[^\\W\\d_][\\w&.'-]*){0,4}?)";
const LEAD_IMPERATIVE_RE =
  /^\s*(?:send|put|give|add|record|create|make|raise|generate|prepare|enter|log|write|issue|bill|invoice)\s+(?:am\s+|dem\s+|out\s+|around\s+)?/i;
const NOT_NAME_START = new Set([
  "each", "naira", "delivery", "days", "day", "weeks", "week", "cash", "credit",
  "them", "dem", "me", "you", "him", "her", "us", "it", "the", "a", "an", "of",
  "and", "at", "per", "apiece", "only", "am", "abeg", "out", "around", "bag",
  "bags", "length", "lengths", "bucket", "buckets", "tin", "tins", "sheet",
  "sheets", "trip", "trips", "roll", "rolls", "piece", "pieces", "pcs", "unit",
  "units", "price", "list", "invoice", "receipt",
]);

/** Trim a captured customer phrase: drop a leading title and stray punctuation. */
function cleanName(raw: string): string {
  return trimPunct(raw.replace(new RegExp("^\\s*" + TITLE, "i"), "")).replace(/\s+/g, " ");
}

function plausibleCustomer(name: string): boolean {
  const toks = name.toLowerCase().split(/\s+/).filter(Boolean);
  return toks.length > 0 && !NOT_NAME_START.has(toks[0]) && !/\d/.test(name);
}

const NUMWORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety", "hundred", "thousand", "a", "couple", "dozen", "half",
]);

const trimPunct = (s: string) => s.replace(/^[\s.,]+|[\s.,]+$/g, "");
const stripFiller = (t: string) => trimPunct(t.replace(FILLER_RE, " ").replace(/\s+/g, " "));

/**
 * The price in a segment that is ONLY a price ("twelve-five each", "12,500 naira").
 * Needs an explicit price marker (each / per / apiece / naira / ₦) and must read as an
 * amount, so a plain second item ("two buckets of paint") is never taken as one.
 */
function barePrice(seg: string): string {
  const m = EACH_RE.exec(seg);
  let core = m ? m[1] : seg;
  if (!(m || /₦|\bnaira\b/i.test(seg))) return "";
  core = trimPunct(core.replace(/^\s*(?:na|for|at|@)\s+/i, ""));
  return core && readAmount(core).candidates.length > 0 ? core : "";
}

export function heuristicExtract(transcript: string): Intent {
  let text = transcript.normalize("NFC").trim();
  text = text.replace(LEAD_FILLER_RE, "");
  let customer = "";

  // 0a. "invoice/bill <name> for <items>".
  let m = new RegExp("^\\s*(?:invoice|bill|charge)\\s+(" + NAME + ")\\s+for\\s+", "i").exec(text);
  if (m && plausibleCustomer(cleanName(m[1]))) { customer = cleanName(m[1]); text = text.slice(m.index + m[0].length); }

  // 0b. "give/send/deliver <name> <qty> <items>" — the name sits before the quantity.
  if (!customer) {
    m = new RegExp("^\\s*(?:give|send|deliver|sell|issue)\\s+(" + NAME + ")\\s+(?=\\d|\\b" + NUMWORD + "\\b)", "i").exec(text);
    if (m && plausibleCustomer(cleanName(m[1]))) { customer = cleanName(m[1]); text = text.slice(m.index + m[0].length); }
  }

  // 0c. Leading subject: "<name> bought/wan buy/... <rest>", any capitalisation,
  //     because speech recognition rarely capitalises names.
  if (!customer) {
    m = new RegExp("^\\s*(" + NAME + ")\\s+" + SUBJECT_VERBS + "\\b", "i").exec(text);
    if (m && plausibleCustomer(cleanName(m[1]))) { customer = cleanName(m[1]); text = text.slice(m.index + m[0].length); }
  }

  // 0d. Strip a leading imperative ("send around 5 bags ...") so the quantity is
  //     the first thing in the line.
  text = text.replace(LEAD_IMPERATIVE_RE, "");

  // 1. Trailing customer clause, so it is not parsed as part of the last line item.
  if (!customer) {
    m = /\b(?:for|to)\s+(?:customer|client)\s+(.+?)\s*[.?!]*\s*$/i.exec(text);
    if (m) { customer = cleanName(m[1]); text = text.slice(0, m.index); }
  }
  if (!customer) {
    // Trailing "for/to <name>" with no digit is a customer, not a price.
    m = new RegExp("\\b(?:for|to)\\s+(" + TITLE + ")?(" + NAME + ")\\s*[.?!]*\\s*$", "i").exec(text);
    if (m && plausibleCustomer(cleanName(m[2]))) { customer = cleanName(m[2]); text = text.slice(0, m.index); }
  }

  // 2. Payment terms.
  let terms = "";
  m = TERMS_RE.exec(text);
  if (m) { terms = trimPunct(m[1]); text = text.slice(0, m.index); }

  // 3. A customer named mid-sentence, before the price or a comma:
  //    "10 lengths of iron rod to musa hardware at 8,500 each".
  if (!customer) {
    m = new RegExp("\\b(?:for|to)\\s+(" + TITLE + ")?(" + NAME + ")\\s*(?=$|[,.]|\\bat\\b|@|\\bfor\\s+\\d|\\s\\d)", "i").exec(text);
    if (m && plausibleCustomer(cleanName(m[2]))) {
      customer = cleanName(m[2]);
      text = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
    }
  }

  const body = stripFiller(text).replace(/^\s*for\b\s*/i, "");
  if (!body) return { customer_query: customer, terms_text: terms, lines: [] };

  const lines: IntentLine[] = [];
  for (let seg of body.split(SPLIT_RE)) {
    seg = trimPunct(seg);
    if (!seg) continue;
    // "five bags of cement, twelve-five each": a price-only segment prices the
    // previous line when that line has none, instead of becoming a product.
    const bare = barePrice(seg);
    if (bare && lines.length && !lines[lines.length - 1].price_text) {
      lines[lines.length - 1].price_text = bare;
      continue;
    }
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

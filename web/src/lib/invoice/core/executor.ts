/**
 * Turn an intent + selections into a computed draft — ported from
 * src/sautice/invoice/executor.py. Every figure is integer kobo computed here,
 * never guessed; a confusable/missing entity or ambiguous amount becomes a
 * question. Output shape matches web/src/lib/invoice/bridge.ts `Draft`.
 */
import type { Draft, DraftLine, DraftQuestion } from "../bridge";
import { formatKobo, koboToNairaString, mulKobo, MoneyError, nairaToKobo } from "./money";
import { readAmount, readQuantity, readTermDays, isAmbiguous, single } from "./naira";
import {
  findCustomer, findProduct, resolveCustomer, resolveProduct,
  type Customer, type Product, type Roster,
} from "./roster";
import type { Intent } from "./extract";

export interface Selections {
  customer_id?: string;
  customer_new_name?: string;
  lines?: Array<{ product_id?: string; product_new_name?: string; qty?: number; unit_price_naira?: string }>;
}

export function buildDraft(intent: Intent, roster: Roster, selections: Selections = {}, today?: string): Draft {
  const customers = roster.customers ?? [];
  const products = roster.products ?? [];
  const questions: DraftQuestion[] = [];

  const customer = resolveCustomerField(intent, selections, customers, questions);
  const lineSel = selections.lines ?? [];
  const lines: DraftLine[] = intent.lines.map((ln, i) => buildLine(i, ln, lineSel[i] ?? {}, products, questions));

  let totalKobo = 0;
  let priced = true;
  for (const ln of lines) {
    if (ln.line_total_kobo == null) priced = false;
    else totalKobo += ln.line_total_kobo;
  }

  const terms = resolveTerms(intent.terms_text, today);
  const ready = questions.length === 0 && lines.length > 0 && priced && customer.status === "resolved";

  return {
    customer,
    lines,
    terms,
    total_kobo: priced && lines.length ? totalKobo : null,
    total_display: priced && lines.length ? formatKobo(totalKobo) : null,
    questions,
    ready,
  };
}

function resolveCustomerField(intent: Intent, selections: Selections, customers: Customer[], questions: DraftQuestion[]): Draft["customer"] {
  const cid = selections.customer_id;
  if (cid === "NEW") {
    const name = (selections.customer_new_name || intent.customer_query || "").trim();
    return { status: "new", query: intent.customer_query, resolved: { id: null, name, new: true } };
  }
  if (cid) {
    const found = findCustomer(cid, customers);
    if (found) return { status: "resolved", query: intent.customer_query, resolved: found };
  }

  const res = resolveCustomer(intent.customer_query, customers);
  if (res.status === "ambiguous") {
    questions.push({
      id: "customer", kind: "choice", field: "customer",
      prompt: `Which customer did you mean by '${res.query}'?`,
      options: [...res.candidates.map((c) => ({ value: c.id, label: c.name })), { value: "NEW", label: `New customer: ${res.query}` }],
    });
  } else if (res.status === "unknown" || res.status === "missing") {
    const q = res.query || "";
    questions.push({
      id: "customer", kind: q ? "confirm_new" : "text", field: "customer",
      prompt: q ? `'${q}' isn't in your customers. Add as a new customer?` : "Who is this invoice for?",
      options: q ? [{ value: "NEW", label: `New customer: ${q}` }] : [],
    });
  }
  return { status: res.status, query: res.query, resolved: res.resolved, candidates: res.candidates };
}

function buildLine(i: number, line: Intent["lines"][number], sel: NonNullable<Selections["lines"]>[number], products: Product[], questions: DraftQuestion[]): DraftLine {
  // --- product ---
  let product: DraftLine["product"];
  const pid = sel.product_id;
  if (pid === "NEW") {
    product = { status: "new", resolved: { id: null, name: sel.product_new_name || line.product_query, new: true, unit_price_kobo: null } };
  } else if (pid) {
    const found = findProduct(pid, products);
    product = found ? { status: "resolved", resolved: found } : resolveProduct(line.product_query, products);
  } else {
    product = resolveProduct(line.product_query, products);
  }

  if (product.status === "ambiguous") {
    questions.push({
      id: `line:${i}:product`, kind: "choice", field: "product", line: i,
      prompt: `Which product did you mean by '${line.product_query}'?`,
      options: ((product.candidates ?? []) as Product[]).map((p) => ({ value: p.id, label: `${p.name} - ${formatKobo(p.unit_price_kobo)}` })),
    });
  } else if (product.status === "unknown" || product.status === "missing") {
    questions.push({
      id: `line:${i}:product`, kind: line.product_query ? "confirm_new" : "text", field: "product", line: i,
      prompt: line.product_query ? `'${line.product_query}' isn't in your catalogue. Add it?` : "What product is this line?",
      options: line.product_query ? [{ value: "NEW", label: `New product: ${line.product_query}` }] : [],
    });
  }
  const resolvedProduct = product.resolved ?? null;

  // --- quantity ---
  let qty: number | null = null;
  if (sel.qty != null) qty = Math.floor(Number(sel.qty));
  else {
    const r = line.qty_text ? readQuantity(line.qty_text) : null;
    if (!r || r.candidates.length === 0) {
      questions.push({ id: `line:${i}:qty`, kind: "number", field: "qty", line: i, prompt: `How many for '${line.product_query || "this item"}'?` });
    } else if (isAmbiguous(r)) {
      questions.push({ id: `line:${i}:qty`, kind: "choice", field: "qty", line: i, prompt: `What quantity - ${r.note}?`, options: r.candidates.map((c) => ({ value: c, label: String(c) })) });
    } else qty = single(r);
  }

  // --- unit price ---
  let unitPriceKobo: number | null = null;
  let unitPriceSource: DraftLine["unit_price_source"] = null;
  if (sel.unit_price_naira != null) {
    try { unitPriceKobo = nairaToKobo(String(sel.unit_price_naira)); unitPriceSource = "corrected"; }
    catch (e) { if (e instanceof MoneyError) questions.push({ id: `line:${i}:price`, kind: "amount", field: "price", line: i, prompt: "That price didn't read as a naira amount. What is the unit price?" }); else throw e; }
  } else if (line.price_text) {
    const r = readAmount(line.price_text);
    if (r.candidates.length === 0) {
      questions.push({ id: `line:${i}:price`, kind: "amount", field: "price", line: i, prompt: `What is the unit price for '${line.product_query || "this item"}'?` });
    } else if (isAmbiguous(r)) {
      questions.push({ id: `line:${i}:price`, kind: "choice", field: "price", line: i, prompt: `What price - ${r.note}?`, options: r.candidates.map((c) => ({ value: koboToNairaString(c), label: formatKobo(c) })) });
    } else { unitPriceKobo = single(r); unitPriceSource = "spoken"; }
  } else if (resolvedProduct && resolvedProduct.unit_price_kobo != null) {
    unitPriceKobo = resolvedProduct.unit_price_kobo;
    unitPriceSource = "catalog";
  } else if (product.status !== "ambiguous" && product.status !== "unknown" && product.status !== "missing") {
    questions.push({ id: `line:${i}:price`, kind: "amount", field: "price", line: i, prompt: `What is the unit price for '${resolvedProduct?.name || line.product_query || "this item"}'?` });
  }

  const lineTotalKobo = qty != null && unitPriceKobo != null ? mulKobo(unitPriceKobo, qty) : null;

  return {
    index: i,
    query: line.product_query,
    product,
    qty,
    unit_price_kobo: unitPriceKobo,
    unit_price_display: unitPriceKobo != null ? formatKobo(unitPriceKobo) : null,
    unit_price_source: unitPriceSource,
    line_total_kobo: lineTotalKobo,
    line_total_display: lineTotalKobo != null ? formatKobo(lineTotalKobo) : null,
  };
}

function resolveTerms(termsText: string, today?: string): Draft["terms"] {
  if (!termsText) return { text: "", days: null, due_date: null };
  const days = readTermDays(termsText);
  const base = parseToday(today);
  let due: string | null = null;
  if (typeof days === "number") {
    const d = new Date(base.getTime() + days * 86_400_000);
    due = d.toISOString().slice(0, 10);
  } else if (days === "end_of_month") {
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
    due = last.toISOString().slice(0, 10);
  }
  return { text: termsText, days: typeof days === "number" ? days : null, rule: typeof days === "string" ? days : null, due_date: due };
}

function parseToday(today?: string): Date {
  if (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) return new Date(today + "T00:00:00Z");
  return new Date();
}

/**
 * Workspace roster + name resolution — ported from src/sautice/invoice/roster.py.
 * A single clear match resolves; a confusable-cluster tie stays ambiguous (a
 * question); an unrecognised name becomes a candidate new entity — never snapped.
 *
 * roster.json here is a synced copy of benchmarks/data/sautibench/roster.json
 * (bundled so the serverless function needs no filesystem read).
 */
import rosterData from "../data/roster.json";

export interface Customer { id: string; name: string; phone?: string; cluster?: string }
export interface Product { id: string; name: string; unit?: string; unit_price_kobo: number; aliases?: string[]; cluster?: string }
export interface Roster { business?: Record<string, unknown>; customers: Customer[]; products: Product[] }

export const ROSTER = rosterData as unknown as Roster;

export interface Resolution<T> { status: "resolved" | "ambiguous" | "unknown" | "missing"; query: string; resolved?: T; candidates: T[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const CUST_STOP = new Set(["stores", "store", "ltd", "limited", "nig", "nigeria", "co", "company",
  "enterprises", "ventures", "trading", "global", "concept", "services", "and", "sons", "brothers", "&"]);
const PROD_STOP = new Set(["the", "a", "of", "and"]);

const toks = (s: string, stop: Set<string>) => new Set(norm(s).split(" ").filter((t) => t && !stop.has(t)));
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;

const custView = (c: Customer): Customer => ({ id: c.id, name: c.name });
const prodView = (p: Product): Product => ({ id: p.id, name: p.name, unit: p.unit, unit_price_kobo: p.unit_price_kobo });

export function resolveCustomer(query: string, customers: Customer[]): Resolution<Customer> {
  const q = norm(query);
  if (!q) return { status: "missing", query, candidates: [] };

  const exact = customers.filter((c) => norm(c.name) === q);
  if (exact.length === 1) return { status: "resolved", query, resolved: custView(exact[0]), candidates: [custView(exact[0])] };

  const qt = toks(query, CUST_STOP);
  const hits: [number, Customer][] = [];
  for (const c of customers) {
    const ov = overlap(qt, toks(c.name, CUST_STOP));
    if (q && norm(c.name).includes(q)) hits.push([ov + 5, c]);
    else if (ov) hits.push([ov, c]);
  }
  hits.sort((a, b) => b[0] - a[0]);
  if (hits.length === 0) return { status: "unknown", query, candidates: [] };
  const top = hits[0][0];
  const tied = hits.filter(([s]) => s === top);
  if (tied.length === 1) return { status: "resolved", query, resolved: custView(tied[0][1]), candidates: hits.slice(0, 5).map(([, c]) => custView(c)) };
  return { status: "ambiguous", query, candidates: hits.slice(0, 5).map(([, c]) => custView(c)) };
}

export function resolveProduct(query: string, products: Product[]): Resolution<Product> {
  const q = norm(query);
  if (!q) return { status: "missing", query, candidates: [] };

  const exact = products.filter((p) => norm(p.name) === q);
  if (exact.length === 1) return { status: "resolved", query, resolved: prodView(exact[0]), candidates: [prodView(exact[0])] };

  const qt = toks(query, PROD_STOP);
  const hits: [number, Product][] = [];
  for (const p of products) {
    const names = [p.name, ...(p.aliases ?? [])];
    const aliasHit = (p.aliases ?? []).some((a) => norm(a).includes(q) || q.includes(norm(a)));
    const ov = Math.max(0, ...names.map((n) => overlap(qt, toks(n, PROD_STOP))));
    if (aliasHit) hits.push([ov + 5, p]);
    else if (ov) hits.push([ov, p]);
  }
  hits.sort((a, b) => b[0] - a[0]);
  if (hits.length === 0) return { status: "unknown", query, candidates: [] };
  const top = hits[0][0];
  const tied = hits.filter(([s]) => s === top);
  if (tied.length === 1) return { status: "resolved", query, resolved: prodView(tied[0][1]), candidates: hits.slice(0, 5).map(([, p]) => prodView(p)) };
  return { status: "ambiguous", query, candidates: hits.slice(0, 5).map(([, p]) => prodView(p)) };
}

export const findCustomer = (id: string, customers: Customer[]): Customer | null => {
  const c = customers.find((x) => x.id === id);
  return c ? custView(c) : null;
};
export const findProduct = (id: string, products: Product[]): Product | null => {
  const p = products.find((x) => x.id === id);
  return p ? prodView(p) : null;
};

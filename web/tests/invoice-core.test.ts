/**
 * Guards the TypeScript invoice core (the serverless port of the Python engine).
 * Mirrors tests/test_invoice.py so the two stay in parity — every figure computed
 * here must match what the authoritative Python core produces.
 */
import { describe, it, expect } from "vitest";
import { draftFromRequest } from "@/lib/invoice/core";
import { heuristicExtract } from "@/lib/invoice/core/extract";
import { readAmount, readQuantity, isAmbiguous } from "@/lib/invoice/core/naira";
import { resolveCustomer, resolveProduct, ROSTER } from "@/lib/invoice/core/roster";

const draft = (transcript: string, selections: object = {}) =>
  draftFromRequest({ transcript, selections, today: "2026-09-14" }).draft;

describe("number grammar (refuses to guess)", () => {
  it("reads plain digits and word amounts to the same kobo", () => {
    expect(readAmount("12500").candidates).toEqual([1_250_000]);
    expect(readAmount("twelve thousand five hundred").candidates).toEqual([1_250_000]);
    expect(readAmount("12.5k").candidates).toEqual([1_250_000]);
    expect(readAmount("twelve-five").candidates).toEqual([1_250_000]);
  });
  it("keeps genuinely ambiguous amounts as multiple candidates", () => {
    const r = readAmount("two fifty");
    expect(isAmbiguous(r)).toBe(true);
    expect(r.candidates).toEqual([25_000, 250_000, 25_000_000]);
  });
  it("reads whole quantities and rejects fractional ones", () => {
    expect(readQuantity("five").candidates).toEqual([5]);
    expect(readQuantity("2.5").candidates).toEqual([]);
  });
});

describe("resolution (no snapping)", () => {
  it("resolves an exact name over confusable siblings", () => {
    expect(resolveCustomer("Adebayo Stores", ROSTER.customers).resolved?.id).toBe("c01");
  });
  it("keeps a confusable cluster ambiguous", () => {
    const r = resolveCustomer("Musa", ROSTER.customers);
    expect(r.status).toBe("ambiguous");
    expect(new Set(r.candidates.map((c) => c.id))).toEqual(new Set(["c08", "c09"]));
  });
  it("does not snap an unknown name", () => {
    expect(resolveCustomer("Zonatech Global", ROSTER.customers).status).toBe("unknown");
  });
  it("resolves a product alias", () => {
    expect(resolveProduct("cement", ROSTER.products).resolved?.id).toBe("p01");
  });
});

describe("draft computation", () => {
  it("computes the example total and is ready", () => {
    const d = draft("Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each");
    expect(d.customer.resolved?.name).toBe("Adebayo Stores");
    expect(d.lines[0].line_total_kobo).toBe(6_250_000);
    expect(d.total_display).toBe("₦62,500");
    expect(d.ready).toBe(true);
    expect(d.questions).toEqual([]);
  });
  it("labels a spoken price and uses the catalogue price otherwise", () => {
    expect(draft("invoice for 5 bags of cement at 12500 naira each for customer Musa", { customer_id: "c08", lines: [] }).lines[0].unit_price_source).toBe("spoken");
    const cat = draft("100 trips of granite for Adebayo Stores", { customer_id: "c01", lines: [] });
    expect(cat.lines[0].unit_price_kobo).toBe(12_000_000);
    expect(cat.lines[0].line_total_kobo).toBe(1_200_000_000);
  });
  it("asks about a confusable customer and becomes ready once answered", () => {
    expect(draft("invoice for 5 bags of cement at 12500 each for customer Musa").ready).toBe(false);
    const answered = draft("invoice for 5 bags of cement at 12500 each for customer Musa", { customer_id: "c08", lines: [] });
    expect(answered.ready).toBe(true);
    expect(answered.customer.resolved?.name).toBe("Musa Hardware");
  });
  it("turns an ambiguous amount into a price question, not a guess", () => {
    const d = draft("2 bags of cement at two fifty each for Adebayo Stores");
    expect(d.questions.some((q) => q.id === "line:0:price")).toBe(true);
    expect(d.lines[0].line_total_kobo).toBeNull();
  });
  it("offers a new customer rather than snapping", () => {
    const d = draft("invoice for 5 bags of cement at 12500 each for customer Zonatech");
    const cq = d.questions.find((q) => q.id === "customer");
    expect(cq?.options?.some((o) => o.value === "NEW")).toBe(true);
  });
});

// Mirrors TestCodeSwitchedPhrasing in tests/test_invoice.py.
describe("code-switched phrasing", () => {
  it("keeps the customer after a leading 'Abeg,'", () => {
    const d = draft("Abeg, Adebayo Stores buy five bags of Dangote cement at twelve thousand five hundred naira each");
    expect(d.customer.status).toBe("resolved");
    expect(d.ready).toBe(true);
    expect(d.total_kobo).toBe(6_250_000);
  });

  it("recognises a Pidgin purchase verb", () => {
    const i = heuristicExtract("Adebayo Stores wan buy five bags of Dangote cement at twelve-five each");
    expect(i.customer_query).toBe("Adebayo Stores");
    expect(i.lines[0].qty_text).toBe("five");
    expect(i.lines[0].price_text).toBe("twelve-five");
  });

  it("reads a Pidgin payment term instead of making it a product", () => {
    const d = draft("Adebayo Stores buy five bags Dangote cement at twelve-five each, make dem pay in 14 days");
    expect(d.lines).toHaveLength(1);
    expect(d.ready).toBe(true);
    expect(d.terms.days).toBe(14);
  });

  it("reads 'pay in fourteen days' as a term", () => {
    const i = heuristicExtract("Adebayo Stores bought 5 bags of Dangote cement, pay in fourteen days");
    expect(i.lines).toHaveLength(1);
    expect(i.terms_text).toBe("pay in fourteen days");
  });

  it("uses a price given after a comma for the previous line", () => {
    const d = draft("Adebayo Stores wan buy five bags of Dangote cement, twelve-five each");
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].unit_price_kobo).toBe(1_250_000);
    expect(d.ready).toBe(true);
  });

  it("never takes a plain second item as a price", () => {
    const i = heuristicExtract("Adebayo Stores bought five bags of cement, two buckets of paint");
    expect(i.lines).toHaveLength(2);
    expect(i.lines[1].price_text).toBe("");
    expect(i.lines[1].product_query).toContain("paint");
  });
});

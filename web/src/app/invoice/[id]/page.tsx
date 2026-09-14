/**
 * Printable invoice view. Reads the issued record from the store and renders it;
 * the figures are the snapshot taken at confirmation, not recomputed here. Use the
 * browser's print dialog to save a PDF.
 */
import fs from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getInvoice } from "@/lib/invoice/store";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Business { name: string; address?: string; phone?: string; email?: string }

function repoRoot(): string {
  if (process.env.SAUTICE_ROOT) return process.env.SAUTICE_ROOT;
  const cwd = process.cwd();
  return path.basename(cwd) === "web" ? path.dirname(cwd) : cwd;
}

function loadBusiness(): Business {
  try {
    const p = process.env.SAUTICE_ROSTER || path.join(repoRoot(), "benchmarks", "data", "sautibench", "roster.json");
    // turbopackIgnore: runtime read of a known data file, not an app-source import.
    const roster = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ p, "utf8"));
    return roster.business ?? { name: "Your Business" };
  } catch {
    return { name: "Your Business" };
  }
}

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inv = getInvoice(id);
  if (!inv) notFound();

  const biz = loadBusiness();
  const d = inv.snapshot;
  const issued = new Date(inv.created_at).toISOString().slice(0, 10);

  return (
    <div className="inv-page">
      <article className="inv-sheet">
        <header className="inv-head">
          <div>
            <div className="inv-biz">{biz.name}</div>
            {biz.address && <div className="inv-muted">{biz.address}</div>}
            {(biz.phone || biz.email) && <div className="inv-muted">{[biz.phone, biz.email].filter(Boolean).join(" · ")}</div>}
          </div>
          <div className="inv-title">
            <div className="inv-word">INVOICE</div>
            <div className="inv-muted">{inv.number}</div>
          </div>
        </header>

        <section className="inv-meta">
          <div>
            <div className="inv-label">Bill to</div>
            <div className="inv-strong">{inv.customer_name ?? "—"}</div>
          </div>
          <div className="inv-right">
            <div className="inv-label">Issued</div>
            <div>{issued}</div>
            {d.terms?.due_date && (<><div className="inv-label">Due</div><div>{d.terms.due_date}</div></>)}
          </div>
        </section>

        <table className="inv-table">
          <thead>
            <tr><th>Description</th><th className="inv-num">Qty</th><th className="inv-num">Unit price</th><th className="inv-num">Amount</th></tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.index}>
                <td>{l.product?.resolved?.name ?? l.query}</td>
                <td className="inv-num">{l.qty ?? "—"}</td>
                <td className="inv-num">{l.unit_price_display ?? "—"}</td>
                <td className="inv-num">{l.line_total_display ?? "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={3} className="inv-num inv-strong">Total</td><td className="inv-num inv-total">{d.total_display ?? "—"}</td></tr>
          </tfoot>
        </table>

        <p className="inv-note">
          This is an invoice prototype for a hackathon demo. It is not a FIRS/NRS-fiscalised document
          and represents no payment settlement.
        </p>
      </article>

      <div className="inv-actions inv-noprint">
        <PrintButton />
        <Link className="sr-btn sr-ghost" href="/">New recording</Link>
      </div>
    </div>
  );
}

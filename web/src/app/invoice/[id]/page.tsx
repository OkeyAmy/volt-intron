/**
 * Printable invoice view. Reads the issued record from the store and renders it;
 * the figures are the snapshot taken at confirmation, not recomputed here. Use the
 * browser's print dialog to save a PDF.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { getInvoice, isStoreNotConfigured, type InvoiceRow } from "@/lib/invoice/store";
import { formatDateLagos, formatIsoDay } from "@/lib/invoice/format";
import { ROSTER } from "@/lib/invoice/core/roster";
import PrintButton from "./PrintButton";
import ShareButton from "../../ShareButton";
import StoreUnavailable from "../../StoreUnavailable";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30; // allow a serverless DB cold start (Neon idle wake)

interface Business { name: string; address?: string; phone?: string; email?: string }

// Bundled roster (no filesystem read, so it works on serverless too).
const biz = (ROSTER.business as unknown as Business) ?? { name: "Your Business" };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let inv: InvoiceRow | null;
  try {
    inv = await getInvoice(id);
  } catch (e) {
    console.error("[invoice]", e);
    return (
      <main id="main" className="page-main">
        <StoreUnavailable notConfigured={isStoreNotConfigured(e)} retryHref={`/invoice/${encodeURIComponent(id)}`} />
      </main>
    );
  }
  if (!inv) notFound();
  const d = inv.snapshot;

  return (
    <main id="main" className="inv-page">
      <nav className="inv-actions inv-noprint" aria-label="Invoice actions">
        <Link className="sr-btn sr-ghost" href="/invoices">← All invoices</Link>
        <span className="inv-actions-right">
          <ShareButton id={inv.id} number={inv.number} />
          <PrintButton />
        </span>
      </nav>

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
            <div>{formatDateLagos(inv.created_at)}</div>
            {d.terms?.due_date && (<><div className="inv-label">Due</div><div>{formatIsoDay(d.terms.due_date)}</div></>)}
          </div>
        </section>

        <div className="inv-tablewrap">
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
        </div>

        <p className="inv-note">
          This is an invoice prototype for a hackathon demo. It is not a FIRS/NRS-fiscalised document
          and represents no payment settlement.
        </p>
      </article>

      <div className="inv-actions inv-noprint">
        <Link className="sr-btn sr-primary" href="/">Make another invoice</Link>
      </div>
    </main>
  );
}

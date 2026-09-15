/**
 * Screen F: find an invoice. Server-rendered list of issued invoices, newest
 * first, with a plain GET search over the number or customer name — no JS needed,
 * so it works on any connection. An empty account shows a useful empty state, not
 * invented transactions; an unreachable store shows a notice, not a server error.
 */
import Link from "next/link";
import { isStoreNotConfigured, listInvoices, type InvoiceListItem } from "@/lib/invoice/store";
import { formatDateLagos, formatKobo } from "@/lib/invoice/format";
import StoreUnavailable from "../StoreUnavailable";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30; // allow a serverless DB cold start (Neon idle wake)
export const metadata = { title: "Invoices — Sautice" };

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  let invoices: InvoiceListItem[] | null = null;
  let notConfigured = false;
  try {
    invoices = await listInvoices({ q: query, limit: 200 });
  } catch (e) {
    console.error("[invoices]", e);
    notConfigured = isStoreNotConfigured(e);
  }

  return (
    <main id="main" className="page-main">
      <div className="page-headrow">
        <h1 className="page-h1">Invoices</h1>
        <Link className="sr-btn sr-primary sr-btn-sm" href="/">New invoice</Link>
      </div>

      {invoices === null ? (
        <StoreUnavailable notConfigured={notConfigured} retryHref={query ? `/invoices?q=${encodeURIComponent(query)}` : "/invoices"} />
      ) : (
        <>
          <form className="find-form" role="search" action="/invoices" method="get">
            <label className="sr-label" htmlFor="q">Search by customer or invoice number</label>
            <div className="find-row">
              <input id="q" name="q" className="sr-select find-input" type="search" defaultValue={query}
                placeholder="e.g. Adebayo or INV-00001" enterKeyHint="search" />
              <button className="sr-btn sr-primary" type="submit">Search</button>
              {query && <Link className="sr-btn sr-ghost" href="/invoices">Clear</Link>}
            </div>
          </form>

          {invoices.length === 0 ? (
            <div className="empty">
              <p className="empty-title">{query ? `No invoices match "${query}".` : "No invoices yet"}</p>
              <p className="sr-expect">
                {query ? "Check the spelling, or search by invoice number instead." : "Invoices you create will be listed here, newest first."}
              </p>
              <Link className="sr-btn sr-primary" href="/">Create an invoice</Link>
            </div>
          ) : (
            <>
              <p className="sr-meta" aria-live="polite">
                {invoices.length} {invoices.length === 1 ? "invoice" : "invoices"}{query ? ` matching "${query}"` : ""}
              </p>
              <ul className="find-list">
                {invoices.map((inv) => (
                  <li key={inv.id} className="find-item">
                    <Link href={`/invoice/${inv.id}`} className="find-link">
                      <span className="find-main">
                        <span className="find-cust">{inv.customer_name ?? "—"}</span>
                        <span className="find-meta">
                          <span className="find-badge">Issued</span>
                          <span className="sr-meta">{inv.number}</span>
                          <span className="sr-meta">{formatDateLagos(inv.created_at)}</span>
                        </span>
                      </span>
                      <span className="find-amount">{formatKobo(inv.total_kobo)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </main>
  );
}

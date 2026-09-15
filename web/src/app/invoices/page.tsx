/**
 * Screen F: find an invoice. Server-rendered list of issued invoices, newest
 * first, with a plain GET search over the number or customer name — no JS needed,
 * so it works on any connection. An empty account shows a useful empty state, not
 * invented transactions.
 */
import Link from "next/link";
import { listInvoices } from "@/lib/invoice/store";
import { formatKobo } from "@/lib/invoice/format";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30; // allow a serverless DB cold start (Neon idle wake)

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const invoices = await listInvoices({ q: query, limit: 200 });

  return (
    <main className="page-main">
      <h1 className="page-h1">Invoices</h1>

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
          <p className="sr-placeholder">
            {query ? `No invoices match "${query}".` : "Your invoices will appear here."}
          </p>
          <Link className="sr-btn sr-primary" href="/">Create an invoice</Link>
        </div>
      ) : (
        <ul className="find-list">
          {invoices.map((inv) => (
            <li key={inv.id} className="find-item">
              <Link href={`/invoice/${inv.id}`} className="find-link">
                <span className="find-cust">{inv.customer_name ?? "—"}</span>
                <span className="find-meta">
                  <span className="find-badge">Issued</span>
                  <span className="sr-meta">{inv.number}</span>
                  <span className="sr-meta">{new Date(inv.created_at).toISOString().slice(0, 10)}</span>
                </span>
                <span className="find-amount">{formatKobo(inv.total_kobo)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

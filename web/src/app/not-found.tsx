import Link from "next/link";

export const metadata = { title: "Not found — Sautice" };

export default function NotFound() {
  return (
    <main id="main" className="page-main">
      <section className="notice">
        <h1 className="notice-h2">We couldn&apos;t find that page</h1>
        <p className="notice-body">The link may be mistyped, or the invoice may not exist.</p>
        <div className="sr-controls">
          <Link className="sr-btn sr-primary" href="/invoices">See all invoices</Link>
          <Link className="sr-btn sr-ghost" href="/">Make an invoice</Link>
        </div>
      </section>
    </main>
  );
}

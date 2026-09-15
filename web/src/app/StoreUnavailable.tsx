/**
 * Shown in place of a page's content when the invoice store can't be reached, so
 * a missing or sleeping database reads as a clear notice instead of a server error.
 */
import Link from "next/link";

export default function StoreUnavailable({ notConfigured, retryHref }: { notConfigured: boolean; retryHref: string }) {
  return (
    <section className="notice" role="alert">
      <h2 className="notice-h2">{notConfigured ? "Invoices aren't set up yet" : "Invoices couldn't load"}</h2>
      <p className="notice-body">
        {notConfigured
          ? "This site isn't connected to a database, so invoices can't be saved or shown. The site owner needs to add one."
          : "We couldn't reach your saved invoices just now. This usually clears up in a few seconds."}
      </p>
      <div className="sr-controls">
        {!notConfigured && <a className="sr-btn sr-primary" href={retryHref}>Try again</a>}
        <Link className={`sr-btn ${notConfigured ? "sr-primary" : "sr-ghost"}`} href="/">Make an invoice</Link>
      </div>
    </section>
  );
}

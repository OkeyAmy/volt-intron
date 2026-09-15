/** Placeholder rows while the invoice list loads (a sleeping database can take a few seconds). */
export default function InvoicesLoading() {
  return (
    <main id="main" className="page-main" aria-busy="true">
      <h1 className="page-h1">Invoices</h1>
      <p className="sr-status" role="status">Loading your invoices…</p>
      <ul className="find-list" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="find-item skel-row">
            <span className="skel skel-line" style={{ width: "45%" }} />
            <span className="skel skel-line" style={{ width: "20%" }} />
          </li>
        ))}
      </ul>
    </main>
  );
}

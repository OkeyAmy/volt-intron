"use client";

/**
 * Last-resort boundary for anything a page didn't handle itself. Production strips
 * the error message, so this says what to do rather than what went wrong.
 */
import { useEffect } from "react";
import Link from "next/link";

export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main id="main" className="page-main">
      <section className="notice" role="alert">
        <h1 className="notice-h2">Something went wrong</h1>
        <p className="notice-body">This page didn&apos;t load properly. Trying again usually fixes it.</p>
        <div className="sr-controls">
          <button className="sr-btn sr-primary" onClick={() => retry()}>Try again</button>
          <Link className="sr-btn sr-ghost" href="/">Make an invoice</Link>
        </div>
      </section>
    </main>
  );
}

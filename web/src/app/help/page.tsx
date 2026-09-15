/**
 * Help: short, task-adjacent guidance. No marketing, no jargon — what to say, how
 * the microphone works, and which speech languages are available.
 */
import Link from "next/link";

export const metadata = { title: "Help — Sautice" };

export default function HelpPage() {
  return (
    <main id="main" className="page-main">
      <h1 className="page-h1">Help</h1>

      <section className="help-card">
        <h2 className="help-h2">What to say</h2>
        <p>Say the customer, what you sold, the quantity, and the price. For example:</p>
        <blockquote className="help-quote">
          &ldquo;Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each.&rdquo;
        </blockquote>
        <p className="sr-meta">You&apos;ll always check the details before the invoice is created.</p>
      </section>

      <section className="help-card">
        <h2 className="help-h2">Using the microphone</h2>
        <ul className="help-list">
          <li>Tap <strong>Start speaking</strong>, then allow the microphone when your browser asks.</li>
          <li>Speak normally, then tap <strong>Stop</strong>. Tap <strong>Cancel</strong> to throw the recording away instead.</li>
          <li>Keep each recording under two minutes. One sale at a time works best.</li>
          <li>You&apos;ll see the words we heard before anything else happens. Fix any wrong word, then tap <strong>Check the details</strong>.</li>
          <li>If the microphone is blocked, allow it in your browser settings — or tap <strong>Type instead</strong>.</li>
          <li>Recording needs a secure (https) page. On a phone, a quiet spot helps accuracy.</li>
        </ul>
      </section>

      <section className="help-card">
        <h2 className="help-h2">Typing instead</h2>
        <p>Typing works exactly like speaking. Write the sale the way you would say it, in your own words, and you&apos;ll get the same check before the invoice is created.</p>
      </section>

      <section className="help-card">
        <h2 className="help-h2">Speech languages</h2>
        <p>The app understands naturally mixed speech. Pick the pair that matches how you talk:</p>
        <ul className="help-list">
          <li>Pidgin + English</li>
          <li>Yoruba + English</li>
          <li>Igbo + English</li>
          <li>Hausa + English</li>
          <li>English</li>
        </ul>
        <p className="sr-meta">The buttons and labels stay in simple English whichever speech language you choose.</p>
      </section>

      <Link className="sr-btn sr-primary help-cta" href="/">Make an invoice</Link>
    </main>
  );
}

"use client";

/**
 * Draft review: transcript -> draft -> answer questions -> confirm -> invoice.
 *
 * Every figure shown here comes from the server (the Python money engine); this
 * component never computes a total. Confirmation is bound to the draft's version,
 * and a fresh idempotency key is minted once per review so a double-click cannot
 * issue two invoices.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Draft, DraftQuestion } from "@/lib/invoice/bridge";

interface Selections {
  customer_id?: string;
  customer_new_name?: string;
  lines: Array<{ product_id?: string; product_new_name?: string; qty?: number; unit_price_naira?: string }>;
}

export default function DraftReview({ transcript, onIssued, onCancel }: {
  transcript: string;
  onIssued: (id: string, number: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const selRef = useRef<Selections>({ lines: [] });
  const idemRef = useRef<string>(crypto.randomUUID());

  const fetchDraft = useCallback(async (selections: Selections, id: string | null) => {
    const res = await fetch("/api/invoice/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript, selections, draftId: id }),
    });
    return res.json();
  }, [transcript]);

  const applyDraft = useCallback((data: { ok: boolean; error?: string; draft?: Draft; draftId?: string; version?: number }) => {
    if (!data.ok || !data.draft) { setError(data.error ?? "Could not build the draft."); return; }
    setDraft(data.draft); setDraftId(data.draftId ?? null); setVersion(data.version ?? 0);
  }, []);

  const post = useCallback(async (selections: Selections, id: string | null) => {
    setBusy(true); setError("");
    try { applyDraft(await fetchDraft(selections, id)); }
    catch (e) { setError(`Could not reach the server: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, [fetchDraft, applyDraft]);

  // Initial draft on mount. State is set only after the request resolves, so this
  // does not synchronously cascade renders.
  useEffect(() => {
    let cancelled = false;
    fetchDraft({ lines: [] }, null)
      .then((data) => { if (!cancelled) applyDraft(data); })
      .catch((e) => { if (!cancelled) setError(`Could not reach the server: ${(e as Error).message}`); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [fetchDraft, applyDraft]);

  const answer = useCallback((q: DraftQuestion, value: string | number) => {
    const sel = structuredClone(selRef.current);
    while (draft && sel.lines.length < draft.lines.length) sel.lines.push({});
    if (q.field === "customer") {
      if (value === "NEW") { sel.customer_id = "NEW"; sel.customer_new_name = draft?.customer.query ?? ""; }
      else sel.customer_id = String(value);
    } else if (q.line != null) {
      const i = q.line; sel.lines[i] = sel.lines[i] ?? {};
      if (q.field === "product") {
        if (value === "NEW") { sel.lines[i].product_id = "NEW"; sel.lines[i].product_new_name = draft?.lines[i]?.query ?? ""; }
        else sel.lines[i].product_id = String(value);
      } else if (q.field === "qty") sel.lines[i].qty = Number(value);
      else if (q.field === "price") sel.lines[i].unit_price_naira = String(value);
    }
    selRef.current = sel;
    post(sel, draftId);
  }, [draft, draftId, post]);

  const confirm = useCallback(async () => {
    if (!draftId) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/invoice/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftId, version, idempotencyKey: idemRef.current }),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.error ?? "Could not issue the invoice."); setBusy(false); return; }
      onIssued(data.invoice.id, data.invoice.number);
    } catch (e) {
      setError(`Could not reach the server: ${(e as Error).message}`);
      setBusy(false);
    }
  }, [draftId, version, onIssued]);

  if (!draft) {
    return (
      <div className="sr-transcript" aria-live="polite">
        {error ? <span className="sr-error">{error}</span> : <span className="sr-placeholder">Building your draft…</span>}
      </div>
    );
  }

  const customerName = draft.customer.resolved?.name ?? draft.customer.query;
  return (
    <div className="rev">
      <div className="rev-head">
        <span className="sr-label">Customer</span>
        <strong>{draft.customer.status === "resolved" || draft.customer.status === "new" ? customerName : <em className="sr-placeholder">to confirm</em>}</strong>
      </div>

      <table className="rev-table">
        <thead>
          <tr><th>Item</th><th className="rev-num">Qty</th><th className="rev-num">Unit</th><th className="rev-num">Total</th></tr>
        </thead>
        <tbody>
          {draft.lines.map((l) => (
            <tr key={l.index}>
              <td>{l.product.resolved?.name ?? l.query ?? <em className="sr-placeholder">?</em>}</td>
              <td className="rev-num">{l.qty ?? "—"}</td>
              <td className="rev-num">
                {l.unit_price_display ?? "—"}
                {l.unit_price_source === "spoken" && <span className="rev-tag" title="Price you said, overriding the catalogue">said</span>}
                {l.unit_price_source === "catalog" && <span className="rev-tag" title="From your catalogue">list</span>}
              </td>
              <td className="rev-num">{l.line_total_display ?? "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={3} className="rev-num"><strong>Total</strong></td><td className="rev-num"><strong>{draft.total_display ?? "—"}</strong></td></tr>
        </tfoot>
      </table>

      {draft.terms.due_date && <p className="sr-meta">Payment due {draft.terms.due_date}</p>}

      {draft.questions.length > 0 && (
        <div className="rev-questions">
          {draft.questions.map((q) => (
            <fieldset key={q.id} className="rev-q">
              <legend>{q.prompt}</legend>
              {(q.kind === "choice" || q.kind === "confirm_new") && q.options?.length ? (
                <div className="rev-opts">
                  {q.options.map((o) => (
                    <button key={String(o.value)} className="sr-btn sr-ghost rev-opt" onClick={() => answer(q, o.value)} disabled={busy}>
                      {o.label}
                    </button>
                  ))}
                </div>
              ) : (
                <FreeInput kind={q.kind} disabled={busy} onSet={(v) => answer(q, v)} />
              )}
            </fieldset>
          ))}
        </div>
      )}

      {error && <div className="sr-error" role="alert">{error}</div>}

      <div className="sr-controls">
        {draft.ready ? (
          <button className="sr-btn sr-primary" onClick={confirm} disabled={busy}>
            {busy ? "Issuing…" : `Confirm & issue — ${draft.total_display}`}
          </button>
        ) : (
          <span className="sr-status">Answer the question{draft.questions.length > 1 ? "s" : ""} above to continue.</span>
        )}
        <button className="sr-btn sr-ghost" onClick={onCancel} disabled={busy}>Start over</button>
      </div>
    </div>
  );
}

function FreeInput({ kind, disabled, onSet }: { kind: string; disabled: boolean; onSet: (v: string) => void }) {
  const [v, setV] = useState("");
  const numeric = kind === "number";
  return (
    <div className="rev-opts">
      <input
        className="sr-select"
        inputMode={numeric ? "numeric" : "text"}
        value={v}
        disabled={disabled}
        placeholder={kind === "amount" ? "e.g. 12500" : kind === "number" ? "e.g. 5" : "type here"}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && v.trim()) onSet(v.trim()); }}
      />
      <button className="sr-btn sr-ghost" disabled={disabled || !v.trim()} onClick={() => onSet(v.trim())}>Set</button>
    </div>
  );
}

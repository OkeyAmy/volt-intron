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

/** Parse a response as JSON without throwing on an empty/non-JSON body (e.g. a
 *  gateway timeout page), so the user sees a clear message, not a parser error. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return { ok: false, error: `The server didn't respond (status ${res.status}). Please try again.` };
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { return { ok: false, error: `Unexpected response from the server (status ${res.status}). Please try again.` }; }
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
  const [editLine, setEditLine] = useState<number | null>(null);
  const selRef = useRef<Selections>({ lines: [] });
  const idemRef = useRef<string>(crypto.randomUUID());

  const fetchDraft = useCallback(async (selections: Selections, id: string | null) => {
    const res = await fetch("/api/invoice/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript, selections, draftId: id }),
    });
    return readJson(res);
  }, [transcript]);

  const applyDraft = useCallback((data: Record<string, unknown>) => {
    if (!data.ok || !data.draft) { setError((data.error as string) ?? "Could not build the draft."); return; }
    setDraft(data.draft as Draft); setDraftId((data.draftId as string) ?? null); setVersion((data.version as number) ?? 0);
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

  // Explicit override of a resolved line field (Change price / Change quantity).
  const override = useCallback((i: number, patch: { qty?: number; unit_price_naira?: string }) => {
    const sel = structuredClone(selRef.current);
    while (draft && sel.lines.length < draft.lines.length) sel.lines.push({});
    sel.lines[i] = { ...sel.lines[i], ...patch };
    selRef.current = sel;
    setEditLine(null);
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
      const data = await readJson(res);
      if (!data.ok) { setError((data.error as string) ?? "Could not issue the invoice."); setBusy(false); return; }
      const inv = data.invoice as { id: string; number: string };
      onIssued(inv.id, inv.number);
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
  const priceQuestion = draft.questions.some((q) => q.field === "price");
  return (
    <div className="rev">
      <h2 className="rev-h2">Check your invoice</h2>

      <div className="rev-head">
        <span className="sr-label">Customer</span>
        <strong>{draft.customer.status === "resolved" || draft.customer.status === "new" ? customerName : <em className="sr-placeholder">to confirm</em>}</strong>
      </div>

      <table className="rev-table">
        <thead>
          <tr><th>Item</th><th className="rev-num">Qty</th><th className="rev-num">Unit price</th><th className="rev-num">Total</th><th><span className="sr-visually-hidden">Actions</span></th></tr>
        </thead>
        <tbody>
          {draft.lines.map((l) => (
            <tr key={l.index}>
              <td data-label="Item">{l.product.resolved?.name ?? l.query ?? <em className="sr-placeholder">?</em>}</td>
              <td className="rev-num" data-label="Qty">{l.qty ?? "—"}</td>
              <td className="rev-num" data-label="Unit price">
                {l.unit_price_display ?? "—"}
                {l.unit_price_source === "spoken" && <span className="rev-tag" title="Price you said, overriding the catalogue">said</span>}
                {l.unit_price_source === "catalog" && <span className="rev-tag" title="From your catalogue">list</span>}
              </td>
              <td className="rev-num" data-label="Total">{l.line_total_display ?? "—"}</td>
              <td className="rev-num" data-label="">
                <button className="sr-linkbtn" onClick={() => setEditLine(editLine === l.index ? null : l.index)}
                  aria-expanded={editLine === l.index} disabled={busy}>
                  Change<span className="sr-visually-hidden"> {l.product.resolved?.name ?? l.query ?? "item"}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={3} className="rev-num"><strong>Total</strong></td><td className="rev-num"><strong>{draft.total_display ?? "—"}</strong></td><td /></tr>
        </tfoot>
      </table>

      {editLine != null && draft.lines[editLine] && (
        <LineEditor
          line={draft.lines[editLine]}
          disabled={busy}
          onApply={(patch) => override(editLine, patch)}
          onCancel={() => setEditLine(null)}
        />
      )}

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

      {draft.ready ? (
        <div className="rev-create">
          <div className="rev-createtotal"><span className="sr-label">Total</span> <strong className="sr-created-total">{draft.total_display}</strong></div>
          <p className="sr-expect">The invoice will be created with these details.</p>
          <div className="sr-controls">
            <button className="sr-btn sr-primary" onClick={confirm} disabled={busy}>{busy ? "Creating…" : "Create invoice"}</button>
            <button className="sr-btn sr-ghost" onClick={onCancel} disabled={busy}>Start over</button>
          </div>
        </div>
      ) : (
        <div className="sr-controls">
          <span className="sr-status">
            {priceQuestion ? "Check the price to see the total." : `Answer the question${draft.questions.length > 1 ? "s" : ""} above to continue.`}
          </span>
          <button className="sr-btn sr-ghost" onClick={onCancel} disabled={busy}>Start over</button>
        </div>
      )}
    </div>
  );
}

function LineEditor({ line, disabled, onApply, onCancel }: {
  line: { qty: number | null; unit_price_kobo: number | null };
  disabled: boolean;
  onApply: (patch: { qty?: number; unit_price_naira?: string }) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState(line.qty != null ? String(line.qty) : "");
  const [price, setPrice] = useState(line.unit_price_kobo != null ? String(line.unit_price_kobo / 100) : "");
  const apply = () => {
    const patch: { qty?: number; unit_price_naira?: string } = {};
    if (qty.trim() && Number(qty) > 0) patch.qty = Math.floor(Number(qty));
    if (price.trim()) patch.unit_price_naira = price.trim();
    if (Object.keys(patch).length) onApply(patch);
    else onCancel();
  };
  return (
    <fieldset className="rev-q">
      <legend>Change this item</legend>
      <div className="rev-editrow">
        <label className="sr-label" htmlFor="edit-qty">Quantity</label>
        <input id="edit-qty" className="sr-select" inputMode="numeric" value={qty} disabled={disabled}
          placeholder="e.g. 5" onChange={(e) => setQty(e.target.value)} />
      </div>
      <div className="rev-editrow">
        <label className="sr-label" htmlFor="edit-price">Price per unit (₦)</label>
        <input id="edit-price" className="sr-select" inputMode="decimal" value={price} disabled={disabled}
          placeholder="e.g. 12500" onChange={(e) => setPrice(e.target.value)} />
      </div>
      <div className="rev-opts">
        <button className="sr-btn sr-primary rev-opt" onClick={apply} disabled={disabled}>Apply</button>
        <button className="sr-btn sr-ghost rev-opt" onClick={onCancel} disabled={disabled}>Cancel</button>
      </div>
    </fieldset>
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

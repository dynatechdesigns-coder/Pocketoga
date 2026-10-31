import { useState } from "react";
import { Check } from "lucide-react";
import { OFFLINE_MESSAGE, newMeta } from "./offlineQueue.js";
import { MANUAL_TYPES, NOTE_MAX, cleanAmountInput, emptyManual, owesKobo, paidText, showAmountInput, validateManual } from "./manualEntry.js";
import { formatKobo } from "./format.js";
import { getShopQueue } from "./shopQueue.js";
import { Button, Field, Sheet, cx, inputClass } from "./ui.jsx";

// "No signal? Enter it by hand": a short form whose result is kept in the
// offline queue and sent when the phone is back online. It becomes a normal
// proposal to Save, Fix or Reject; nothing here is final. The Record screen
// offers it only while offline, but a form that is already open stays open
// when the signal returns.
export default function ManualEntry({ open, onClose, shopId, onSaved }) {
  const [values, setValues] = useState(emptyManual);
  const [error, setError] = useState(null); // { text, field }
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const setAmount = (key) => (e) =>
    setValues((v) => ({ ...v, [key]: cleanAmountInput(e.target.value), ...(key === "paid" ? { paidTouched: true } : {}) }));
  const sale = values.kind === "sale";
  const owes = owesKobo(values);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const out = validateManual(values);
    if (out.error) {
      setError({ text: out.error, field: out.field });
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const queue = await getShopQueue(shopId).catch(() => null);
      if (!queue) {
        setError({ text: OFFLINE_MESSAGE });
        return;
      }
      const meta = newMeta();
      await queue.enqueue("manual", { entry: out.entry }, { requestId: meta.requestId, spokenAt: meta.spokenAt });
      setValues(emptyManual());
      onSaved();
    } catch {
      setError({ text: "Could not save it on your phone. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const invalid = (key) => (error?.field === key ? "true" : undefined);

  return (
    <Sheet open={open} onClose={onClose} title="Enter it by hand">
      <form data-part="manual-form" onSubmit={submit} noValidate className="grid min-w-0 gap-4">
        <div role="group" aria-label="What are you entering?" className="grid gap-2">
          {MANUAL_TYPES.map((t) => (
            <button
              key={t.kind}
              type="button"
              data-part="manual-type"
              aria-pressed={values.kind === t.kind}
              onClick={() => setValues((v) => ({ ...v, kind: t.kind }))}
              className={cx(
                "min-h-14 rounded-full border-[1.5px] px-4 text-[1.0625rem] font-bold transition-transform active:scale-96",
                values.kind === t.kind ? "border-transparent bg-primary text-white" : "border-line bg-card text-link"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <Field
          id="mf-customer"
          label={values.kind === "payment" ? "Who paid you? (optional)" : values.kind === "expense" ? "Paid to (optional)" : "Customer (optional)"}
          hint={values.kind === "expense" ? undefined : "Leave it empty and it is named Customer 1, Customer 2 and so on. You can rename it later."}
        >
          <input id="mf-customer" value={values.customer} onChange={set("customer")} autoComplete="off" aria-invalid={invalid("customer")} className={inputClass} />
        </Field>

        {values.kind !== "payment" && (
          <Field id="mf-item" label={values.kind === "expense" ? "What was it for? (optional)" : "Item (optional)"}>
            <input id="mf-item" value={values.item} onChange={set("item")} autoComplete="off" className={inputClass} />
          </Field>
        )}

        {sale && (
          <Field id="mf-quantity" label="Quantity (optional)">
            <input id="mf-quantity" value={values.quantity} onChange={set("quantity")} inputMode="numeric" autoComplete="off" aria-invalid={invalid("quantity")} className={inputClass} />
          </Field>
        )}

        <Field id="mf-amount" label={values.kind === "payment" ? "Amount received" : "Amount"} hint="In naira.">
          <input
            id="mf-amount"
            value={showAmountInput(values.amount)}
            onChange={setAmount("amount")}
            inputMode="decimal"
            placeholder="₦0"
            autoComplete="off"
            aria-invalid={invalid("amount")}
            aria-describedby="mf-amount-hint"
            className={cx(inputClass, "tabular-nums")}
          />
        </Field>

        {sale && (
          <div className="grid gap-2">
            <Field id="mf-paid" label="Paid now" hint="Starts as the full amount. Change it if the customer paid less.">
              <input
                id="mf-paid"
                value={showAmountInput(paidText(values))}
                onChange={setAmount("paid")}
                inputMode="decimal"
                placeholder="₦0"
                autoComplete="off"
                aria-invalid={invalid("paid")}
                aria-describedby="mf-paid-hint"
                className={cx(inputClass, "tabular-nums")}
              />
            </Field>
            <p data-part="owes" aria-live="polite" className={cx("min-h-6 font-extrabold tabular-nums", owes > 0 ? "text-amber-ink" : "text-muted")}>
              {owes === null ? "" : owes > 0 ? `Owes ${formatKobo(owes)}` : "Paid in full"}
            </p>
          </div>
        )}

        <Field id="mf-note" label="Note (optional)" hint={`${values.note.length} of ${NOTE_MAX} characters`}>
          <textarea
            id="mf-note"
            rows={2}
            maxLength={NOTE_MAX}
            value={values.note}
            onChange={set("note")}
            aria-describedby="mf-note-hint"
            aria-invalid={invalid("note")}
            className={inputClass}
          />
        </Field>

        {error && (
          <p role="alert" data-part="manual-error" className="rounded-2xl bg-slate px-4 py-3 font-semibold [overflow-wrap:anywhere]">
            {error.text}
          </p>
        )}

        <Button type="submit" size="lg" disabled={busy}>
          <Check aria-hidden="true" strokeWidth={2.6} /> {busy ? "Saving…" : "Save on my phone"}
        </Button>
        <p className="text-center text-sm text-muted">It is sent when you are back online. You still check it and tap Save before it counts.</p>
      </form>
    </Sheet>
  );
}

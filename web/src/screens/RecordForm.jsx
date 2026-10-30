import { useState } from "react";
import { Check } from "lucide-react";
import { ApiError, friendlyError, proposeForm } from "../api.js";
import { FIELD_LABELS, FIELD_NOTES, FORM_FIELDS, RECORD_TYPES, emptyForm, submitRecordForm } from "../recordForm.js";
import { Button, Field, Sheet, cx, inputClass } from "../ui.jsx";

// "Type it instead": a short form for one record, shown in a sheet. It sends
// the fields to the form route and hands the proposal back to be checked on
// the confirm card. Nothing is saved here.
export default function RecordForm({ open, onClose, startType, onProposal }) {
  const [type, setType] = useState(startType);
  const [values, setValues] = useState(emptyForm);
  const [error, setError] = useState(null); // { text, field }
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const notes = FIELD_NOTES[type];
  const amountIsEach = values.amountMode === "each" && (type === "sale" || type === "purchase");

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const out = await submitRecordForm(type, values, proposeForm);
      if (out.error) setError({ text: out.error, field: out.field });
      else {
        onProposal(out.proposal);
        setValues(emptyForm());
      }
    } catch (err) {
      setError({ text: err instanceof ApiError ? friendlyError(err) : "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const input = (key, props = {}) => (
    <input
      id={`rf-${key}`}
      value={values[key]}
      onChange={set(key)}
      disabled={busy}
      autoComplete="off"
      aria-invalid={error?.field === key ? "true" : undefined}
      className={inputClass}
      {...props}
    />
  );

  return (
    <Sheet open={open} onClose={onClose} title="Type it instead">
      <form data-part="record-form" onSubmit={submit} noValidate className="grid gap-4">
        <div role="group" aria-label="What are you recording?" className="grid grid-cols-4 gap-1.5">
          {RECORD_TYPES.map((t) => (
            <button
              key={t.type}
              type="button"
              data-part="form-type"
              aria-pressed={type === t.type}
              onClick={() => setType(t.type)}
              className={cx(
                "min-h-12 rounded-full border-[1.5px] px-1 text-[0.9375rem] font-bold transition-transform active:scale-96",
                type === t.type ? "border-transparent bg-primary text-white" : "border-line bg-card text-link",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {FORM_FIELDS[type].map((key) => {
          if (key === "amount") {
            const canEach = type === "sale" || type === "purchase";
            return (
              <div key={key} className="grid gap-3">
                <Field id="rf-amount" label={notes.labels.amount ?? (amountIsEach ? "Price of one" : "Amount")} hint="In naira, like 15000.">
                  {input("amount", { inputMode: "numeric", placeholder: "15000", "aria-describedby": "rf-amount-hint" })}
                </Field>
                {canEach && (
                  <div role="group" aria-label="What the amount is for" className="grid grid-cols-2 gap-1.5">
                    {[
                      ["total", "For everything"],
                      ["each", "For each one"],
                    ].map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        data-part="amount-mode"
                        aria-pressed={values.amountMode === mode}
                        onClick={() => setValues((v) => ({ ...v, amountMode: mode }))}
                        className={cx(
                          "min-h-12 rounded-full border-[1.5px] px-2 text-[0.9375rem] font-bold",
                          values.amountMode === mode ? "border-accent bg-lavender text-link" : "border-line bg-card text-muted",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          const numeric = key === "quantity" ? { inputMode: "numeric" } : key === "amountPaid" ? { inputMode: "numeric", placeholder: "0" } : {};
          return (
            <Field key={key} id={`rf-${key}`} label={notes.labels[key] ?? FIELD_LABELS[key]}>
              {input(key, numeric)}
            </Field>
          );
        })}

        {error && (
          <p role="alert" className="rounded-2xl bg-slate px-4 py-3 font-semibold">
            {error.text}
          </p>
        )}

        <Button type="submit" size="lg" disabled={busy}>
          <Check aria-hidden="true" strokeWidth={2.6} /> {busy ? "Checking…" : "Check it"}
        </Button>
        <p className="text-center text-sm text-muted">Nothing is saved until you tap Save on the next card.</p>
      </form>
    </Sheet>
  );
}

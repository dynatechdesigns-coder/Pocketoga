import { useState } from "react";
import { ChevronRight, Phone, UserPlus, Users } from "lucide-react";
import { friendlyError, getCustomers, saveCustomer } from "../api.js";
import { formatKobo, phoneText, sameCustomer } from "../format.js";
import { waNumber } from "../reminders.js";
import { Avatar, Button, Card, EmptyState, ErrorState, Field, ScreenHeader, Sheet, Skeleton, rise, useLoad } from "../ui.jsx";
import { inputClass } from "./ConfirmCard.jsx";

// GET /customers: who they are, what they owe (amber) and their phone. The
// add/edit sheet stores a number only with the trader's explicit consent;
// Debts uses it to open WhatsApp straight to that customer.
export default function CustomersScreen() {
  const { data, error, loading, reload } = useLoad(getCustomers);
  const [edits, setEdits] = useState([]); // customers saved this visit
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // customer, or {} for new

  const list = data && [...data.map((c) => edits.find((e) => sameCustomer(e.name, c.name)) ?? c), ...edits.filter((e) => !data.some((c) => sameCustomer(c.name, e.name)))];

  function openSheet(c) {
    setEditing(c);
    setOpen(true);
  }

  let body;
  if (loading && !data) body = <Skeleton blocks={[76, 76, 76, 76]} label="Loading customers" />;
  else if (error) body = <ErrorState message={error} onRetry={reload} />;
  else if (list.length === 0)
    body = (
      <EmptyState icon={Users} title="No customers yet" action="Add a customer" onAction={() => openSheet({})}>
        Customers appear here when you record sales to them.
      </EmptyState>
    );
  else
    body = (
      <Card as="ul" aria-label="Customers" {...rise(0, "divide-y divide-line px-0 py-1.5")}>
        {list.map((c) => (
          <li key={c.id ?? c.name}>
            <button
              data-part="customer-row"
              onClick={() => openSheet(c)}
              aria-label={`${c.name}, ${c.owedKobo > 0 ? `owes ${formatKobo(c.owedKobo)}` : "owes nothing"}, ${c.phone ? `phone ${phoneText(c.phone)}` : "no phone number"}. Edit`}
              className="flex min-h-[76px] w-full items-center gap-3 rounded-card px-[18px] py-3 text-left transition duration-150 hover:bg-page active:scale-[0.98]"
            >
              <Avatar name={c.name} />
              <span className="grid min-w-0 flex-1">
                <span className="truncate font-bold">{c.name}</span>
                <span className="inline-flex items-center gap-1 text-sm whitespace-nowrap text-muted [&_svg]:size-3.5 [&_svg]:shrink-0">
                  <Phone aria-hidden="true" /> {c.phone ? phoneText(c.phone) : "No number"}
                </span>
              </span>
              <span className="grid justify-items-end">
                {c.owedKobo > 0 ? (
                  <>
                    <span className="text-[0.75rem] font-semibold text-muted">Owes</span>
                    <span className="font-extrabold whitespace-nowrap text-amber-ink tabular-nums">{formatKobo(c.owedKobo)}</span>
                  </>
                ) : (
                  <span className="text-sm whitespace-nowrap text-muted">Paid up</span>
                )}
              </span>
              <ChevronRight aria-hidden="true" className="-mr-1.5 size-[18px] shrink-0 text-grey" />
            </button>
          </li>
        ))}
      </Card>
    );

  return (
    <section>
      <ScreenHeader title="Customers" />
      <div className="mb-4">
        <Button data-part="add-customer" variant="secondary" onClick={() => openSheet({})}>
          <UserPlus aria-hidden="true" /> Add customer
        </Button>
      </div>
      {body}
      <Sheet open={open} onClose={() => setOpen(false)} title={editing?.name ? `Edit ${editing.name}` : "Add customer"}>
        {editing && (
          <CustomerForm
            key={editing.id ?? "new"}
            customer={editing}
            onSaved={(c) => {
              setEdits((all) => [...all.filter((e) => !sameCustomer(e.name, c.name)), { ...c, owedKobo: editing.owedKobo ?? c.owedKobo ?? 0 }]);
              setOpen(false);
            }}
          />
        )}
      </Sheet>
    </section>
  );
}

function CustomerForm({ customer, onSaved }) {
  const isNew = !customer.name;
  const [name, setName] = useState(customer.name ?? "");
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const phoneOk = waNumber(phone) !== null;
  const ready = name.trim() && phoneOk && consent && !busy;

  async function save(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveCustomer({ name: name.trim(), phone: phone.trim() }));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={save} data-part="customer-form">
      <Field id="customer-name" label="Name">
        <input
          id="customer-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={!isNew}
          autoComplete="off"
          placeholder="e.g. Mama Bisi"
          className={`${inputClass} read-only:bg-slate`}
        />
      </Field>
      <Field id="customer-phone" label="Phone number" hint="Nigerian numbers like 0803 000 0000, or +country code.">
        <input
          id="customer-phone"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="0803 000 0000"
          className={inputClass}
          aria-describedby="customer-phone-hint"
          aria-invalid={phone.trim() !== "" && !phoneOk}
        />
      </Field>
      {phone.trim() !== "" && !phoneOk && (
        <p role="alert" className="-mt-2 font-semibold text-coral-ink">
          That does not look like a phone number.
        </p>
      )}

      {/* Consent: the whole row is the target; nothing is ticked for them. */}
      <label data-part="consent" className="flex min-h-14 cursor-pointer items-start gap-3 rounded-2xl border-[1.5px] border-line bg-card px-4 py-3">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-6 shrink-0 accent-primary" />
        <span>
          <strong>I have this customer’s permission to store their number</strong>
          <span className="block text-sm text-muted">It is only used to open WhatsApp to them from Debts. PocketOga never sends messages itself.</span>
        </span>
      </label>

      {error && (
        <p role="alert" className="rounded-2xl bg-slate px-4 py-3">
          {error}
        </p>
      )}
      <Button size="lg" disabled={!ready} aria-describedby={consent ? undefined : "consent-why"}>
        {busy ? "Saving…" : "Save customer"}
      </Button>
      {!consent && (
        <p id="consent-why" className="-mt-2 text-center text-sm text-muted">
          Tick the permission box to save a number.
        </p>
      )}
    </form>
  );
}

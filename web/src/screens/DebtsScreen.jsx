import { useEffect, useState } from "react";
import { getDebts, getPromises } from "../api.js";
import { ageText, formatDueDay, formatKobo, sameCustomer } from "../format.js";
import { draftReminder, TONES, whatsappLink } from "../reminders.js";
import { EmptyState, ErrorState, ScreenHeader, Skeleton, useLoad } from "../ui.jsx";

// Both reads in one go: the ranked chase list and every promise.
async function loadDebts() {
  const [{ debts, chase }, promises] = await Promise.all([getDebts(), getPromises()]);
  return { debts, chase, promises };
}

// Ranked list of who owes, in the server's chase order. Tapping a row opens
// the customer's detail with reminder drafts.
export default function DebtsScreen({ onGo }) {
  const { data, error, loading, reload } = useLoad(loadDebts);
  const [open, setOpen] = useState(null); // customer name

  // The phone's back button closes the detail view.
  useEffect(() => {
    const onPop = () => setOpen(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function openCustomer(name) {
    history.pushState({ customer: name }, "");
    setOpen(name);
    window.scrollTo(0, 0);
  }

  if (loading && !data) {
    return (
      <section>
        <ScreenHeader title="Who owes you" />
        <Skeleton cards={4} height={88} label="Loading debts" />
      </section>
    );
  }
  if (error) {
    return (
      <section>
        <ScreenHeader title="Who owes you" />
        <ErrorState message={error} onRetry={reload} />
      </section>
    );
  }

  const row = open && data.chase.find((c) => sameCustomer(c.customer, open));
  if (row) {
    return (
      <CustomerDetail
        row={row}
        debt={data.debts.find((d) => sameCustomer(d.customer, open))}
        promises={data.promises.filter((p) => sameCustomer(p.customer, open))}
        onBack={() => history.back()}
      />
    );
  }

  return (
    <section>
      <ScreenHeader title="Who owes you" sub="Chase the top of the list first." />
      {data.chase.length === 0 ? (
        <EmptyState title="Nobody owes you" action="Record a sale" onAction={() => onGo("record")}>
          When a customer buys on credit, they will show here.
        </EmptyState>
      ) : (
        <ol className="list" aria-label="Customers who owe, most urgent first">
          {data.chase.map((c) => (
            <li key={c.customer}>
              <button
                className="card debt-row"
                onClick={() => openCustomer(c.customer)}
                aria-label={`${c.customer} owes ${formatKobo(c.owedKobo)}, oldest unpaid ${ageText(c.ageDays)}. Open details`}
              >
                <span className="debt-main">
                  <span className="debt-name">{c.customer}</span>
                  <span className="debt-meta">
                    Unpaid for {ageText(c.ageDays)}
                    <PromiseBadge promises={data.promises.filter((p) => sameCustomer(p.customer, c.customer))} />
                  </span>
                </span>
                <span className="debt-amount">{formatKobo(c.owedKobo)}</span>
                <svg className="chevron" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// Next open promise date, else "Broken" if any promise was missed.
function PromiseBadge({ promises }) {
  const next = promises.filter((p) => p.status === "open").sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  if (next) return <span className="badge badge-promise">📅 {formatDueDay(next.due_date)}</span>;
  if (promises.some((p) => p.status === "broken")) return <span className="badge badge-broken">Broken</span>;
  return null;
}

const STATUS_TEXT = { open: "Due", kept: "Kept", broken: "Broken", cancelled: "Cancelled" };

function CustomerDetail({ row, debt, promises, onBack }) {
  const kept = promises.filter((p) => p.status === "kept").length;
  const resolved = kept + promises.filter((p) => p.status === "broken").length;
  const past = [...promises].sort((a, b) => (a.due_date < b.due_date ? 1 : -1));

  return (
    <section>
      <button className="btn-text back" onClick={onBack}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m15 6-6 6 6 6" />
        </svg>
        All debts
      </button>

      <article className="card hero-card">
        <h1 className="card-label">{row.customer} owes you</h1>
        <p className="figure figure-xl">{formatKobo(row.owedKobo)}</p>
        <dl className="facts">
          <div>
            <dt>Oldest unpaid</dt>
            <dd>{ageText(row.ageDays)}</dd>
          </div>
          <div>
            <dt>Promises kept</dt>
            <dd>{resolved > 0 ? `${kept} of ${resolved}` : "None yet"}</dd>
          </div>
          {debt && (
            <>
              <div>
                <dt>Bought</dt>
                <dd>{formatKobo(debt.salesKobo)}</dd>
              </div>
              <div>
                <dt>Paid</dt>
                <dd>{formatKobo(debt.paidKobo)}</dd>
              </div>
            </>
          )}
        </dl>
      </article>

      <h2 className="section-title">Promises</h2>
      {past.length === 0 ? (
        <p className="muted">No promises recorded. Say “{row.customer} will pay on Friday” to add one.</p>
      ) : (
        <ul className="card list-plain">
          {past.map((p) => (
            <li key={p.id} className="promise-row">
              <span>
                <span className="promise-amount">{Number.isInteger(p.amount_kobo) ? formatKobo(p.amount_kobo) : "Any amount"}</span>
                <span className="muted small"> by {formatDueDay(p.due_date)}</span>
                {p.status === "broken" && p.paid_kobo > 0 && (
                  <span className="muted small block">Paid {formatKobo(p.paid_kobo)} by then</span>
                )}
              </span>
              <span className={`badge badge-${p.status === "broken" ? "broken" : p.status === "kept" ? "kept" : "promise"}`}>
                {STATUS_TEXT[p.status] ?? p.status}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="section-title">Send a reminder</h2>
      <p className="muted small">Pick a tone. You send it yourself from WhatsApp — PocketOga never sends anything.</p>
      <div className="stack">
        {TONES.map((t) => (
          <Reminder key={t.key} label={t.label} text={draftReminder(t.key, row)} />
        ))}
      </div>
    </section>
  );
}

function Reminder({ label, text }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older or non-https browsers: select the text so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(`draft-${label}`));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <article className="card reminder">
      <h3 className="card-label">{label}</h3>
      <p className="reminder-text" id={`draft-${label}`}>
        {text}
      </p>
      <div className="row">
        <button className="btn btn-secondary btn-sm" onClick={copy} aria-label={`Copy ${label.toLowerCase()} reminder`}>
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
        <a
          className="btn btn-primary btn-sm"
          href={whatsappLink(text)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${label.toLowerCase()} reminder in WhatsApp`}
        >
          Open in WhatsApp
        </a>
      </div>
    </article>
  );
}


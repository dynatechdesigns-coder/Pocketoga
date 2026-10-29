import { useEffect, useRef, useState } from "react";
import { CalendarX2, Check, ChevronRight, Copy, MessageCircle, Search, Users } from "lucide-react";
import { getCustomers, getDebts, getPromises } from "../api.js";
import { ageText, dueText, formatDueDay, formatKobo, phoneText, sameCustomer } from "../format.js";
import { draftReminder, TONES, whatsappLink } from "../reminders.js";
import { Avatar, Button, Card, EmptyState, ErrorState, Pill, ScreenHeader, SectionTitle, Sheet, Skeleton, cx, figure, rise, useLoad } from "../ui.jsx";

// All reads in one go: the ranked chase list, every promise, and customers
// (for phone numbers stored with consent; optional, so Debts still works
// without them and WhatsApp then asks who to send to).
async function loadDebts() {
  const [{ debts, chase }, promises, customers] = await Promise.all([getDebts(), getPromises(), getCustomers().catch(() => [])]);
  return { debts, chase, promises, customers };
}

// The pill a customer row shows: the next open promise, else Broken if a
// promise was missed, else Kept if one was kept.
function status(promises) {
  const open = promises.filter((p) => p.status === "open").sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  if (open) return { tone: "amber", text: dueText(open.due_date) };
  if (promises.some((p) => p.status === "broken")) return { tone: "coral", text: "Broken" };
  if (promises.some((p) => p.status === "kept")) return { tone: "teal", text: "Kept" };
  return null;
}

// Who owes, in the server's chase order, with search. Tapping a row opens
// a bottom sheet with the balance, promises and reminder drafts. Intent
// "chase" opens the most urgent customer; "broken" lists only customers
// with a broken promise.
export default function DebtsScreen({ intent, onGo }) {
  const { data, error, loading, reload } = useLoad(loadDebts);
  const [query, setQuery] = useState("");
  const [brokenOnly, setBrokenOnly] = useState(intent === "broken");
  const [open, setOpen] = useState(null); // customer name

  // The phone's back button closes the sheet.
  useEffect(() => {
    const onPop = () => setOpen(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function openCustomer(name) {
    history.pushState({ sheet: name }, "");
    setOpen(name);
  }

  // "Chase" from Money opens the most urgent customer straight away.
  const chased = useRef(false);
  useEffect(() => {
    if (intent === "chase" && data?.chase.length && !chased.current) {
      chased.current = true;
      openCustomer(data.chase[0].customer);
    }
  }, [intent, data]);

  const closeSheet = () => (history.state?.sheet ? history.back() : setOpen(null));
  const promisesOf = (name) => data.promises.filter((p) => sameCustomer(p.customer, name));

  let body;
  if (loading && !data) {
    body = <Skeleton blocks={[52, 76, 76, 76, 76]} label="Loading debts" />;
  } else if (error) {
    body = <ErrorState message={error} onRetry={reload} />;
  } else if (data.chase.length === 0) {
    body = (
      <EmptyState icon={Users} title="Nobody owes you" action="Record a sale" onAction={() => onGo("record")}>
        When a customer buys on credit, they show here, most urgent first.
      </EmptyState>
    );
  } else {
    const q = query.trim().toLowerCase();
    const rows = data.chase.filter(
      (c) => c.customer.toLowerCase().includes(q) && (!brokenOnly || promisesOf(c.customer).some((p) => p.status === "broken"))
    );
    body = (
      <div className="grid gap-4">
        {brokenOnly && (
          <div data-part="filter" className="flex items-center justify-between gap-3 rounded-2xl border-[1.5px] border-coral bg-coral-soft py-1.5 pr-1.5 pl-4 text-coral-ink">
            <span className="flex items-center gap-2 font-bold [&_svg]:size-5">
              <CalendarX2 aria-hidden="true" /> Broken promises only
            </span>
            <Button variant="quiet" size="sm" className="w-auto" onClick={() => setBrokenOnly(false)}>
              Show all
            </Button>
          </div>
        )}
        <div data-part="search" {...rise(0, "relative")}>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-[18px] size-5 -translate-y-1/2 text-grey" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customers"
            aria-label="Search customers"
            className="min-h-[52px] w-full rounded-full border-[1.5px] border-line bg-card pr-4 pl-12 text-base shadow-soft transition placeholder:text-muted focus:border-accent focus:ring-4 focus:ring-blue-soft focus:outline-none"
          />
        </div>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-muted">{q ? `No customer matches “${query}”.` : "Nobody has a broken promise now."}</p>
        ) : (
          <Card as="ul" aria-label="Customers who owe, most urgent first" {...rise(1, "divide-y divide-line px-0 py-1.5")}>
            {rows.map((c) => {
              const s = status(promisesOf(c.customer));
              return (
                <li key={c.customer}>
                  <button
                    data-part="debt-row"
                    onClick={() => openCustomer(c.customer)}
                    aria-label={`${c.customer}, owes ${formatKobo(c.owedKobo)}, unpaid ${ageText(c.ageDays)}${s ? `, ${s.text}` : ""}. Open details`}
                    className="flex min-h-[76px] w-full items-center gap-3 rounded-card px-[18px] py-3 text-left transition duration-150 hover:bg-page active:scale-[0.98]"
                  >
                    <Avatar name={c.customer} />
                    <span className="grid min-w-0 flex-1">
                      <span data-part="debt-name" className="truncate font-bold">
                        {c.customer}
                      </span>
                      <span className="text-sm text-muted">{c.ageDays > 0 ? `${ageText(c.ageDays)} unpaid` : "Since today"}</span>
                    </span>
                    <span className="grid justify-items-end gap-1">
                      <span className="text-lg font-extrabold whitespace-nowrap tabular-nums">{formatKobo(c.owedKobo)}</span>
                      {s && <Pill tone={s.tone}>{s.text}</Pill>}
                    </span>
                    <ChevronRight aria-hidden="true" className="-mr-1.5 size-[18px] text-grey" />
                  </button>
                </li>
              );
            })}
          </Card>
        )}
      </div>
    );
  }

  const row = open && data?.chase.find((c) => sameCustomer(c.customer, open));
  // Keep showing the last customer while the sheet slides away.
  const shown = useRef(null);
  if (row) shown.current = row;
  const r = shown.current;

  return (
    <section>
      <ScreenHeader title="Who owes you" />
      {body}
      <Sheet open={!!row} onClose={closeSheet} title={r ? r.customer : ""}>
        {r && (
          <CustomerDetail
            row={r}
            debt={data.debts.find((d) => sameCustomer(d.customer, r.customer))}
            promises={promisesOf(r.customer)}
            phone={data.customers.find((c) => sameCustomer(c.name, r.customer))?.phone ?? null}
          />
        )}
      </Sheet>
    </section>
  );
}

const STATUS = { open: ["amber", "Due"], kept: ["teal", "Kept"], broken: ["coral", "Broken"], cancelled: ["slate", "Cancelled"] };

function Stat({ label, children }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-3.5 py-3 shadow-soft">
      <dt className="text-[0.8125rem] font-semibold text-muted">{label}</dt>
      <dd className="font-extrabold tabular-nums [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function CustomerDetail({ row, debt, promises, phone }) {
  const resolved = promises.filter((p) => p.status === "kept" || p.status === "broken");
  const kept = resolved.filter((p) => p.status === "kept").length;
  const past = [...promises].sort((a, b) => (a.due_date < b.due_date ? 1 : -1));

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-4">
        <Avatar name={row.customer} size="lg" />
        <div>
          <p className="text-sm font-semibold text-muted">Owes you</p>
          <p className={cx(figure, "text-[2.5rem]")}>{formatKobo(row.owedKobo)}</p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2">
        <Stat label="Oldest unpaid">{row.ageDays > 0 ? ageText(row.ageDays) : "Today"}</Stat>
        <Stat label="Promises kept">
          {resolved.length > 0 ? `${kept} of ${resolved.length}` : "None yet"}
          {resolved.length > 0 && (
            <span data-part="dots" className="ml-2 inline-flex gap-1 align-middle" aria-hidden="true">
              {resolved.map((p) => (
                <i key={p.id} className={cx("size-2 rounded-full", p.status === "kept" ? "bg-teal" : "bg-coral")} />
              ))}
            </span>
          )}
        </Stat>
        {debt && (
          <>
            <Stat label="Bought">{formatKobo(debt.salesKobo)}</Stat>
            <Stat label="Paid">{formatKobo(debt.paidKobo)}</Stat>
          </>
        )}
      </dl>

      <SectionTitle as="h3">Promises</SectionTitle>
      {past.length === 0 ? (
        <p className="text-muted">No promises yet. Say “{row.customer} go pay Friday” when recording to add one.</p>
      ) : (
        <Card as="ul" className="divide-y divide-line px-0 py-1.5">
          {past.map((p) => {
            const [tone, text] = STATUS[p.status] ?? ["slate", p.status];
            return (
              <li key={p.id} className="flex min-h-16 items-center justify-between gap-4 px-[18px] py-2.5">
                <span>
                  <span className="font-bold tabular-nums">{Number.isInteger(p.amount_kobo) ? formatKobo(p.amount_kobo) : "Any amount"}</span>
                  <span className="block text-sm text-muted">
                    by {formatDueDay(p.due_date)}
                    {p.status === "broken" && p.paid_kobo > 0 && ` · ${formatKobo(p.paid_kobo)} paid by then`}
                  </span>
                </span>
                <Pill tone={tone}>{text}</Pill>
              </li>
            );
          })}
        </Card>
      )}

      <SectionTitle as="h3">Send a reminder</SectionTitle>
      <p data-part="send-to" className="text-sm text-muted">
        Pick a tone. You send it from your own WhatsApp; PocketOga never sends anything.{" "}
        {phone ? `WhatsApp opens to ${phoneText(phone)}.` : "No number saved, so WhatsApp will ask who to send it to."}
      </p>
      {TONES.map((t) => (
        <Reminder key={t.key} label={t.label} text={draftReminder(t.key, row)} phone={phone} />
      ))}
    </div>
  );
}

function Reminder({ label, text, phone }) {
  const [copied, setCopied] = useState(false);
  const id = `draft-${label}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard access (older browser, plain http): select the text instead.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(id));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card as="article" className="grid gap-2.5">
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p id={id} className="rounded-[18px_18px_18px_6px] bg-lavender px-3.5 py-3 text-ink">
        {text}
      </p>
      <div className="flex gap-2 *:flex-1">
        <Button variant="quiet" size="sm" onClick={copy} aria-label={`Copy ${label.toLowerCase()} reminder`}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </Button>
        <Button
          as="a"
          size="sm"
          href={whatsappLink(text, phone)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${label.toLowerCase()} reminder in WhatsApp`}
        >
          <MessageCircle aria-hidden="true" /> Open in WhatsApp
        </Button>
      </div>
    </Card>
  );
}

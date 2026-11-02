import { useState } from "react";
import { ArrowDownLeft, Check, Filter, PackagePlus, Pencil, RotateCcw, ScrollText, ShieldAlert, ShieldCheck, ShoppingBag } from "lucide-react";
import { getLedger, proposeEntryCorrection } from "../api.js";
import { connection, isOffline } from "../connection.js";
import { CORRECTION_KIND, QUEUED_EDIT_MESSAGE, canEdit, correctionError, currentEntries, editChanges, editStart, wasKobo, wasNowLine } from "../entryCorrection.js";
import { dayLabel, formatKobo, itemText, lagosToday, plural, timeLabel, typeLabel } from "../format.js";
import { supersededById } from "../ledger.js";
import { newMeta } from "../offlineQueue.js";
import { getShopQueue } from "../shopQueue.js";
import { Button, Card, EmptyState, ErrorState, Field, IconCircle, Pill, ScreenHeader, Sheet, Skeleton, cx, rise, useLoad } from "../ui.jsx";
import ConfirmCard, { inputClass } from "./ConfirmCard.jsx";

// Icon and tint for each entry type.
const KIND = {
  sale: [ShoppingBag, "lavender"],
  payment: [ArrowDownLeft, "blue"],
  restock: [PackagePlus, "slate"],
  correction: [RotateCcw, "slate"],
};

// Item names are matched the way the money check groups them (leak.mjs):
// trimmed and lowercased, item and unit together.
const norm = (v) => String(v ?? "").trim().toLowerCase();
const isSaleOf = (e, f) => e.type === "sale" && norm(e.item) === f.item && (norm(e.unit) || null) === (f.unit ?? null);

// Saved entries grouped by day, newest first, under the hash-chain check
// from GET /ledger. `intent.item` (from "Margin lost") shows only the sales
// of that item until "Show all". "Fix this entry" shows only on the latest
// uncorrected entry; it proposes a correction (POST /correct-last) and the
// trader confirms it on Record's card. Saved entries are never edited.
export default function LedgerScreen({ shop, intent, onGo }) {
  const { data, error, loading, reload } = useLoad(getLedger);
  const [only, setOnly] = useState(intent?.item ? intent : null);
  const [fix, setFix] = useState(null); // { entry, proposal } — the fix being written
  const [shown, setShown] = useState(null); // kept while the sheet slides away
  const [added, setAdded] = useState(null); // the correction just added
  const [queued, setQueued] = useState(false); // an edit kept on the phone until it can be sent

  function openFix(e) {
    const next = { entry: e, proposal: null };
    setShown(next);
    setFix(next);
  }

  function onQueued() {
    setFix(null);
    setQueued(true);
  }

  function onProposed(proposal) {
    const next = { entry: fix.entry, proposal };
    setShown(next);
    setFix(next);
  }

  // The card saved (or refused) the proposal. On save, find the new
  // correction in a fresh ledger for the banner, then reload the list.
  // Money, Debts and Reports reload themselves when opened: screens
  // remount on every tab switch, and useLoad fetches on mount.
  async function onFixed() {
    const target = fix?.entry ?? shown?.entry;
    setFix(null);
    setQueued(false);
    try {
      const fresh = await getLedger();
      setAdded(fresh.entries.find((e) => e.corrects_id === target?.id) ?? null);
    } catch {
      setAdded(null);
    }
    reload();
  }

  return (
    <section>
      <ScreenHeader title="Ledger" />
      {loading && !data ? (
        <Skeleton blocks={[44, 220, 220]} label="Loading ledger" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <LedgerBody
          entries={currentEntries(only ? data.entries.filter((e) => isSaleOf(e, only)) : data.entries)}
          all={data.entries}
          verify={data.verify}
          only={only}
          onShowAll={() => setOnly(null)}
          added={added}
          queued={queued}
          onFix={openFix}
          shop={shop}
          onGo={onGo}
        />
      )}
      <Sheet open={!!fix} onClose={() => setFix(null)} title={fix?.proposal ? "Check before you save" : "Edit this entry"}>
        {shown &&
          (shown.proposal ? (
            <ConfirmCard
              proposal={shown.proposal}
              shopId={shop.id}
              onUpdate={onProposed}
              onFinish={(result) => (result.kind === "saved" ? onFixed() : setFix(null))}
              onStartOver={() => setFix(null)}
            />
          ) : (
            <EditForm key={shown.entry.id} entry={shown.entry} shop={shop} onProposed={onProposed} onQueued={onQueued} />
          ))}
      </Sheet>
    </section>
  );
}

function LedgerBody({ entries, all, verify, only, onShowAll, added, queued, onFix, shop, onGo }) {
  const [openTag, setOpenTag] = useState(null); // id of the row whose earlier values show
  // Group newest first by Lagos day.
  const days = [];
  for (const e of [...entries].reverse()) {
    const label = dayLabel(e.created_at);
    if (days.at(-1)?.label !== label) days.push({ label, rows: [] });
    days.at(-1).rows.push(e);
  }

  return (
    <div className="grid gap-4">
      {verify.ok ? (
        <div data-part="banner-ok" role="status" {...rise(0, "flex items-center gap-2.5 rounded-full bg-teal-soft px-4 py-2.5 text-[0.9375rem] text-teal-ink [&_svg]:size-5")}>
          <ShieldCheck aria-hidden="true" />
          <span>
            <strong>Records verified</strong> · {plural(verify.count, "entry", "entries")}
          </span>
        </div>
      ) : (
        <div
          data-part="banner-bad"
          role="alert"
          {...rise(0, "flex items-start gap-2.5 rounded-2xl border-[1.5px] border-coral bg-coral-soft px-4 py-2.5 text-[0.9375rem] text-coral-ink [&_svg]:size-5 [&_svg]:shrink-0")}
        >
          <ShieldAlert aria-hidden="true" />
          <span>
            <strong>Records were changed.</strong> Entry #{Number.isInteger(verify.index) ? verify.index + 1 : verify.brokenId}{" "}
            does not match what was saved ({verify.reason}). Do not trust totals until it is checked.
          </span>
        </div>
      )}

      {added && (
        <p data-part="fix-added" role="status" className="flex items-center gap-2 rounded-2xl border border-line bg-card px-4 py-3 font-semibold [&_svg]:size-5 [&_svg]:shrink-0">
          <Check aria-hidden="true" /> Change saved as entry #{added.seq}. The earlier version stays in your records.
        </p>
      )}

      {queued && (
        <p data-part="edit-queued" role="status" className="rounded-2xl border border-line bg-slate px-4 py-3 font-bold [overflow-wrap:anywhere]">
          {QUEUED_EDIT_MESSAGE} You will see it in Waiting to send.
        </p>
      )}

      {only && (
        <div data-part="filter" className="flex items-center justify-between gap-3 rounded-2xl border-[1.5px] border-line bg-card py-1.5 pr-1.5 pl-4">
          <span className="flex min-w-0 items-center gap-2 font-bold [&_svg]:size-5 [&_svg]:shrink-0">
            <Filter aria-hidden="true" /> <span className="truncate">Sales of {only.display}</span>
          </span>
          <Button variant="quiet" size="sm" className="w-auto shrink-0" onClick={onShowAll}>
            Show all
          </Button>
        </div>
      )}

      {days.length === 0 && only ? (
        <p className="py-6 text-center text-muted">No sales of {only.display} in your records.</p>
      ) : days.length === 0 ? (
        <EmptyState icon={ScrollText} title="No entries yet" action="Record your first sale" onAction={() => onGo("record")}>
          Tell PocketOga what you sold. It appears here after you tap Save, and can never be edited.
        </EmptyState>
      ) : (
        days.map((d, di) => (
          <section key={d.label} {...rise(di + 1)}>
            <h2 className="mx-1.5 my-2 text-[0.8125rem] font-bold tracking-[0.06em] text-muted uppercase">{d.label}</h2>
            <Card as="ul" className="divide-y divide-line px-[18px] py-1">
              {d.rows.map((e) => {
                const [icon, tone] = KIND[e.type] ?? [ScrollText, "slate"];
                const what = itemText(e);
                const replaced = supersededById(e, all) != null;
                const fixes = e.corrects_id != null ? all.find((x) => x.id === e.corrects_id) : null;
                const was = wasKobo(e, all);
                return (
                  <li key={e.id} data-part="entry-row" data-kind={e.type} data-corrected={replaced} className="grid gap-0.5 py-2.5">
                    <div className="flex min-h-12 items-center gap-3">
                      <IconCircle icon={icon} tone={tone} />
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate font-bold">{e.customer === shop.id ? "Your shop" : e.customer}</span>
                        <span className="text-[0.8125rem] text-muted">
                          {typeLabel(e.type)}
                          {what && ` · ${what}`}
                        </span>
                      </span>
                      <span className="grid justify-items-end">
                        <span data-part="entry-amount" className={cx("text-lg font-extrabold whitespace-nowrap tabular-nums", e.type === "payment" && "text-blue-ink", replaced && "text-muted")}>
                          {e.type === "payment" ? "+" : ""}
                          {formatKobo(e.amount_kobo)}
                        </span>
                        <span className="text-[0.8125rem] whitespace-nowrap text-muted tabular-nums">
                          {timeLabel(e.created_at)} · #{e.seq}
                        </span>
                      </span>
                    </div>
                    <div className="flex min-h-12 items-center justify-between gap-2 pl-14">
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.8125rem] font-semibold text-muted">
                        {fixes ? (
                          <button
                            type="button"
                            data-part="corrected-tag"
                            aria-expanded={openTag === e.id}
                            onClick={() => setOpenTag(openTag === e.id ? null : e.id)}
                            className="inline-flex min-h-11 items-center rounded-full transition-transform active:scale-96"
                          >
                            <Pill tone="slate">Corrected</Pill>
                          </button>
                        ) : replaced ? (
                          <Pill tone="slate">Corrected</Pill>
                        ) : (
                          ""
                        )}
                        {was != null && (
                          <span data-part="was-amount" className="whitespace-nowrap tabular-nums">
                            was {formatKobo(was)}
                          </span>
                        )}
                      </span>
                      {canEdit(e) && (
                        <button
                          data-part="edit-entry"
                          onClick={() => onFix(e)}
                          aria-label={`Edit entry #${e.seq}`}
                          className="-mr-3 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-bold text-link transition-transform active:scale-96 [&_svg]:size-5"
                        >
                          <Pencil aria-hidden="true" /> <span className="max-[359px]:sr-only">Edit</span>
                        </button>
                      )}
                    </div>
                    {fixes && openTag === e.id && (
                      <p data-part="was-now" className="pl-14 text-sm text-muted [overflow-wrap:anywhere]">
                        {wasNowLine(e, all) ?? "Corrected. Nothing you can see changed."}
                      </p>
                    )}
                  </li>
                );
              })}
            </Card>
          </section>
        ))
      )}
    </div>
  );
}

// The edit sheet. Fields start as the entry is; only what the trader changes
// is proposed. Nothing is saved here: the proposal goes to the confirm card and
// the change lands only when the trader taps Save there. Offline, the change is
// kept on the phone (Waiting to send) and sent later.
function EditForm({ entry, shop, onProposed, onQueued }) {
  const start = editStart(entry, shop.id);
  const [v, setV] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { text, field }
  const set = (k) => (e) => {
    setV((x) => ({ ...x, [k]: e.target.value }));
    setError(null);
  };
  const invalid = (k) => (error?.field === k ? "true" : undefined);

  async function queueIt(changes) {
    const queue = await getShopQueue(shop.id).catch(() => null);
    if (!queue) throw new Error("no queue");
    const meta = newMeta();
    await queue.enqueue(CORRECTION_KIND, { entryId: entry.id, changes }, { requestId: meta.requestId, spokenAt: meta.spokenAt });
    onQueued();
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const out = editChanges(start, v);
    if (out.error) return setError({ text: out.error, field: out.field });
    setBusy(true);
    setError(null);
    try {
      if (isOffline(connection.get())) {
        await queueIt(out.changes);
      } else {
        try {
          onProposed(await proposeEntryCorrection(entry.id, out.changes));
        } catch (err) {
          if (err?.status !== 0) throw err;
          await queueIt(out.changes); // the signal dropped while sending: keep it on the phone
        }
      }
    } catch (err) {
      setError({ text: err?.status === undefined ? "Could not keep it on your phone. Please try again." : correctionError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid min-w-0 gap-4" onSubmit={submit} noValidate data-part="edit-form">
      <p data-part="edit-explainer" className="rounded-2xl border-[1.5px] border-line bg-card px-4 py-3 [overflow-wrap:anywhere]">
        Change what is wrong in entry #{entry.seq}. You check it on the next card, and nothing is saved until you tap Save there.
      </p>
      <Field id="edit-amount" label="Amount (₦)">
        <input id="edit-amount" inputMode="decimal" autoComplete="off" value={v.amount} onChange={set("amount")} className={inputClass} aria-invalid={invalid("amount")} />
      </Field>
      <Field id="edit-item" label="Item">
        <input id="edit-item" autoComplete="off" value={v.item} onChange={set("item")} className={inputClass} aria-invalid={invalid("item")} />
      </Field>
      <Field id="edit-customer" label={entry.type === "restock" ? "Supplier" : "Customer label"}>
        <input id="edit-customer" autoComplete="off" value={v.customer} onChange={set("customer")} placeholder={entry.customer === shop.id ? "Your shop" : ""} className={inputClass} aria-invalid={invalid("customer")} />
      </Field>
      <Field id="edit-date" label="Date">
        <input id="edit-date" type="date" value={v.date} max={lagosToday()} onChange={set("date")} className={`${inputClass} min-w-0`} aria-invalid={invalid("date")} />
      </Field>
      {error && (
        <p role="alert" data-part="edit-error" className="rounded-2xl bg-slate px-4 py-3 font-semibold [overflow-wrap:anywhere]">
          {error.text}
        </p>
      )}
      <Button size="lg" disabled={busy}>
        {busy ? "Checking…" : "Save changes"}
      </Button>
    </form>
  );
}

import { useState } from "react";
import { ArrowDownLeft, Check, Filter, PackagePlus, Pencil, RotateCcw, ScrollText, ShieldAlert, ShieldCheck, ShoppingBag } from "lucide-react";
import { friendlyError, getLedger, proposeCorrection } from "../api.js";
import { dayLabel, formatKobo, itemText, nairaInput, parseNaira, plural, timeLabel, typeLabel } from "../format.js";
import { fixableEntryId, supersededById } from "../ledger.js";
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

  function openFix(e) {
    const next = { entry: e, proposal: null };
    setShown(next);
    setFix(next);
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
          entries={only ? data.entries.filter((e) => isSaleOf(e, only)) : data.entries}
          all={data.entries}
          verify={data.verify}
          only={only}
          onShowAll={() => setOnly(null)}
          added={added}
          onFix={openFix}
          shop={shop}
          onGo={onGo}
        />
      )}
      <Sheet open={!!fix} onClose={() => setFix(null)} title={fix?.proposal ? "Check before you save" : "Fix this entry"}>
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
            <FixForm key={shown.entry.id} entry={shown.entry} shop={shop} onProposed={onProposed} />
          ))}
      </Sheet>
    </section>
  );
}

function LedgerBody({ entries, all, verify, only, onShowAll, added, onFix, shop, onGo }) {
  // One fixable row in the whole shop, from the full list (not the filter).
  const fixableId = fixableEntryId(all);
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
          <Check aria-hidden="true" /> Correction #{added.seq} added. The original entry is kept and marked Corrected.
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
                        <span className={cx("font-extrabold whitespace-nowrap tabular-nums", e.type === "payment" && "text-blue-ink", replaced && "text-muted line-through")}>
                          {e.type === "payment" ? "+" : ""}
                          {formatKobo(e.amount_kobo)}
                        </span>
                        <span className="text-[0.8125rem] whitespace-nowrap text-muted tabular-nums">
                          {timeLabel(e.created_at)} · #{e.seq}
                        </span>
                      </span>
                    </div>
                    <div className="flex min-h-12 items-center justify-between gap-2 pl-14">
                      <span className="text-[0.8125rem] font-semibold text-muted">
                        {replaced ? <Pill tone="slate">Corrected</Pill> : fixes ? `Corrects #${fixes.seq}` : ""}
                      </span>
                      {e.id === fixableId && (
                        <button
                          data-part="fix-entry"
                          onClick={() => onFix(e)}
                          aria-label={`Fix this entry, #${e.seq}`}
                          className="-mr-3 inline-flex min-h-12 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-bold text-link transition-transform active:scale-96 [&_svg]:size-4"
                        >
                          <Pencil aria-hidden="true" /> Fix this entry
                        </button>
                      )}
                    </div>
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

// The fix sheet. Fields start as the entry is; only what the trader changes
// is proposed, with a reason. Nothing is saved here: the proposal goes to
// Record's card, and the correction lands only on Save.
function FixForm({ entry, shop, onProposed }) {
  const goods = entry.type === "sale" || entry.type === "restock" || (entry.type === "correction" && !!entry.item);
  const start = {
    amount: nairaInput(entry.amount_kobo),
    customer: entry.customer === shop.id ? "" : entry.customer ?? "",
    item: entry.item ?? "",
    quantity: entry.quantity == null ? "" : String(entry.quantity),
    unit: entry.unit ?? "",
  };
  const [v, setV] = useState(start);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value }));

  const amountKobo = parseNaira(v.amount);
  const q = v.quantity.trim();
  const quantity = q === "" ? null : /^\d+$/.test(q) && Number(q) > 0 ? Number(q) : NaN;
  const badAmount = amountKobo === null || amountKobo === 0;
  const bad = badAmount || Number.isNaN(quantity);

  // Only what changed is sent.
  const changes = {};
  if (v.amount !== start.amount && !badAmount) changes.amountKobo = amountKobo;
  if (v.customer.trim() && v.customer.trim() !== start.customer) changes.customer = v.customer.trim();
  if (goods && v.item.trim() !== start.item) changes.item = v.item.trim() || null;
  if (goods && q !== start.quantity && !Number.isNaN(quantity)) changes.quantity = quantity;
  if (goods && v.unit.trim() !== start.unit) changes.unit = v.unit.trim() || null;
  const changed = Object.keys(changes).length > 0;
  const ready = changed && reason.trim() && !bad && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onProposed(await proposeCorrection({ entryId: entry.id, ...changes, reason: reason.trim() }));
    } catch (err) {
      // 400s are validation the form missed; everything else has its own
      // plain sentence. Never raw error text.
      setError(err?.status === 400 ? "Check the details: plain numbers, amount above zero." : friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit} data-part="fix-form">
      <p data-part="fix-explainer" className="rounded-2xl border-[1.5px] border-line bg-card px-4 py-3">
        <strong>Fixing adds a correction; it never edits.</strong> Entry #{entry.seq} stays in your records exactly as saved, marked
        Corrected, and a new entry with the right details takes its place in your totals.
      </p>
      <Field id="fix-amount" label="Amount (₦)">
        <input id="fix-amount" inputMode="decimal" autoComplete="off" value={v.amount} onChange={set("amount")} className={inputClass} aria-invalid={badAmount} />
      </Field>
      <Field id="fix-customer" label={entry.type === "restock" ? "Supplier" : "Customer"}>
        <input id="fix-customer" autoComplete="off" value={v.customer} onChange={set("customer")} placeholder={entry.customer === shop.id ? "Your shop" : ""} className={inputClass} />
      </Field>
      {goods && (
        <>
          <Field id="fix-item" label="Item">
            <input id="fix-item" autoComplete="off" value={v.item} onChange={set("item")} className={inputClass} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="fix-quantity" label="Quantity">
              <input id="fix-quantity" inputMode="numeric" autoComplete="off" value={v.quantity} onChange={set("quantity")} className={inputClass} aria-invalid={Number.isNaN(quantity)} />
            </Field>
            <Field id="fix-unit" label="Unit">
              <input id="fix-unit" autoComplete="off" value={v.unit} onChange={set("unit")} placeholder="e.g. bag" className={inputClass} />
            </Field>
          </div>
        </>
      )}
      <Field id="fix-reason" label="Reason for the fix" hint="Kept with the correction, e.g. “wrong price, it was 45k”.">
        <textarea id="fix-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} aria-describedby="fix-reason-hint" />
      </Field>
      {bad && (
        <p role="alert" className="font-semibold text-coral-ink">
          Check the amount and quantity: plain numbers, amount above zero.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-2xl bg-slate px-4 py-3">
          {error}
        </p>
      )}
      <Button size="lg" disabled={!ready} aria-describedby="fix-why">
        {busy ? "Checking…" : "Check fix"}
      </Button>
      <p id="fix-why" className="-mt-2 text-center text-sm text-muted">
        {!changed ? "Change at least one detail above." : !reason.trim() ? "Give a reason to fix the entry." : "Next: check the card, then tap Save."}
      </p>
    </form>
  );
}

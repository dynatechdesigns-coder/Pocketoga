import { useState } from "react";
import { ArrowDownLeft, Filter, PackagePlus, RotateCcw, ScrollText, ShieldAlert, ShieldCheck, ShoppingBag } from "lucide-react";
import { getLedger } from "../api.js";
import { dayLabel, formatKobo, itemText, plural, timeLabel, typeLabel } from "../format.js";
import { Button, Card, EmptyState, ErrorState, IconCircle, ScreenHeader, Skeleton, cx, rise, useLoad } from "../ui.jsx";

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
// of that item until "Show all".
export default function LedgerScreen({ shop, intent, onGo }) {
  const { data, error, loading, reload } = useLoad(getLedger);
  const [only, setOnly] = useState(intent?.item ? intent : null);

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
          verify={data.verify}
          only={only}
          onShowAll={() => setOnly(null)}
          shop={shop}
          onGo={onGo}
        />
      )}
    </section>
  );
}

function LedgerBody({ entries, verify, only, onShowAll, shop, onGo }) {
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
                return (
                  <li key={e.id} data-part="entry-row" data-kind={e.type} className="flex min-h-[68px] items-center gap-3 py-2.5">
                    <IconCircle icon={icon} tone={tone} />
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate font-bold">{e.customer === shop.id ? "Your shop" : e.customer}</span>
                      <span className="text-[0.8125rem] text-muted">
                        {typeLabel(e.type)}
                        {what && ` · ${what}`}
                      </span>
                    </span>
                    <span className="grid justify-items-end">
                      <span className={cx("font-extrabold whitespace-nowrap tabular-nums", e.type === "payment" && "text-blue-ink")}>
                        {e.type === "payment" ? "+" : ""}
                        {formatKobo(e.amount_kobo)}
                      </span>
                      <span className="text-[0.8125rem] whitespace-nowrap text-muted tabular-nums">
                        {timeLabel(e.created_at)} · #{e.seq}
                      </span>
                    </span>
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

import { useCallback, useState } from "react";
import { ShoppingBag } from "lucide-react";
import { getLedger, getProfit } from "../api.js";
import { PERIODS, dayLabel, formatKobo, itemText, lagosDay, periodStartDay, plural, timeLabel } from "../format.js";
import { Card, EmptyState, ErrorState, IconCircle, PeriodTabs, Pill, RecordShortcut, ScreenHeader, Skeleton, cx, figure, rise, useLoad } from "../ui.jsx";

// Sale entries from GET /ledger in the chosen period, newest first, grouped by
// Lagos day. The total is the server's (GET /profit); the app only counts rows.
export default function SalesScreen({ shop, onGo }) {
  const [period, setPeriod] = useState("today");
  const ledger = useLoad(getLedger);
  const loadTotal = useCallback(() => getProfit(period), [period]);
  const total = useLoad(loadTotal);

  let body;
  if (ledger.loading && !ledger.data) body = <Skeleton blocks={[88, 220]} label="Loading sales" />;
  else if (ledger.error) body = <ErrorState message={ledger.error} onRetry={ledger.reload} />;
  else {
    const from = periodStartDay(period);
    const sales = ledger.data.entries.filter((e) => e.type === "sale" && lagosDay(e.created_at) >= from).reverse();
    const days = [];
    for (const e of sales) {
      const label = dayLabel(e.created_at);
      if (days.at(-1)?.label !== label) days.push({ label, rows: [] });
      days.at(-1).rows.push(e);
    }
    body = (
      <div className="grid gap-4">
        <Card {...rise(0, "grid gap-1")} data-part="sales-total">
          <p className="text-sm font-bold text-muted">Sales {period === "today" ? "today" : `this ${period}`}</p>
          {total.data ? (
            <p className={cx(figure, "text-[2rem]")}>{formatKobo(total.data.salesKobo)}</p>
          ) : total.error ? (
            <p data-part="total-unavailable" className="text-lg font-extrabold">
              {total.unavailable ? "Total not available yet" : "Total could not load"}
            </p>
          ) : (
            <p className={cx(figure, "text-[2rem]")}>…</p>
          )}
          <p className="text-sm text-muted">
            {plural(sales.length, "sale")} recorded
            {total.unavailable && " · the total needs the newer PocketOga server"}
          </p>
        </Card>
        {days.length === 0 ? (
          <EmptyState icon={ShoppingBag} title="No sales in this period" action="Record a sale" onAction={() => onGo("record", { hint: "sale" })}>
            Sales you save show here, newest first.
          </EmptyState>
        ) : (
          days.map((d, i) => (
            <section key={d.label} {...rise(i + 1)}>
              <h2 className="mx-1.5 my-2 text-[0.8125rem] font-bold tracking-[0.06em] text-muted uppercase">{d.label}</h2>
              <Card as="ul" className="divide-y divide-line px-[18px] py-1">
                {d.rows.map((e) => {
                  const corrected = e.correctedById != null;
                  return (
                    <li key={e.id} data-part="sale-row" className="flex min-h-[68px] items-center gap-3 py-2.5">
                      <IconCircle icon={ShoppingBag} tone="lavender" />
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate font-bold">{e.customer === shop.id ? "Your shop" : e.customer}</span>
                        <span className="text-[0.8125rem] text-muted">{itemText(e) || "Sale"}</span>
                      </span>
                      <span className="grid justify-items-end gap-0.5">
                        <span className={cx("font-extrabold whitespace-nowrap tabular-nums", corrected && "text-muted line-through")}>{formatKobo(e.amount_kobo)}</span>
                        {corrected ? <Pill tone="slate">Corrected</Pill> : <span className="text-[0.8125rem] text-muted tabular-nums">{timeLabel(e.created_at)}</span>}
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

  return (
    <section>
      <ScreenHeader title="Sales" action={<RecordShortcut onClick={() => onGo("record", { hint: "sale" })}>Record a sale</RecordShortcut>} />
      <div className="mb-4">
        <PeriodTabs periods={PERIODS} value={period} onChange={setPeriod} label="Sales period" />
      </div>
      {body}
    </section>
  );
}

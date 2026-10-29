import { useCallback, useState } from "react";
import { Plus, Receipt } from "lucide-react";
import { getExpenses } from "../api.js";
import { PERIODS, dayLabel, formatKobo } from "../format.js";
import { Button, Card, EmptyState, ErrorState, IconCircle, PeriodTabs, ScreenHeader, Skeleton, rise, useLoad } from "../ui.jsx";

// GET /expenses for the period: category totals (from the server) as chips,
// then each expense. "Add expense" only pre-fills a note on Record; it is
// saved through the normal check-and-confirm step like everything else.
export default function ExpensesScreen({ onGo }) {
  const [period, setPeriod] = useState("month");
  const load = useCallback(() => getExpenses(period), [period]);
  const { data, error, loading, reload } = useLoad(load);

  let body;
  if (loading && !data) body = <Skeleton blocks={[48, 220]} label="Loading expenses" />;
  else if (error) body = <ErrorState message={error} onRetry={reload} />;
  else if (data.expenses.length === 0)
    body = (
      <EmptyState icon={Receipt} title="No expenses in this period">
        Transport, rent, levies: say “I spend ₦2,500 on transport” to add one.
      </EmptyState>
    );
  else
    body = (
      <div className="grid gap-4">
        <ul aria-label="Spent by category" data-part="category-chips" {...rise(0, "flex flex-wrap gap-2")}>
          {data.byCategory.map((c) => (
            <li key={c.category} data-part="category-chip" className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3.5 py-2 text-sm shadow-soft">
              <span className="font-semibold text-muted">{c.category}</span>
              <span className="font-extrabold tabular-nums">{formatKobo(c.amountKobo)}</span>
            </li>
          ))}
        </ul>
        <Card as="ul" aria-label="Expenses, newest first" {...rise(1, "divide-y divide-line px-[18px] py-1")}>
          {data.expenses.map((e) => (
            <li key={e.id} data-part="expense-row" className="flex min-h-[68px] items-center gap-3 py-2.5">
              <IconCircle icon={Receipt} tone="slate" />
              <span className="grid min-w-0 flex-1">
                <span className="truncate font-bold">{e.payee}</span>
                <span className="text-[0.8125rem] text-muted">
                  {e.category} · {dayLabel(e.createdAt)}
                </span>
              </span>
              <span className="font-extrabold whitespace-nowrap tabular-nums">{formatKobo(e.amountKobo)}</span>
            </li>
          ))}
        </Card>
      </div>
    );

  return (
    <section>
      <ScreenHeader title="Expenses" />
      <div className="mb-4 grid gap-3">
        <PeriodTabs periods={PERIODS} value={period} onChange={setPeriod} label="Expenses period" />
        <Button data-part="add-expense" onClick={() => onGo("record", { text: "I spend ₦" })}>
          <Plus aria-hidden="true" /> Add expense
        </Button>
      </div>
      {body}
    </section>
  );
}

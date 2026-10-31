import { useCallback, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowRight, CalendarX2, ChevronRight, Package, PackageMinus, PartyPopper, Receipt, Share2, ShoppingBag, TrendingDown } from "lucide-react";
import { getProfit, getReport } from "../api.js";
import { PERIODS, formatKobo, plural } from "../format.js";
import { reportText, shareText } from "../share.js";
import { Button, Card, EmptyState, ErrorState, IconCircle, NotAvailable, PeriodTabs, ScreenHeader, SavedBanner, SectionTitle, Skeleton, cx, figure, rise, useLoad } from "../ui.jsx";
import ProfitChart from "../ProfitChart.jsx";
import MonthlyDownload from "../MonthlyDownload.jsx";

// How many leak categories need the trader's attention (Money shows the count).
export const attentionCount = (report) =>
  (report.broken.count > 0 ? 1 : 0) + (report.shortfalls.length > 0 ? 1 : 0) + (report.belowCost.items.length > 0 ? 1 : 0);

const LEAKS_CACHE = { key: "report" };

// Reports: what the shop made (GET /profit, by period) and, below it, where
// money is leaking (GET /report). Profit is always "Estimated": it can only
// count the cost of items that have a cost record. Sales and Collected stay
// side by side and are never merged.
export default function ReportScreen({ shop, onGo }) {
  const [period, setPeriod] = useState("today");
  const loadProfit = useCallback(() => getProfit(period), [period]);
  const profitCache = useMemo(() => ({ key: `profit:${period}` }), [period]);
  const profit = useLoad(loadProfit, { cache: profitCache });
  const leaks = useLoad(getReport, { cache: LEAKS_CACHE });

  return (
    <section>
      <ScreenHeader title="Reports" />
      <SavedBanner saved={[profit.data && profit.saved, leaks.data && leaks.saved]} />
      <div className="grid gap-4">
        {!profit.unavailable && <PeriodTabs periods={PERIODS} value={period} onChange={setPeriod} label="Report period" />}
        {profit.loading && !profit.data ? (
          <Skeleton blocks={[104, 104, 120, 260]} label="Loading profit" />
        ) : profit.unavailable ? (
          <NotAvailable title="Profit is not available yet">
            Sales, cost of goods and estimated profit need the newer PocketOga server. Where money is leaking, below, still works.
          </NotAvailable>
        ) : profit.error ? (
          <ErrorState message={profit.error} onRetry={profit.reload} />
        ) : (
          <ProfitBody p={profit.data} period={period} busy={profit.loading} onGo={onGo} />
        )}

        <SectionTitle className="mt-4">Where money is leaking</SectionTitle>
        {leaks.loading && !leaks.data ? (
          <Skeleton blocks={[176, 176, 176]} label="Loading report" />
        ) : leaks.error ? (
          <ErrorState message={leaks.error} onRetry={leaks.reload} />
        ) : (
          <ReportBody report={leaks.data} shop={shop} onGo={onGo} />
        )}

        <MonthlyDownload />
      </div>
    </section>
  );
}

const CHART_TITLE = { today: "Estimated profit by hour", week: "Estimated profit by day", month: "Estimated profit by day", year: "Estimated profit by month" };

// What the result card says for each `result` the server sends. The sign comes
// from the word, never from a minus: resultKobo is always zero or more.
const RESULT = {
  profit: { label: "Estimated profit", card: "bg-teal-soft text-teal-ink border-teal" },
  loss: { label: "Estimated loss", card: "bg-coral-soft text-coral-ink border-coral" },
  break_even: { label: "Break even", card: "bg-slate text-ink border-line" },
};

function ProfitBody({ p, period, busy, onGo }) {
  const r = RESULT[p.result] ?? RESULT.break_even;
  return (
    <div className={cx("grid gap-4 transition-opacity", busy && "opacity-60")} aria-busy={busy}>
      <div className="grid grid-cols-2 gap-3">
        <Tile part="sales" icon={ShoppingBag} tone="lavender" label="Sales" kobo={p.salesKobo} />
        <Tile part="collected" icon={ArrowDownLeft} tone="blue" label="Collected" kobo={p.collectedKobo} />
        <Tile part="cogs" icon={Package} tone="slate" label="Cost of goods" kobo={p.cogsKobo} />
        <Tile part="expenses" icon={Receipt} tone="slate" label="Expenses" kobo={p.expensesKobo} />
      </div>

      {/* The result and what is still owed, side by side. Profit is teal (the
          one success colour), a loss is coral; owed money is amber. */}
      <div className="grid grid-cols-[3fr_2fr] gap-3">
        <article data-part="profit" data-result={p.result} className={cx("grid content-start gap-1 rounded-3xl border-[1.5px] p-4", r.card)}>
          <p className="text-sm font-bold">{r.label}</p>
          <p data-part="profit-figure" className={cx(figure, "text-[clamp(1.125rem,5.6vw,2rem)]")}>
            {formatKobo(p.resultKobo)}
          </p>
          <p className="text-xs font-medium">Sales minus cost of goods and expenses.</p>
        </article>
        <article data-part="owed" className="grid content-start gap-1 rounded-3xl border-[1.5px] border-amber bg-amber-soft p-4 text-amber-ink">
          <p className="text-sm font-bold">Owed to you</p>
          <p data-part="owed-figure" className={cx(figure, "text-[clamp(1rem,4.6vw,1.5rem)]")}>
            {formatKobo(p.owedKobo)}
          </p>
          <p className="text-xs font-medium">Sold, not yet paid.</p>
        </article>
      </div>

      {p.missing_cost_items > 0 && (
        <button
          data-part="no-cost"
          onClick={() => onGo("products")}
          className="inline-flex min-h-12 items-center justify-between gap-2 rounded-2xl border-[1.5px] border-amber bg-amber-soft px-4 py-2 text-left text-sm font-bold text-amber-ink [&_svg]:size-5 [&_svg]:shrink-0"
        >
          <span>Cost missing for {plural(p.missing_cost_items, "item")}, so this may be too high</span>
          <ChevronRight aria-hidden="true" />
        </button>
      )}

      <Card as="article" className="grid min-w-0 grid-cols-1 gap-3">
        <h3 className="font-extrabold">{CHART_TITLE[period]}</h3>
        <ProfitChart series={p.series} title={CHART_TITLE[period]} />
      </Card>
    </div>
  );
}

function Tile({ part, icon, tone, label, kobo }) {
  return (
    <Card as="article" data-part={part} className="grid content-start gap-2 p-4">
      <span className="flex items-center gap-2">
        <IconCircle icon={icon} tone={tone} size="sm" />
        <span className="text-sm font-bold">{label}</span>
      </span>
      {/* Sized to the tile so ₦22,343,000 fits on one line at 360px. */}
      <span className={cx(figure, "text-[clamp(1rem,4.6vw,1.375rem)]")}>{formatKobo(kobo)}</span>
    </Card>
  );
}

function ReportBody({ report, shop, onGo }) {
  const { broken, shortfalls, belowCost, noStockRecord } = report;
  const leaks = [];

  if (broken.count > 0) {
    leaks.push(
      <LeakCard
        key="broken"
        icon={CalendarX2}
        label="Broken promises"
        figure={formatKobo(broken.amountKobo)}
        action="Chase them"
        onAction={() => onGo("debts", "broken")}
      >
        {plural(broken.count, "promise")} to pay {broken.count === 1 ? "was" : "were"} missed; this is what is still unpaid on{" "}
        {broken.count === 1 ? "it" : "them"}.
      </LeakCard>
    );
  }

  if (shortfalls.length > 0) {
    const [top, ...rest] = shortfalls;
    // Pre-fills the note only; the trader adds the price and confirms as usual.
    const restock = `I restock ${unitCount(top.shortfallQty, top.unit ?? top.item)}${top.unit ? ` of ${top.item}` : ""} for `;
    leaks.push(
      <LeakCard
        key="short"
        icon={PackageMinus}
        label="Sold more than you bought"
        figure={unitCount(top.shortfallQty, top.unit ?? top.item)}
        action="Log missing restock"
        onAction={() => onGo("record", { text: restock })}
      >
        {cap(top.item)}: you sold {top.soldQty} but only recorded buying {top.stockedQty}. Check for missing stock or a restock you forgot.
        {rest.length > 0 && <span className="block">Also {rest.map((s) => `${s.display}: ${s.shortfallQty} short`).join(", ")}.</span>}
      </LeakCard>
    );
  }

  if (belowCost.items.length > 0) {
    const [top, ...rest] = belowCost.items;
    leaks.push(
      <LeakCard
        key="below"
        icon={TrendingDown}
        label="Margin lost"
        figure={formatKobo(top.marginKobo)}
        action="See the sales"
        onAction={() => onGo("ledger", { item: top.item, unit: top.unit, display: top.display })}
      >
        Lost selling {top.item} for less than you paid for it.
        {rest.length > 0 && <span className="block">Also {rest.map((b) => `${b.display}: ${formatKobo(b.marginKobo)}`).join(", ")}.</span>}
      </LeakCard>
    );
  }

  // Items with sales but no restock history cannot be checked; say so once.
  const unchecked = Math.max(noStockRecord ?? 0, belowCost.skippedItems ?? 0);

  return (
    <div className="grid gap-4">
      {leaks.length > 0 ? (
        leaks.map((card, i) => (
          <div key={card.key} {...rise(i)}>
            {card}
          </div>
        ))
      ) : (
        <EmptyState icon={PartyPopper} title="All clear" action="Record a sale" onAction={() => onGo("record")}>
          No broken promises, no missing stock and no sales below cost. Keep recording and PocketOga keeps checking.
        </EmptyState>
      )}

      {unchecked > 0 && (
        <p className="px-1 text-sm text-muted">
          {plural(unchecked, "item")} sold without a restock record, so {unchecked === 1 ? "it is" : "they are"} not
          checked for stock or margin.
        </p>
      )}

      <Button variant="quiet" {...rise(leaks.length + 1)} onClick={() => shareText(reportText(shop.name, report))}>
        <Share2 aria-hidden="true" /> Share this report
      </Button>
    </div>
  );
}

// A loss, in coral. The whole card is one button that opens a screen or
// pre-fills a note; nothing is saved from here.
function LeakCard({ icon, label, figure: value, action, onAction, children }) {
  return (
    <Card as="button" data-part="leak" onClick={onAction} className="grid w-full gap-2 text-left transition-transform duration-150 active:scale-[0.98]">
      <span className="flex items-center gap-3">
        <IconCircle icon={icon} tone="rose" />
        <span data-part="leak-label" className="flex-1 text-[0.9375rem] font-bold">
          {label}
        </span>
        <ChevronRight aria-hidden="true" className="size-5 text-grey" />
      </span>
      <span className={cx(figure, "text-[2rem] text-coral-ink")}>{value}</span>
      <span className="text-muted">{children}</span>
      <span data-part="leak-action" className="mt-1 inline-flex items-center gap-1.5 font-bold text-link [&_svg]:size-[18px]">
        {action} <ArrowRight aria-hidden="true" />
      </span>
    </Card>
  );
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// "1 carton", "2 bags"
const unitCount = (n, word) => `${n} ${n === 1 || word.endsWith("s") ? word : word + "s"}`;

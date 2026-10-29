import { useCallback, useState } from "react";
import { ArrowDownLeft, ArrowRight, CalendarX2, ChevronRight, Package, PackageMinus, PartyPopper, Receipt, Share2, ShoppingBag, TrendingDown } from "lucide-react";
import { getProfit, getReport } from "../api.js";
import { PERIODS, formatKobo, plural } from "../format.js";
import { reportText, shareText } from "../share.js";
import { Button, Card, EmptyState, ErrorState, IconCircle, PeriodTabs, ScreenHeader, SectionTitle, Skeleton, cx, figure, rise, useLoad } from "../ui.jsx";
import ProfitChart from "../ProfitChart.jsx";

// How many leak categories need the trader's attention (Money shows the count).
export const attentionCount = (report) =>
  (report.broken.count > 0 ? 1 : 0) + (report.shortfalls.length > 0 ? 1 : 0) + (report.belowCost.items.length > 0 ? 1 : 0);

// Reports: what the shop made (GET /profit, by period) and, below it, where
// money is leaking (GET /report). Profit is always "Estimated": it can only
// count the cost of items that have a cost record. Sales and Collected stay
// side by side and are never merged.
export default function ReportScreen({ shop, onGo }) {
  const [period, setPeriod] = useState("today");
  const loadProfit = useCallback(() => getProfit(period), [period]);
  const profit = useLoad(loadProfit);
  const leaks = useLoad(getReport);

  return (
    <section>
      <ScreenHeader title="Reports" />
      <div className="grid gap-4">
        <PeriodTabs periods={PERIODS} value={period} onChange={setPeriod} label="Report period" />
        {profit.loading && !profit.data ? (
          <Skeleton blocks={[104, 104, 120, 260]} label="Loading profit" />
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
      </div>
    </section>
  );
}

const CHART_TITLE = { today: "Estimated profit by hour", week: "Estimated profit by day", month: "Estimated profit by week", year: "Estimated profit by month" };

function ProfitBody({ p, period, busy, onGo }) {
  const loss = p.estimatedProfitKobo < 0;
  return (
    <div className={cx("grid gap-4 transition-opacity", busy && "opacity-60")} aria-busy={busy}>
      <div className="grid grid-cols-2 gap-3">
        <Tile part="sales" icon={ShoppingBag} tone="lavender" label="Sales" kobo={p.salesKobo} />
        <Tile part="collected" icon={ArrowDownLeft} tone="blue" label="Collected" kobo={p.collectedKobo} />
        <Tile part="cogs" icon={Package} tone="slate" label="Cost of goods" kobo={p.cogsKobo} />
        <Tile part="expenses" icon={Receipt} tone="slate" label="Expenses" kobo={p.expensesKobo} />
      </div>

      {/* Money in, so the brand gradient; a loss is coral. */}
      <article
        data-part="profit"
        className={cx(
          "grid gap-1 rounded-3xl p-5",
          loss ? "border-[1.5px] border-coral bg-coral-soft text-coral-ink" : "bg-hero text-white shadow-lift"
        )}
      >
        <p className="font-semibold">Estimated profit</p>
        <p data-part="profit-figure" className="text-[2.25rem] leading-tight font-extrabold tracking-tight tabular-nums [overflow-wrap:anywhere]">
          {formatKobo(p.estimatedProfitKobo)}
        </p>
        <p className="text-sm font-medium">Sales minus cost of goods and expenses. Collected is not part of this.</p>
        {p.itemsWithoutCost > 0 && (
          <button
            data-part="no-cost"
            onClick={() => onGo("products")}
            className={cx(
              "mt-2 inline-flex min-h-12 items-center justify-between gap-2 rounded-2xl px-4 text-left text-sm font-bold [&_svg]:size-5 [&_svg]:shrink-0",
              loss ? "bg-card text-coral-ink" : "bg-frost text-white"
            )}
          >
            <span>
              No cost record for {plural(p.itemsWithoutCost, "item")}, so {p.itemsWithoutCost === 1 ? "its" : "their"} cost is not counted. Add cost prices
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
        )}
      </article>

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

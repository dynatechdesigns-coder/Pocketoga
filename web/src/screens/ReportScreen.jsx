import { ArrowRight, CalendarX2, ChevronRight, PackageMinus, PartyPopper, Share2, TrendingDown } from "lucide-react";
import { getReport } from "../api.js";
import { formatKobo, plural } from "../format.js";
import { reportText, shareText } from "../share.js";
import { Button, Card, EmptyState, ErrorState, IconCircle, ScreenHeader, Skeleton, cx, figure, rise, useLoad } from "../ui.jsx";

// How many leak categories need the trader's attention (Money shows the count).
export const attentionCount = (report) =>
  (report.broken.count > 0 ? 1 : 0) + (report.shortfalls.length > 0 ? 1 : 0) + (report.belowCost.items.length > 0 ? 1 : 0);

// Where money is leaking, from GET /report: one coral card per category,
// each with one action that opens a screen or pre-fills a note. Categories
// stay separate and are never added into one total — they overlap, so a sum
// would count some naira twice.
export default function ReportScreen({ shop, onGo }) {
  const { data: report, error, loading, reload } = useLoad(getReport);

  return (
    <section>
      <ScreenHeader title="Where money is leaking" />
      {loading && !report ? (
        <Skeleton blocks={[176, 176, 176]} label="Loading report" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <ReportBody report={report} shop={shop} onGo={onGo} />
      )}
    </section>
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

import { CalendarX2, Clock, FileText, Megaphone, Mic, PackageMinus, PartyPopper, Share2, TrendingDown, Users } from "lucide-react";
import { getReport } from "../api.js";
import { formatKobo, plural } from "../format.js";
import { reportText, shareText } from "../share.js";
import { Card, EmptyState, ErrorState, IconCircle, SectionTitle, Skeleton, cx, figure, rise, useLoad } from "../ui.jsx";

// Home: a gradient hero for what is owed, quick actions, then one white card
// per leak from GET /report. Categories stay separate and are never added
// into one total — they overlap, so a sum would count some naira twice.
export default function MoneyScreen({ shop, onGo }) {
  const { data: report, error, loading, reload } = useLoad(getReport);

  return (
    <section>
      <h1 className="sr-only">Money check</h1>
      {loading && !report ? (
        <Skeleton blocks={[176, 84, 136, 136]} label="Loading money check" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <MoneyBody report={report} shop={shop} onGo={onGo} />
      )}
    </section>
  );
}

function MoneyBody({ report, shop, onGo }) {
  const { owed, overdue, broken, shortfalls, belowCost, noStockRecord } = report;
  const leaks = [];

  if (broken.count > 0) {
    leaks.push(
      <LeakCard key="broken" icon={CalendarX2} tone="coral" label="Broken promises" figure={formatKobo(broken.amountKobo)}>
        {plural(broken.count, "promise")} to pay {broken.count === 1 ? "was" : "were"} missed; this is what is still unpaid on{" "}
        {broken.count === 1 ? "it" : "them"}.
      </LeakCard>
    );
  }

  if (shortfalls.length > 0) {
    const [top, ...rest] = shortfalls;
    leaks.push(
      <LeakCard key="short" icon={PackageMinus} tone="amber" label="Sold more than you bought" figure={unitCount(top.shortfallQty, top.unit ?? top.item)}>
        {cap(top.item)}: you sold {top.soldQty} but only recorded buying {top.stockedQty}. Check for missing stock or a restock you forgot.
        {rest.length > 0 && <span className="block">Also {rest.map((s) => `${s.display}: ${s.shortfallQty} short`).join(", ")}.</span>}
      </LeakCard>
    );
  }

  if (belowCost.items.length > 0) {
    const [top, ...rest] = belowCost.items;
    leaks.push(
      <LeakCard key="below" icon={TrendingDown} tone="blue" label="Margin lost" figure={formatKobo(top.marginKobo)}>
        Lost selling {top.item} for less than you paid for it.
        {rest.length > 0 && <span className="block">Also {rest.map((b) => `${b.display}: ${formatKobo(b.marginKobo)}`).join(", ")}.</span>}
      </LeakCard>
    );
  }

  const quick = [
    { label: "Record", icon: Mic, action: () => onGo("record") },
    { label: "Chase", icon: Megaphone, action: () => onGo("debts", "chase") },
    { label: "Report", icon: FileText, action: () => onGo("report") },
    { label: "Share", icon: Share2, action: () => shareText(reportText(shop.name, report)) },
  ];

  // Items with sales but no restock history cannot be checked; say so once.
  const unchecked = Math.max(noStockRecord ?? 0, belowCost.skippedItems ?? 0);

  return (
    <div className="grid gap-4">
      {/* Hero: white on the violet-to-blue gradient. The soft circle sits
          behind the text (isolate + -z-10) so it never lowers contrast. */}
      <article
        data-part="hero"
        {...rise(
          0,
          "relative isolate grid gap-2 overflow-hidden rounded-3xl bg-hero px-5 pt-6 pb-5 text-white shadow-lift after:absolute after:-top-[70px] after:-right-[60px] after:-z-10 after:size-[200px] after:rounded-full after:bg-white/8 after:content-['']"
        )}
      >
        <p className="font-semibold">You’re owed</p>
        <p data-part="hero-figure" className="text-[2.75rem] leading-[1.05] font-extrabold tracking-[-0.03em] tabular-nums [overflow-wrap:anywhere] md:text-5xl">
          {formatKobo(owed.totalKobo)}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Chip icon={Users}>{owed.customers > 0 ? `${plural(owed.customers, "customer")} owing` : "Nobody owing"}</Chip>
          <Chip icon={Clock}>{overdue.amountKobo > 0 ? `${formatKobo(overdue.amountKobo)} overdue 30+ days` : "None overdue 30+ days"}</Chip>
        </div>
      </article>

      <nav aria-label="Quick actions" {...rise(1, "grid grid-cols-4 gap-2 py-1")}>
        {quick.map((q) => (
          <button
            key={q.label}
            data-part="quick"
            onClick={q.action}
            className="grid justify-items-center gap-1.5 text-[0.8125rem] font-bold text-ink transition-transform duration-150 active:scale-96"
          >
            <span className="grid size-14 place-items-center rounded-full bg-card text-link shadow-soft [&_svg]:size-6" aria-hidden="true">
              <q.icon strokeWidth={1.9} />
            </span>
            {q.label}
          </button>
        ))}
      </nav>

      {leaks.length > 0 ? (
        <>
          <SectionTitle {...rise(2)}>Where money is leaking</SectionTitle>
          {leaks.map((card, i) => (
            <div key={card.key} {...rise(i + 3)}>
              {card}
            </div>
          ))}
        </>
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
    </div>
  );
}

function Chip({ icon: Icon, children }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-frost px-3 py-[7px] text-[0.8125rem] font-semibold text-white backdrop-blur-md [&_svg]:size-4">
      <Icon aria-hidden="true" />
      {children}
    </span>
  );
}

function LeakCard({ icon, tone, label, figure: value, children }) {
  return (
    <Card as="article" data-part="leak" className="grid gap-2">
      <div className="flex items-center gap-3">
        <IconCircle icon={icon} tone={tone} />
        <h3 data-part="leak-label" className="text-[0.9375rem] font-bold">
          {label}
        </h3>
      </div>
      <p className={cx(figure, "text-[2rem]", tone === "coral" && "text-coral-ink")}>{value}</p>
      <p className="text-muted">{children}</p>
    </Card>
  );
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// "1 carton", "2 bags"
const unitCount = (n, word) => `${n} ${n === 1 || word.endsWith("s") ? word : word + "s"}`;

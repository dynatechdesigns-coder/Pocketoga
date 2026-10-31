import { ChevronRight, CircleCheck, Clock, HandCoins, Megaphone, Mic, PackagePlus, ScanSearch, Share2, ShieldAlert, ShieldCheck, Users } from "lucide-react";
import { getLedger, getReport } from "../api.js";
import { checkLabel } from "../cancelRun.js";
import { formatKobo, plural } from "../format.js";
import { reportText, shareText } from "../share.js";
import { Button, Card, ErrorState, IconCircle, SavedBanner, Skeleton, cx, figure, rise, useLoad } from "../ui.jsx";
import WaitingToSend from "../WaitingToSend.jsx";
import { attentionCount } from "./ReportScreen.jsx";

// The report, plus the ledger's own check of its hash chain for the chip.
// The chip is optional: if the ledger cannot load, Money still shows.
async function loadMoney() {
  const [report, verify] = await Promise.all([getReport(), getLedger().then((l) => l.verify, () => null)]);
  return { ...report, verify };
}

// Home, top to bottom: money in today (brand gradient), money owed (amber),
// quick actions (Check carries the count of things needing attention), and the
// records check. The leak cards themselves live on Reports.
export default function MoneyScreen({ shop, onGo }) {
  const { data: report, error, loading, saved, reload } = useLoad(loadMoney, { cache: { key: "money" } });

  return (
    <section>
      <h1 className="sr-only">Money check</h1>
      {report && <SavedBanner saved={saved} />}
      {loading && !report ? (
        <Skeleton blocks={[112, 172, 84, 48, 56]} label="Loading money check" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <MoneyBody report={report} shop={shop} onGo={onGo} />
      )}
    </section>
  );
}

function MoneyBody({ report, shop, onGo }) {
  const { owed, overdue } = report;
  // An older backend has no today's totals: say so rather than show zeros.
  const today = report.today ?? { soldTodayKobo: 0, collectedTodayKobo: 0, unknown: true };
  const quiet = today.soldTodayKobo === 0 && today.collectedTodayKobo === 0;
  const attention = attentionCount(report);

  const quick = [
    { label: "Restock", icon: PackagePlus, action: () => onGo("record", { text: "I restock " }) },
    { label: "Chase", icon: Megaphone, action: () => onGo("debts", "chase") },
    { label: "Share", icon: Share2, action: () => shareText(reportText(shop.name, report)) },
    // Opens Check alert; the badge is the same count the Reports leaks use.
    { label: "Check", icon: ScanSearch, action: () => onGo("alert"), badge: attention },
  ];

  return (
    <div className="grid gap-4">
      {/* Money in today: white on the violet-to-blue gradient. The soft circle
          sits behind the text (isolate + -z-10) so it never lowers contrast. */}
      <article
        data-part="hero"
        aria-label="Money in today"
        {...rise(
          0,
          "relative isolate overflow-hidden rounded-3xl bg-hero p-5 text-white shadow-lift after:absolute after:-top-[70px] after:-right-[60px] after:-z-10 after:size-[200px] after:rounded-full after:bg-white/8 after:content-['']"
        )}
      >
        {quiet ? (
          <div className="grid justify-items-start gap-3">
            <p data-part="hero-empty" className="text-[1.375rem] leading-tight font-extrabold">
              {today.unknown ? "Today’s totals are not available yet" : "No sales recorded today"}
            </p>
            <p className="font-medium">{today.unknown ? "The PocketOga server needs updating to show them." : "Record a sale or payment and it shows here."}</p>
            <Button variant="light" className="w-auto min-w-42" onClick={() => onGo("record")}>
              <Mic aria-hidden="true" /> Record
            </Button>
          </div>
        ) : (
          // Two equal columns either side of a thin divider. Labels and figures
          // sit in shared rows (subgrid), so they keep one baseline even if a
          // label ever wraps.
          <dl className="grid grid-cols-[1fr_1px_1fr] grid-rows-[auto_auto] gap-x-4 gap-y-1">
            <HeroFigure label="Sold today" kobo={today.soldTodayKobo} part="sold-today" />
            <span className="row-span-2 bg-white/35" aria-hidden="true" />
            <HeroFigure label="Collected today" kobo={today.collectedTodayKobo} part="collected-today" />
          </dl>
        )}
      </article>

      {/* Money owed: the amber card. Overdue is a loss risk, so coral. */}
      <Card
        as="button"
        data-part="owed"
        onClick={() => onGo("debts")}
        {...rise(1, "relative grid w-full gap-1 overflow-hidden pl-6 text-left transition-transform duration-150 active:scale-[0.98]")}
      >
        <span className="absolute inset-y-0 left-0 w-1.5 bg-amber" aria-hidden="true" />
        <span className="flex items-center gap-3">
          <IconCircle icon={HandCoins} tone="amber" size="sm" />
          <span className="flex-1 font-bold">Customers owe you</span>
          <ChevronRight aria-hidden="true" className="size-5 text-grey" />
        </span>
        <span data-part="owed-figure" className={cx(figure, "mt-1 text-[2.75rem] md:text-5xl")}>
          {formatKobo(owed.totalKobo)}
        </span>
        <span className="mt-2 flex flex-wrap gap-2">
          <Chip icon={Users} part="chip-owing">
            {owed.customers > 0 ? `${plural(owed.customers, "customer")} owing` : "Nobody owing"}
          </Chip>
          {overdue.amountKobo > 0 ? (
            <Chip icon={Clock} part="overdue" coral>
              {formatKobo(overdue.amountKobo)} overdue 30+ days
            </Chip>
          ) : (
            <Chip icon={Clock} part="chip-overdue">
              None overdue 30+ days
            </Chip>
          )}
        </span>
      </Card>

      <nav aria-label="Quick actions" {...rise(2, "grid grid-cols-4")}>
        {quick.map((q) => (
          <button
            key={q.label}
            data-part="quick"
            onClick={q.action}
            aria-label={q.badge !== undefined ? checkLabel(q.badge) : undefined}
            className="grid min-h-12 justify-items-center gap-1.5 text-[0.875rem] font-bold whitespace-nowrap text-ink transition-transform duration-150 active:scale-96"
          >
            <span className="relative grid size-14 place-items-center rounded-full border border-line bg-card text-link shadow-soft [&_svg]:size-6" aria-hidden="true">
              <q.icon strokeWidth={1.9} />
              {q.badge > 0 && (
                <span data-part="badge" className="absolute -top-1 -right-1 grid min-w-5 place-items-center rounded-full border-2 border-page bg-coral-ink px-1 text-[0.6875rem] leading-5 font-extrabold text-white">
                  {q.badge}
                </span>
              )}
            </span>
            {q.label}
          </button>
        ))}
      </nav>

      <WaitingToSend shopId={shop.id} />

      {report.verify && <VerifiedChip verify={report.verify} onOpen={() => onGo("ledger")} />}

      {attention === 0 && (
        <p data-part="all-clear" {...rise(4, "flex min-h-14 items-center gap-3 px-1 font-semibold text-muted")}>
          <IconCircle icon={CircleCheck} tone="lavender" size="sm" />
          All clear: no broken promises, missing stock or sales below cost.
        </p>
      )}
    </div>
  );
}

// Teal only when the hash chain checks out; coral when records were changed.
function VerifiedChip({ verify, onOpen }) {
  const ok = verify.ok;
  return (
    <div {...rise(3, "flex")}>
      <button
        data-part="verified-chip"
        data-tone={ok ? "teal" : "coral"}
        onClick={onOpen}
        className={cx(
          "inline-flex min-h-12 items-center gap-2 rounded-full border-[1.5px] px-4 text-[0.9375rem] font-bold transition-transform duration-150 active:scale-96 [&_svg]:size-[18px] [&_svg]:shrink-0",
          ok ? "border-teal bg-teal-soft text-teal-ink" : "border-coral bg-coral-soft text-coral-ink"
        )}
      >
        {ok ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
        {ok ? "Records verified" : "Records changed — check the ledger"}
        <ChevronRight aria-hidden="true" />
      </button>
    </div>
  );
}

function HeroFigure({ label, kobo, part }) {
  return (
    <div className="row-span-2 grid min-w-0 grid-rows-subgrid">
      <dt className="text-[0.9375rem] font-semibold whitespace-nowrap">{label}</dt>
      <dd data-part={part} className="self-end text-[clamp(1.375rem,6.5vw,2.5rem)] leading-[1.1] font-extrabold tracking-[-0.02em] tabular-nums [overflow-wrap:anywhere]">
        {formatKobo(kobo)}
      </dd>
    </div>
  );
}

// Frosted chip inside the owed card: translucent, so it reads on either theme.
function Chip({ icon: Icon, part, coral, children }) {
  return (
    <span
      data-part={part}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-[7px] text-[0.8125rem] font-semibold backdrop-blur-md [&_svg]:size-4",
        coral ? "bg-coral/12 text-coral-ink" : "bg-ink/6 text-ink"
      )}
    >
      <Icon aria-hidden="true" />
      {children}
    </span>
  );
}

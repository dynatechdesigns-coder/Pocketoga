import { getReport } from "../api.js";
import { formatKobo, plural } from "../format.js";
import { EmptyState, ErrorState, ScreenHeader, Skeleton, useLoad } from "../ui.jsx";

// "Money check": one card per leak category from GET /report. Categories
// stay separate and are never added into one total (they overlap).
export default function MoneyScreen({ onGo }) {
  const { data: report, error, loading, reload } = useLoad(getReport);

  return (
    <section>
      <ScreenHeader title="Money check" sub="Money you are owed, or losing, right now." />
      {loading && !report ? (
        <Skeleton cards={3} height={136} label="Loading money check" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <MoneyCards report={report} onGo={onGo} />
      )}
    </section>
  );
}

function MoneyCards({ report, onGo }) {
  const { owed, overdue, broken, shortfalls, belowCost, noStockRecord } = report;
  const cards = [];

  if (owed.totalKobo > 0) {
    cards.push(
      <MoneyCard
        key="owed"
        label="Customers owe you"
        figure={formatKobo(owed.totalKobo)}
        action="See who owes"
        onAction={() => onGo("debts")}
      >
        {plural(owed.customers, "customer")} have not paid in full.
        {overdue.amountKobo > 0 && (
          <span className="card-extra">
            <strong>{formatKobo(overdue.amountKobo)}</strong> of it is more than 30 days old.
          </span>
        )}
      </MoneyCard>
    );
  }

  if (broken.count > 0) {
    cards.push(
      <MoneyCard key="broken" tone="alert" label="Broken promises" figure={formatKobo(broken.amountKobo)}>
        {plural(broken.count, "promise")} to pay missed: the day passed without full payment.
      </MoneyCard>
    );
  }

  if (shortfalls.length > 0) {
    const [top, ...rest] = shortfalls;
    cards.push(
      <MoneyCard key="short" tone="check" label="Sold more than you bought" figure={unitCount(top.shortfallQty, top.unit, top.item)}>
        {top.item}: sold {top.soldQty}, bought {top.stockedQty}. Check for missing stock or a restock you forgot to record.
        <MoreItems items={rest.map((s) => `${s.display}: ${unitCount(s.shortfallQty, s.unit, s.item)} short`)} />
      </MoneyCard>
    );
  }

  if (belowCost.items.length > 0) {
    const [top, ...rest] = belowCost.items;
    cards.push(
      <MoneyCard key="below" tone="check" label="Sold below cost" figure={formatKobo(top.marginKobo)}>
        Lost on {top.display}, sold for less than you paid for it.
        <MoreItems items={rest.map((b) => `${b.display}: ${formatKobo(b.marginKobo)} lost`)} />
      </MoneyCard>
    );
  }

  if (cards.length === 0) {
    return (
      <EmptyState title="Nothing alarming yet" action="Record a sale" onAction={() => onGo("record")}>
        Nobody owes you, no promises are broken and your stock adds up. Keep recording and PocketOga will keep checking.
      </EmptyState>
    );
  }

  // Items with sales but no restock history cannot be checked; say so once.
  const unchecked = Math.max(noStockRecord ?? 0, belowCost.skippedItems ?? 0);

  return (
    <>
      <div className="money-grid">{cards}</div>
      {unchecked > 0 && (
        <p className="muted small footnote">
          {plural(unchecked, "item")} sold without a restock record, so {unchecked === 1 ? "it is" : "they are"} not
          checked for stock or cost.
        </p>
      )}
    </>
  );
}

function MoneyCard({ label, figure, tone, children, action, onAction }) {
  return (
    <article className={`card money-card${tone ? ` tone-${tone}` : ""}`}>
      <h2 className="card-label">{label}</h2>
      <p className="figure">{figure}</p>
      <p className="card-text">{children}</p>
      {action && (
        <button className="btn btn-secondary btn-sm" onClick={onAction}>
          {action}
        </button>
      )}
    </article>
  );
}

function MoreItems({ items }) {
  if (items.length === 0) return null;
  return (
    <span className="card-extra">
      Also: {items.join("; ")}.
    </span>
  );
}

// "2 bags", "1 tin", "3 eggs"
function unitCount(n, unit, item) {
  const word = unit ?? item;
  return `${n} ${n === 1 || word.endsWith("s") ? word : word + "s"}`;
}

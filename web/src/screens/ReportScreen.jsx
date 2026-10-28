import { CalendarX2, HandCoins, PackageMinus, Share2, TrendingDown } from "lucide-react";
import { getReport } from "../api.js";
import { formatKobo, plural } from "../format.js";
import { reportText, shareText } from "../share.js";
import { Button, Card, ErrorState, IconCircle, ScreenHeader, SectionTitle, Skeleton, rise, useLoad } from "../ui.jsx";

// The full money check from GET /report: every item in every category, with
// a Share button. Each category is its own card; nothing is added together.
export default function ReportScreen({ shop }) {
  const { data: report, error, loading, reload } = useLoad(getReport);

  return (
    <section>
      <ScreenHeader title="Money report" />
      {loading && !report ? (
        <Skeleton blocks={[120, 96, 96, 96]} label="Loading report" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <div className="grid gap-4">
          <Section i={0} icon={HandCoins} tone="lavender" title="Owed to you">
            <Line label={plural(report.owed.customers, "customer")} value={formatKobo(report.owed.totalKobo)} />
            <Line label="Of that, overdue 30+ days" value={formatKobo(report.overdue.amountKobo)} />
          </Section>

          <Section i={1} icon={CalendarX2} tone="coral" title="Broken promises">
            {report.broken.count > 0 ? (
              <Line label={plural(report.broken.count, "promise")} value={`${formatKobo(report.broken.amountKobo)} unpaid`} />
            ) : (
              <None>No promises broken.</None>
            )}
          </Section>

          <Section i={2} icon={PackageMinus} tone="amber" title="Sold more than you bought">
            {report.shortfalls.length > 0 ? (
              report.shortfalls.map((s) => (
                <Line key={s.display} label={`${s.display}: sold ${s.soldQty}, bought ${s.stockedQty}`} value={`${s.shortfallQty} short`} />
              ))
            ) : (
              <None>Your stock adds up.</None>
            )}
          </Section>

          <Section i={3} icon={TrendingDown} tone="blue" title="Margin lost on below-cost sales">
            {report.belowCost.items.length > 0 ? (
              report.belowCost.items.map((b) => <Line key={b.display} label={b.display} value={formatKobo(b.marginKobo)} />)
            ) : (
              <None>No sales below cost.</None>
            )}
          </Section>

          {(report.noStockRecord > 0 || report.belowCost.skippedItems > 0) && (
            <p className="px-1 text-sm text-muted">
              {plural(Math.max(report.noStockRecord, report.belowCost.skippedItems), "item")} sold without a restock record
              could not be checked for stock or margin.
            </p>
          )}

          <Button size="lg" {...rise(4)} onClick={() => shareText(reportText(shop.name, report))}>
            <Share2 aria-hidden="true" /> Share this report
          </Button>
        </div>
      )}
    </section>
  );
}

function Section({ i, icon, tone, title, children }) {
  return (
    <Card as="article" {...rise(i, "grid gap-3")}>
      <div className="flex items-center gap-3">
        <IconCircle icon={icon} tone={tone} />
        <SectionTitle className="mt-0">{title}</SectionTitle>
      </div>
      <ul className="grid gap-1.5">{children}</ul>
    </Card>
  );
}

const Line = ({ label, value }) => (
  <li className="flex justify-between gap-4">
    <span className="text-muted">{label}</span>
    <span className="font-bold whitespace-nowrap tabular-nums">{value}</span>
  </li>
);

const None = ({ children }) => <li className="text-muted">{children}</li>;

import { getLedger } from "../api.js";
import { dayLabel, formatKobo, itemText, plural, timeLabel, typeLabel } from "../format.js";
import { EmptyState, ErrorState, ScreenHeader, Skeleton, useLoad } from "../ui.jsx";

// Saved entries, newest first, under the hash-chain check from GET /ledger.
export default function LedgerScreen({ shop, onGo }) {
  const { data, error, loading, reload } = useLoad(getLedger);

  return (
    <section>
      <ScreenHeader title="Ledger" sub="Every saved entry. Nothing here can be edited or deleted." />
      {loading && !data ? (
        <Skeleton cards={5} height={72} label="Loading ledger" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <LedgerBody entries={data.entries} verify={data.verify} shop={shop} onGo={onGo} />
      )}
    </section>
  );
}

function LedgerBody({ entries, verify, shop, onGo }) {
  const newestFirst = [...entries].reverse();

  return (
    <>
      {verify.ok ? (
        <div className="banner banner-ok" role="status">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 12 5 5 9-10" />
          </svg>
          <span>
            <strong>Records verified.</strong> {plural(verify.count, "entry", "entries")}, none changed or removed.
          </span>
        </div>
      ) : (
        <div className="banner banner-bad" role="alert">
          <strong>Warning: records were changed.</strong>
          <span>
            Entry #{Number.isInteger(verify.index) ? verify.index + 1 : verify.brokenId} does not match what was saved
            ({verify.reason}). Do not trust totals until this is checked.
          </span>
        </div>
      )}

      {newestFirst.length === 0 ? (
        <EmptyState title="No entries yet" action="Record your first sale" onAction={() => onGo("record")}>
          Tell PocketOga what you sold, and it will appear here after you tap Save.
        </EmptyState>
      ) : (
        <ul className="list" aria-label="Ledger entries, newest first">
          {newestFirst.map((e, i) => {
            const day = dayLabel(e.created_at);
            const newDay = i === 0 || dayLabel(newestFirst[i - 1].created_at) !== day;
            const what = itemText(e);
            return (
              <li key={e.id}>
                {newDay && <h2 className="day-label">{day}</h2>}
                <div className={`card ledger-row kind-${e.type}`}>
                  <span className="ledger-main">
                    <span className="ledger-who">{e.customer === shop.id ? "Your shop" : e.customer}</span>
                    <span className="muted small">
                      {typeLabel(e.type)}
                      {what && ` · ${what}`} · {timeLabel(e.created_at)}
                    </span>
                  </span>
                  <span className="ledger-amount">
                    {formatKobo(e.amount_kobo)}
                    <span className="seq">#{e.seq}</span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

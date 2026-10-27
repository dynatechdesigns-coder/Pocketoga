import { useCallback, useEffect, useState } from "react";
import { friendlyError, getLedger } from "../api.js";
import { createDemoShop, clearLocalLedger, DEMO_SHOP_NAME, tamperDemoEntry } from "../localLedger.js";
import { formatKobo, typeLabel } from "../money.js";

// "Today", "Yesterday", or "Mon 21 Oct".
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

const timeLabel = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// Saved entries for the shop, newest first, under a chain-check banner.
export default function LedgerScreen({ shop, onResetDemo }) {
  const [state, setState] = useState({ loading: true });

  const load = useCallback(async () => {
    setState({ loading: true });
    try {
      setState({ loading: false, ...(await getLedger()) });
    } catch (err) {
      setState({ loading: false, error: friendlyError(err) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, shop.id]);

  if (state.loading) {
    return (
      <div className="loading" role="status">
        <div className="spinner" aria-hidden="true" />
        <p>Loading your ledger…</p>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="alert alert-error" role="alert">
        {state.error}
        <button className="btn btn-secondary" onClick={load}>
          Try again
        </button>
      </div>
    );
  }

  const { entries, verify } = state;
  const newestFirst = [...entries].reverse();

  return (
    <section className="ledger">
      {verify.ok ? (
        <div className="banner banner-ok" role="status">
          <span className="banner-icon" aria-hidden="true">✓</span>
          <div>
            <strong>Ledger checked</strong>
            <div>
              {verify.count} {verify.count === 1 ? "entry" : "entries"}, none changed or removed.
            </div>
          </div>
        </div>
      ) : (
        <div className="banner banner-bad" role="alert">
          <span className="banner-icon" aria-hidden="true">!</span>
          <div>
            <strong>Warning: ledger was tampered with</strong>
            <div>
              Entry #{verify.brokenId}: {verify.reason}.
            </div>
          </div>
        </div>
      )}

      {state.source === "device" && (
        <p className="small muted">Showing the copy saved on this phone.</p>
      )}

      {newestFirst.length === 0 ? (
        <p className="notice">No entries yet. Go to Record and tell PocketOga your first sale.</p>
      ) : (
        <ul className="ledger-list">
          {newestFirst.map((e, i) => {
            const day = dayLabel(e.created_at);
            const showDay = i === 0 || dayLabel(newestFirst[i - 1].created_at) !== day;
            return (
              <li key={e.id}>
                {showDay && <h3 className="day">{day}</h3>}
                <div className={`ledger-row entry-${e.type}`}>
                  <div className="ledger-main">
                    <div className="ledger-who">{e.customer === shop.id ? "Your shop" : e.customer}</div>
                    <div className="ledger-meta">
                      {typeLabel(e.type)}
                      {e.item ? ` · ${e.quantity ? e.quantity + " × " : ""}${e.item}` : ""} · {timeLabel(e.created_at)}
                    </div>
                  </div>
                  <div className="ledger-amount">{formatKobo(e.amount_kobo)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {shop.demo && (
        <div className="demo-tools">
          <p className="small muted">Demo tools</p>
          <button
            className="btn btn-ghost"
            onClick={() => {
              tamperDemoEntry(shop.id);
              load();
            }}
          >
            Secretly change an old entry
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              clearLocalLedger(shop.id);
              onResetDemo({ id: createDemoShop(), name: DEMO_SHOP_NAME, demo: true });
            }}
          >
            Reset demo shop
          </button>
        </div>
      )}
    </section>
  );
}

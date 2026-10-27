import { useState } from "react";
import { setShop } from "./api.js";
import { clearLocalLedger } from "./localLedger.js";
import Home from "./screens/Home.jsx";
import RecordScreen from "./screens/RecordScreen.jsx";
import LedgerScreen from "./screens/LedgerScreen.jsx";

// The open shop ({ id, name, demo }) is remembered on this device.
const SHOP_KEY = "pocketoga.shop";

function loadShop() {
  try {
    return JSON.parse(localStorage.getItem(SHOP_KEY));
  } catch {
    return null;
  }
}

export default function App() {
  const [shop, setShopState] = useState(loadShop);
  const [tab, setTab] = useState("record");

  // Tell the API layer which shop we are, before any screen makes a call.
  if (shop) setShop(shop.id);

  function openShop(next) {
    localStorage.setItem(SHOP_KEY, JSON.stringify(next));
    setShopState(next);
    setTab(next.demo ? "ledger" : "record");
  }

  function exitShop() {
    if (shop?.demo) clearLocalLedger(shop.id); // demo data is throwaway
    localStorage.removeItem(SHOP_KEY);
    setShopState(null);
  }

  if (!shop) return <Home onOpen={openShop} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="shop-name">
          {shop.name}
          {shop.demo && <span className="badge">Demo</span>}
        </div>
        <button className="btn-link" onClick={exitShop}>
          Exit
        </button>
      </header>

      <main className="content">
        {tab === "record" ? (
          <RecordScreen shop={shop} onSeeLedger={() => setTab("ledger")} />
        ) : (
          <LedgerScreen shop={shop} onResetDemo={openShop} />
        )}
      </main>

      <nav className="tabbar">
        <button className={tab === "record" ? "tab active" : "tab"} onClick={() => setTab("record")}>
          <span aria-hidden="true">🎤</span> Record
        </button>
        <button className={tab === "ledger" ? "tab active" : "tab"} onClick={() => setTab("ledger")}>
          <span aria-hidden="true">📒</span> Ledger
        </button>
      </nav>
    </div>
  );
}

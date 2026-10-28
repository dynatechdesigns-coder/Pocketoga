import { useState } from "react";
import { setShop } from "./api.js";
import Home from "./screens/Home.jsx";
import RecordScreen from "./screens/RecordScreen.jsx";
import MoneyScreen from "./screens/MoneyScreen.jsx";
import DebtsScreen from "./screens/DebtsScreen.jsx";
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

// Simple line icons for the tab bar; they label navigation, not decoration.
const ICONS = {
  record: <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-6 9a6 6 0 0 0 12 0M12 18v3" />,
  money: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  debts: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0M16 9h5M16 13h5M18 17h3" />
    </>
  ),
  ledger: <path d="M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h4" />,
};

const TABS = [
  { key: "record", label: "Record" },
  { key: "money", label: "Money" },
  { key: "debts", label: "Debts" },
  { key: "ledger", label: "Ledger" },
];

export default function App() {
  const [shop, setShopState] = useState(loadShop);
  const [tab, setTab] = useState(shop?.demo ? "money" : "record");

  // Tell the API layer which shop we are, before any screen makes a call.
  if (shop) setShop(shop.id);

  function openShop(next) {
    localStorage.setItem(SHOP_KEY, JSON.stringify(next));
    setShopState(next);
    setTab(next.demo ? "money" : "record");
  }

  function exitShop() {
    localStorage.removeItem(SHOP_KEY);
    setShopState(null);
  }

  if (!shop) return <Home onOpen={openShop} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="shop-name">
            <span className="shop-name-text">{shop.name}</span>
            {shop.demo && <span className="badge badge-quiet">Demo</span>}
          </div>
          <button className="btn-text" onClick={exitShop} aria-label={`Leave ${shop.name}`}>
            Exit
          </button>
        </div>
      </header>

      <main className="content" id="main">
        {tab === "record" && <RecordScreen shop={shop} onGo={setTab} />}
        {tab === "money" && <MoneyScreen onGo={setTab} />}
        {tab === "debts" && <DebtsScreen onGo={setTab} />}
        {tab === "ledger" && <LedgerScreen shop={shop} onGo={setTab} />}
      </main>

      <nav className="tabbar" aria-label="Main">
        <div className="tabbar-inner">
          {TABS.map((t) => (
            <button
              key={t.key}
              className="tab"
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => setTab(t.key)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="tab-icon">
                {ICONS[t.key]}
              </svg>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

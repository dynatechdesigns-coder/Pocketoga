import { useState } from "react";
import { FileText, Mic, ScrollText, Users, Wallet } from "lucide-react";
import { setShop } from "./api.js";
import { greeting } from "./format.js";
import { Avatar } from "./ui.jsx";
import Home from "./screens/Home.jsx";
import RecordScreen from "./screens/RecordScreen.jsx";
import MoneyScreen from "./screens/MoneyScreen.jsx";
import DebtsScreen from "./screens/DebtsScreen.jsx";
import LedgerScreen from "./screens/LedgerScreen.jsx";
import ReportScreen from "./screens/ReportScreen.jsx";
import AccountSheet from "./screens/AccountSheet.jsx";

// The open shop ({ id, name, demo }) is remembered on this device.
const SHOP_KEY = "pocketoga.shop";

function loadShop() {
  try {
    return JSON.parse(localStorage.getItem(SHOP_KEY));
  } catch {
    return null;
  }
}

// Two tabs either side of the raised mic, so the mic sits in the centre.
const LEFT = [
  { key: "money", label: "Money", icon: Wallet },
  { key: "debts", label: "Debts", icon: Users },
];
const RIGHT = [
  { key: "ledger", label: "Ledger", icon: ScrollText },
  { key: "report", label: "Report", icon: FileText },
];

export default function App() {
  const [shop, setShopState] = useState(loadShop);
  const [tab, setTab] = useState("money");
  const [intent, setIntent] = useState(null); // e.g. "chase": open the top debtor
  const [account, setAccount] = useState(false);

  // Tell the API layer which shop we are, before any screen makes a call.
  if (shop) setShop(shop.id);

  function openShop(next) {
    localStorage.setItem(SHOP_KEY, JSON.stringify(next));
    setShopState(next);
    setTab("money");
  }

  function exitShop() {
    setAccount(false);
    localStorage.removeItem(SHOP_KEY);
    setShopState(null);
  }

  // Screens move between tabs with go("debts") or go("debts", "chase").
  function go(next, nextIntent = null) {
    setIntent(nextIntent);
    setTab(next);
    window.scrollTo(0, 0);
  }

  // The centre mic opens Record; on Record it starts or stops recording.
  function pressMic() {
    if (tab === "record") window.dispatchEvent(new Event("pocketoga:mic"));
    else go("record");
  }

  if (!shop) return <Home onOpen={openShop} />;

  const tabButton = (t) => {
    const Icon = t.icon;
    const active = tab === t.key;
    return (
      <button
        key={t.key}
        data-part="tab"
        aria-current={active ? "page" : undefined}
        onClick={() => go(t.key)}
        className="flex min-h-[68px] flex-col items-center justify-center gap-0.5 text-xs font-semibold text-muted transition-colors aria-[current=page]:font-extrabold aria-[current=page]:text-link [&_svg]:size-6"
      >
        <Icon aria-hidden="true" strokeWidth={active ? 2.2 : 1.75} />
        <span>{t.label}</span>
      </button>
    );
  };

  return (
    <div className="min-h-dvh">
      <header data-part="topbar" className="mx-auto flex max-w-[680px] items-center justify-between gap-4 px-5 pt-[calc(16px+env(safe-area-inset-top))]">
        <div className="grid min-w-0">
          <span className="text-sm font-medium text-muted">{greeting()},</span>
          <span className="truncate text-lg font-extrabold tracking-tight">{shop.name}</span>
        </div>
        <button
          data-part="avatar-btn"
          onClick={() => setAccount(true)}
          aria-label={`Account for ${shop.name}`}
          className="rounded-full shadow-soft transition-transform duration-150 active:scale-96"
        >
          <Avatar name={shop.name} size="btn" />
        </button>
      </header>

      <main id="main" className="mx-auto max-w-[680px] px-5 pt-6 pb-[calc(120px+env(safe-area-inset-bottom))]">
        {tab === "money" && <MoneyScreen shop={shop} onGo={go} />}
        {tab === "debts" && <DebtsScreen intent={intent} onGo={go} />}
        {tab === "record" && <RecordScreen shop={shop} onGo={go} />}
        {tab === "ledger" && <LedgerScreen shop={shop} onGo={go} />}
        {tab === "report" && <ReportScreen shop={shop} />}
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-[600px] rounded-t-3xl bg-card pb-[env(safe-area-inset-bottom)] shadow-bar md:bottom-3 md:rounded-3xl"
      >
        <div className="grid grid-cols-[1fr_1fr_92px_1fr_1fr] items-end px-2">
          {LEFT.map(tabButton)}
          <div className="grid h-[68px] place-items-center">
            <button
              data-part="tab-mic"
              onClick={pressMic}
              aria-label={tab === "record" ? "Record a voice note" : "Open Record"}
              aria-current={tab === "record" ? "page" : undefined}
              className="-mt-[34px] grid size-[66px] place-items-center rounded-full border-[5px] border-page bg-hero text-white shadow-lift transition-transform duration-150 active:scale-96 [&_svg]:size-[26px]"
            >
              <Mic aria-hidden="true" strokeWidth={2} />
            </button>
          </div>
          {RIGHT.map(tabButton)}
        </div>
      </nav>

      <AccountSheet open={account} shop={shop} onClose={() => setAccount(false)} onExit={exitShop} />
    </div>
  );
}

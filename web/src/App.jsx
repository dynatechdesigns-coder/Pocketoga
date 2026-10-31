import { useEffect, useState } from "react";
import { BarChart3, ScanSearch, Check, ChevronRight, Ellipsis, MessageSquare, Mic, Package, Receipt, ScrollText, Settings, ShoppingBag, Users, UserRound, Wallet } from "lucide-react";
import { getShopId, requestsRunning, setShop } from "./api.js";
import DevBanner from "./DevBanner.jsx";
import InstallRow, { InstallSteps } from "./InstallRow.jsx";
import OfflinePill from "./OfflinePill.jsx";
import { connection, isOffline } from "./connection.js";
import { createPrefetch } from "./prefetch.js";
import { PREFETCH_TASKS } from "./savedLoaders.js";
import { savedData } from "./savedData.js";
import { hasSession, loadShop } from "./shop.js";
import { greeting } from "./format.js";
import { plural } from "./format.js";
import { Avatar, IconCircle, Sheet, ThemeToggle, cx } from "./ui.jsx";
import RecordScreen from "./screens/RecordScreen.jsx";
import MoneyScreen from "./screens/MoneyScreen.jsx";
import DebtsScreen from "./screens/DebtsScreen.jsx";
import LedgerScreen from "./screens/LedgerScreen.jsx";
import ReportScreen from "./screens/ReportScreen.jsx";
import SalesScreen from "./screens/SalesScreen.jsx";
import ProductsScreen from "./screens/ProductsScreen.jsx";
import ExpensesScreen from "./screens/ExpensesScreen.jsx";
import CustomersScreen from "./screens/CustomersScreen.jsx";
import AlertCheckScreen from "./screens/AlertCheckScreen.jsx";
import SettingsScreen from "./screens/SettingsScreen.jsx";
import FeedbackScreen from "./screens/FeedbackScreen.jsx";

// The dock: five equal slots, the raised mic in the middle one, so it is
// centred on the dock at any width.
const LEFT = [
  { key: "money", label: "Money", icon: Wallet },
  { key: "debts", label: "Debts", icon: Users },
];

// Screens behind the More sheet, in the order the sheet lists them.
const MORE = [
  { key: "alert", label: "Check alert", icon: ScanSearch, hint: "Look for warning signs before you hand over goods" },
  { key: "sales", label: "Sales", icon: ShoppingBag, hint: "Every sale, by day" },
  { key: "products", label: "Products", icon: Package, hint: "Stock and prices" },
  { key: "expenses", label: "Expenses", icon: Receipt, hint: "What the shop spends" },
  { key: "customers", label: "Customers", icon: UserRound, hint: "Phone numbers and balances" },
  { key: "ledger", label: "Ledger", icon: ScrollText, hint: "All records, and fixes" },
  { key: "settings", label: "Settings", icon: Settings, hint: "Theme and shop" },
  { key: "feedback", label: "Send feedback", icon: MessageSquare, hint: "Suggestions, problems and reviews" },
];
const MORE_KEYS = MORE.map((m) => m.key);

// The name of a screen, for "Back to Sales".
const SCREEN_LABELS = {
  money: "Money",
  debts: "Debts",
  report: "Reports",
  ...Object.fromEntries(MORE.map((m) => [m.key, m.label])),
};

// Every slot has the same shape (24px icon row, then the label, pinned to
// the bottom), so all labels and icons share one baseline.
const SLOT = "flex min-h-[72px] flex-col items-center justify-end gap-1 pb-2 text-xs leading-4 font-semibold";

// The signed-in app for one open shop ({ id, name, demo }); Root decides when
// it shows and what leaving the shop does.
export default function App({ shop, onExit }) {
  const [tab, setTab] = useState("money");
  // What the next screen should do on arrival: "chase" (open the top debtor),
  // "broken" (debtors with a broken promise), { text } (pre-fill Record),
  // { item, unit, display } (Ledger: that item's sales).
  const [intent, setIntent] = useState(null);
  const [more, setMore] = useState(false);
  const [installSteps, setInstallSteps] = useState(false); // iPhone and iPad: how to add it to the home screen
  // Where Record was opened from, so Back and Save return there: { tab, label },
  // or null when Record was not opened from another screen.
  const [origin, setOrigin] = useState(null);
  const [saved, setSaved] = useState(null); // { count } for the "Saved" note on the screen we return to

  // Tell the API layer which shop we are, before any screen makes a call.
  setShop(shop.id, shop.token);

  // Screens move between tabs with go("debts") or go("debts", "chase").
  function go(next, nextIntent = null) {
    setMore(false);
    // The mic and the Record shortcuts open Record from any screen; remember it.
    setOrigin(next === "record" && tab !== "record" ? { tab, label: SCREEN_LABELS[tab] ?? "where you were" } : next === "record" ? origin : null);
    setIntent(nextIntent);
    setTab(next);
    window.scrollTo(0, 0);
  }

  // After Save, back to the screen Record was opened from, with a short note.
  function savedAndBack(result) {
    const to = origin?.tab ?? "money";
    go(to);
    setSaved({ count: result.count, already: result.already });
  }

  // Quietly keeps the saved copies behind Money, Debts and Reports recent (see
  // prefetch.js): on open and whenever the app returns to the foreground.
  useEffect(() => {
    const prefetch = createPrefetch({
      getShop: () => {
        const s = loadShop();
        return s && !s.demo && hasSession(s) ? s : null;
      },
      isOnline: () => !isOffline(connection.get()),
      isIdle: () => requestsRunning() === 0,
      activeShopId: getShopId,
      tasks: PREFETCH_TASKS,
      store: savedData,
    });
    const onVisible = () => document.visibilityState === "visible" && prefetch.trigger();
    document.addEventListener("visibilitychange", onVisible);
    prefetch.trigger();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      prefetch.stop();
    };
  }, [shop.id]);

  // The "Saved" note goes away by itself.
  useEffect(() => {
    if (!saved) return undefined;
    const t = setTimeout(() => setSaved(null), 7000);
    return () => clearTimeout(t);
  }, [saved]);

  // The centre mic opens Record; on Record it starts or stops recording.
  function pressMic() {
    if (tab === "record") window.dispatchEvent(new Event("pocketoga:mic"));
    else go("record");
  }

  const slot = ({ key, label, icon: Icon, active, onClick, part = "tab" }) => (
    <button
      key={key}
      data-part={part}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cx(SLOT, "text-muted transition-colors aria-[current=page]:font-extrabold aria-[current=page]:text-link [&_svg]:size-6")}
    >
      <Icon aria-hidden="true" strokeWidth={active ? 2.2 : 1.75} />
      <span data-part="tab-label">{label}</span>
    </button>
  );

  return (
    <div className="min-h-dvh">
      {__MOCK_CONTRACT__ && <DevBanner />}
      <header data-part="topbar" className="mx-auto flex max-w-[680px] items-center justify-between gap-4 px-5 pt-[calc(16px+env(safe-area-inset-top))]">
        <div className="grid min-w-0">
          <span className="text-sm font-medium text-muted">{greeting()},</span>
          <span className="truncate text-lg font-extrabold tracking-tight">{shop.name}</span>
          <OfflinePill shopId={shop.id} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <button
            data-part="avatar-btn"
            onClick={() => go("settings")}
            aria-label={`Settings for ${shop.name}`}
            className="rounded-full shadow-soft transition-transform duration-150 active:scale-96"
          >
            <Avatar name={shop.name} size="btn" />
          </button>
        </div>
      </header>

      {/* Bottom padding clears the dock (72px), the mic raised 28px above it,
          the desktop lift (12px) and the phone's home bar, so the last thing
          on every screen sits above them. */}
      <main id="main" className="mx-auto max-w-[680px] px-5 pt-6 pb-[calc(152px+max(env(safe-area-inset-bottom),16px))] md:pb-[160px]">
        {tab === "money" && <MoneyScreen shop={shop} onGo={go} />}
        {tab === "debts" && <DebtsScreen intent={intent} onGo={go} />}
        {tab === "record" && <RecordScreen shop={shop} intent={intent} origin={origin} onBack={() => go(origin.tab)} onSaved={savedAndBack} onGo={go} />}
        {tab === "report" && <ReportScreen shop={shop} onGo={go} />}
        {tab === "sales" && <SalesScreen shop={shop} onGo={go} />}
        {tab === "products" && <ProductsScreen onGo={go} />}
        {tab === "expenses" && <ExpensesScreen onGo={go} />}
        {tab === "customers" && <CustomersScreen />}
        {tab === "ledger" && <LedgerScreen shop={shop} intent={intent} onGo={go} />}
        {tab === "alert" && <AlertCheckScreen shop={shop} />}
        {tab === "settings" && <SettingsScreen shop={shop} onExit={onExit} />}
        {tab === "feedback" && <FeedbackScreen onGo={go} />}
      </main>

      {saved && (
        <div
          data-part="saved-note"
          role="status"
          className="fixed inset-x-0 bottom-[calc(104px+max(env(safe-area-inset-bottom),16px))] z-30 mx-auto flex w-[calc(100%-40px)] max-w-[560px] animate-rise items-center gap-3 rounded-card border border-teal bg-card px-4 py-2 shadow-lift md:bottom-[100px]"
        >
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-teal-soft text-teal-ink [&_svg]:size-4">
            <Check strokeWidth={3} />
          </span>
          <p className="flex-1 font-bold">{saved.already ? "Already saved. Nothing was added twice." : `Saved. ${plural(saved.count, "entry", "entries")} added.`}</p>
          <button
            type="button"
            onClick={() => {
              setSaved(null);
              go("ledger");
            }}
            className="min-h-12 rounded-full px-3 text-sm font-bold text-link underline"
          >
            See ledger
          </button>
        </div>
      )}

      <nav
        data-part="dock"
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-[600px] rounded-t-3xl border-t border-line bg-card/85 pb-[max(env(safe-area-inset-bottom),16px)] shadow-bar md:pb-0 backdrop-blur-xl md:bottom-3 md:rounded-3xl md:border"
      >
        <div className="grid grid-cols-5 px-2">
          {LEFT.map((t) => slot({ ...t, active: tab === t.key, onClick: () => go(t.key) }))}
          {/* The middle slot is one button: the gradient circle rides 28px
              above the dock's top edge, centred on the slot, and "Record"
              sits on the shared label baseline. */}
          <button
            data-part="tab-mic"
            onClick={pressMic}
            aria-label={tab === "record" ? "Record a voice note" : "Open Record"}
            aria-current={tab === "record" ? "page" : undefined}
            className={cx(SLOT, "group relative text-muted aria-[current=page]:font-extrabold aria-[current=page]:text-link")}
          >
            <span
              data-part="mic-circle"
              aria-hidden="true"
              className="absolute -top-7 left-1/2 grid size-[66px] -translate-x-1/2 place-items-center rounded-full border-[5px] border-page bg-hero text-white shadow-lift transition-transform duration-150 group-active:scale-96 [&_svg]:size-[26px]"
            >
              <Mic strokeWidth={2} />
            </span>
            <span data-part="tab-label">Record</span>
          </button>
          {slot({ key: "report", label: "Reports", icon: BarChart3, active: tab === "report", onClick: () => go("report") })}
          {slot({ key: "more", label: "More", icon: Ellipsis, active: MORE_KEYS.includes(tab), onClick: () => setMore(true) })}
        </div>
      </nav>

      <Sheet open={more} onClose={() => setMore(false)} title="More">
        <ul data-part="more-list" className="grid gap-2">
          {MORE.map((m) => (
            <li key={m.key}>
              <button
                data-part="more-item"
                onClick={() => go(m.key)}
                aria-current={tab === m.key ? "page" : undefined}
                className="flex min-h-16 w-full items-center gap-3.5 rounded-card border border-line bg-card px-4 py-2.5 text-left shadow-soft transition-transform duration-150 active:scale-[0.98] aria-[current=page]:border-accent"
              >
                <IconCircle icon={m.icon} tone="lavender" />
                <span className="grid flex-1">
                  <span className="font-bold">{m.label}</span>
                  <span className="text-sm text-muted">{m.hint}</span>
                </span>
                <ChevronRight aria-hidden="true" className="size-5 text-grey" />
              </button>
            </li>
          ))}
          <InstallRow onClose={() => setMore(false)} onSteps={() => setInstallSteps(true)} />
        </ul>
      </Sheet>
      <InstallSteps open={installSteps} onClose={() => setInstallSteps(false)} />
    </div>
  );
}

import { useEffect, useSyncExternalStore } from "react";
import { CloudOff } from "lucide-react";
import { connection, pillText, pillTone, watchBrowserConnection } from "./connection.js";
import { useQueueItems } from "./WaitingToSend.jsx";

// A small pill under the shop name, on every screen, while PocketOga cannot be
// reached. No popup: it appears and goes by itself. Calm grey, with an icon so
// it is not colour alone; amber only when a queued note needs the trader.
const TONES = {
  neutral: "border-line bg-slate text-ink",
  warn: "border-amber bg-amber-soft text-amber-ink",
};

export default function OfflinePill({ shopId }) {
  useEffect(watchBrowserConnection, []);
  const state = useSyncExternalStore(connection.subscribe, connection.get);
  const { items } = useQueueItems(shopId);
  const text = pillText(state, items.length);
  if (!text) return null;
  const tone = pillTone(items);
  return (
    <span
      data-part="offline-pill"
      data-tone={tone}
      role="status"
      className={`mt-0.5 inline-flex min-h-6 w-fit max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs font-bold whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0 ${TONES[tone]}`}
    >
      <CloudOff aria-hidden="true" />
      <span className="truncate">{text}</span>
      {tone === "warn" && <span className="sr-only">. An item needs you.</span>}
    </span>
  );
}

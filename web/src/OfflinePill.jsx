import { useEffect, useSyncExternalStore } from "react";
import { CloudOff } from "lucide-react";
import { connection, pillText, watchBrowserConnection } from "./connection.js";
import { useQueueItems } from "./WaitingToSend.jsx";

// A small pill under the shop name, on every screen, while PocketOga cannot be
// reached. No popup: it appears and goes by itself. Amber text on a soft amber
// fill, with an icon, so it reads in light and dark and is not colour alone.
export default function OfflinePill({ shopId }) {
  useEffect(watchBrowserConnection, []);
  const state = useSyncExternalStore(connection.subscribe, connection.get);
  const { items } = useQueueItems(shopId);
  const text = pillText(state, items.length);
  if (!text) return null;
  return (
    <span
      data-part="offline-pill"
      role="status"
      className="mt-0.5 inline-flex min-h-6 w-fit max-w-full items-center gap-1.5 rounded-full border border-amber bg-amber-soft px-2.5 text-xs font-bold whitespace-nowrap text-amber-ink [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      <CloudOff aria-hidden="true" />
      <span className="truncate">{text}</span>
    </span>
  );
}

import { useEffect, useState } from "react";
import { AlertTriangle, CloudOff, Mic, PenLine, ScanSearch, Type, X } from "lucide-react";
import { getShopQueue } from "./shopQueue.js";
import { timeLabel } from "./format.js";
import { queuedRow } from "./queuedRow.js";
import { Card, IconCircle } from "./ui.jsx";

const KINDS = { text: ["Typed note", Type], audio: ["Voice note", Mic], photo: ["Alert photo", ScanSearch], manual: ["Entered by hand", PenLine] };

// The queue's items for a shop, live. Empty when IndexedDB is unavailable.
export function useQueueItems(shopId) {
  const [state, setState] = useState({ queue: null, items: [] });
  useEffect(() => {
    let stop = null;
    let alive = true;
    getShopQueue(shopId).then((queue) => {
      if (!alive || !queue) return;
      setState({ queue, items: queue.list() });
      stop = queue.subscribe((items) => setState({ queue, items }));
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [shopId]);
  return state;
}

// "Waiting to send (N)": notes kept on this phone until they can be sent, each
// with Cancel. A note that could not be sent says "Needs you" and why.
export default function WaitingToSend({ shopId }) {
  const { queue, items } = useQueueItems(shopId);
  if (!queue || items.length === 0) return null;
  return (
    <Card data-part="waiting-to-send" as="section" aria-label={`Waiting to send, ${items.length}`} className="grid min-w-0 gap-3 overflow-hidden p-4">
      <h2 className="flex items-center gap-2 font-extrabold">
        <CloudOff aria-hidden="true" className="size-5 shrink-0 text-grey" /> Waiting to send ({items.length})
      </h2>
      <ul className="grid min-w-0 gap-2">
        {items.map((item) => {
          const row = queuedRow(item, timeLabel);
          const Icon = (KINDS[item.kind] ?? KINDS.text)[1];
          return (
            <li key={item.id} data-part="queued" data-status={item.status} className="min-w-0 rounded-2xl border border-line py-2.5 pr-1 pl-3">
              {/* Icon, text (takes the rest, wraps, never hidden), Cancel. */}
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5">
                  <IconCircle icon={Icon} tone={row.stuck ? "coral" : "slate"} size="sm" />
                </span>
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="font-bold [overflow-wrap:anywhere]">{row.name}</span>
                  {row.detail && <span className="text-sm [overflow-wrap:anywhere]">{row.detail}</span>}
                  <span className="text-sm text-muted">{row.recorded}</span>
                  <span className={row.stuck ? "text-sm font-bold text-coral-ink" : "text-sm font-semibold text-muted"}>{row.status}</span>
                </div>
                <button
                  type="button"
                  data-part="queued-cancel"
                  onClick={() => queue.cancel(item.id)}
                  aria-label={`${row.cancelLabel}: ${row.cancelHint}`}
                  className="grid size-11 shrink-0 place-items-center rounded-full text-ink transition-transform duration-150 active:scale-96 [&_svg]:size-5"
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              {row.stuck && (
                <div className="mt-2 grid gap-2 pr-2">
                  <p role="alert" className="flex items-start gap-2 text-sm font-semibold text-coral-ink [overflow-wrap:anywhere]">
                    <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> <span className="min-w-0">{row.error}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => queue.retry(item.id)}
                    className="min-h-11 rounded-full bg-lavender px-4 text-[0.9375rem] font-bold text-link transition-transform duration-150 active:scale-96"
                  >
                    Try again
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

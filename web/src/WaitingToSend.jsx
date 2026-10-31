import { useEffect, useState } from "react";
import { AlertTriangle, CloudOff, Mic, ScanSearch, Type, X } from "lucide-react";
import { getShopQueue } from "./shopQueue.js";
import { timeLabel } from "./format.js";
import { Button, Card, IconCircle } from "./ui.jsx";

const KINDS = { text: ["Typed note", Type], audio: ["Voice note", Mic], photo: ["Alert photo", ScanSearch] };

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
    <Card data-part="waiting-to-send" as="section" aria-label={`Waiting to send, ${items.length}`} className="grid gap-3 p-4">
      <h2 className="flex items-center gap-2 font-extrabold">
        <CloudOff aria-hidden="true" className="size-5 text-grey" /> Waiting to send ({items.length})
      </h2>
      <ul className="grid gap-2">
        {items.map((item) => {
          const [label, Icon] = KINDS[item.kind] ?? KINDS.text;
          const stuck = item.status === "needs-you";
          return (
            <li key={item.id} data-part="queued" data-status={item.status} className="grid gap-2 rounded-2xl border border-line px-3 py-2.5">
              <div className="flex items-center gap-3">
                <IconCircle icon={Icon} tone={stuck ? "coral" : "slate"} size="sm" />
                <div className="grid min-w-0 flex-1">
                  <span className="font-bold">{label}</span>
                  <span className="text-sm text-muted">
                    {timeLabel(item.spokenAt)} · {stuck ? "Needs you" : "Waiting"}
                  </span>
                </div>
                <Button variant="quiet" size="sm" className="w-auto shrink-0" onClick={() => queue.cancel(item.id)} aria-label={`Cancel ${label.toLowerCase()} from ${timeLabel(item.spokenAt)}`}>
                  <X aria-hidden="true" /> Cancel
                </Button>
              </div>
              {stuck && (
                <div className="grid gap-2">
                  <p role="alert" className="flex items-start gap-2 text-sm font-semibold text-coral-ink">
                    <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> {item.error}
                  </p>
                  <Button variant="secondary" size="sm" onClick={() => queue.retry(item.id)}>
                    Try again
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

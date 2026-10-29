import { CornerDownRight, Lock, RotateCcw, ShoppingBag } from "lucide-react";
import { Card, IconCircle, Pill } from "../ui.jsx";

// Two ledger rows styled like the app's Ledger screen (fake demo data): a
// saved sale with a lock, and the correction added under it. The old line is
// never changed. Sits on the violet Trust section, so the dark colour tokens
// apply.
export default function LedgerPeek() {
  return (
    <figure data-part="ledger-peek" className="grid h-full content-center gap-5 rounded-[24px] border border-white/15 bg-black/20 p-5 md:p-8">
      <Card as="ul" className="divide-y divide-line px-[18px] py-1">
        <li data-part="peek-original" className="flex min-h-16 items-center gap-3 py-2.5">
          <IconCircle icon={ShoppingBag} tone="lavender" />
          <span className="grid min-w-0 flex-1">
            <span className="font-bold">Rice, 2 bags</span>
            <span className="text-[0.8125rem] text-muted">Sale · saved</span>
          </span>
          <span className="flex items-center gap-2 font-extrabold whitespace-nowrap tabular-nums">
            ₦45,000
            <Lock aria-label="Locked" className="size-4 text-muted" strokeWidth={2.2} />
          </span>
        </li>
        <li data-part="peek-correction" className="flex min-h-16 items-center gap-3 py-2.5 pl-6">
          <CornerDownRight aria-hidden="true" className="size-5 shrink-0 text-muted" />
          <IconCircle icon={RotateCcw} tone="slate" />
          <span className="grid min-w-0 flex-1 gap-1">
            <span className="font-bold">Correction: ₦40,000, price fixed</span>
            <span>
              <Pill tone="slate">Correction</Pill>
            </span>
          </span>
        </li>
      </Card>
      <figcaption className="grid gap-2">
        <p className="text-[1.125rem] font-extrabold text-white">Saved entries can&rsquo;t be edited or deleted.</p>
        <p className="text-[0.9375rem] leading-relaxed text-white/85">
          Under the hood, every entry is chained to the one before it, so any tampering shows up in red.
        </p>
      </figcaption>
    </figure>
  );
}

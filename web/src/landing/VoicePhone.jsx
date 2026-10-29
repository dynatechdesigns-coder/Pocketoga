import { useLayoutEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { cx } from "../ui.jsx";
import { VOICE_NOTE_LENGTH } from "./whatsappDemo.js";
import { PhoneScreen, Waveform } from "./WhatsAppWeb.jsx";

// Step 1 of How it works: a coded phone (same frame as the hero phone) with a
// WhatsApp-style chat, in place of a photo. Fake demo data. It fills a tile
// the size of a step photo: the phone is drawn at a fixed 340px stage width
// and scaled to the tile's width, so the text stays sharp (vector scaling)
// and nothing reflows. The phone rises from the tile's bottom edge, which
// crops its lower half.
const STAGE_W = 340;
const BUTTONS = ["Save", "Fix", "Reject"];

export default function VoicePhone({ className }) {
  const tile = useRef(null);
  const [size, setSize] = useState(null); // { scale, height } once measured

  useLayoutEffect(() => {
    const el = tile.current;
    if (!el) return undefined;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0) setSize({ scale: width / STAGE_W, height: height / (width / STAGE_W) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={tile}
      aria-hidden="true"
      data-part="step-phone"
      className={cx("relative overflow-hidden rounded-[24px] bg-cream ring-1 ring-ink/10", className)}
    >
      {size && (
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ width: STAGE_W, height: size.height, transform: `scale(${size.scale})` }}
        >
          <div className="absolute top-3 left-1/2 w-[262px] -translate-x-1/2">
            <PhoneScreen height={330}>
              <div className="flex flex-col gap-2 p-3 text-[0.8125rem] leading-snug">
                {/* The trader's voice note */}
                <div className="flex max-w-[88%] items-center gap-2.5 self-end rounded-[18px_18px_6px_18px] bg-primary px-3 py-2.5 text-white">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/20 [&_svg]:size-4">
                    <Play fill="currentColor" />
                  </span>
                  <Waveform />
                  <span className="text-xs font-semibold tabular-nums">{VOICE_NOTE_LENGTH}</span>
                </div>

                {/* PocketOga's reply card */}
                <div className="grid max-w-[94%] gap-2">
                  <div className="rounded-[18px_18px_18px_6px] border border-line bg-card px-3 py-2.5 text-ink">
                    Sold 2 bags of rice to Ada, <strong>₦45,000</strong>, she owes <strong>₦20,000</strong>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {BUTTONS.map((b) => (
                      <span
                        key={b}
                        className={cx(
                          "grid min-h-8 place-items-center rounded-full border text-xs font-bold",
                          b === "Save" ? "border-transparent bg-primary text-white" : "border-line bg-card text-link",
                        )}
                      >
                        {b}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </PhoneScreen>
          </div>
        </div>
      )}
    </div>
  );
}

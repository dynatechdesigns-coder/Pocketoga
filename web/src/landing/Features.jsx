import { HandCoins, Lock, Package, TrendingDown } from "lucide-react";
import { Reveal } from "./motion.jsx";
import { IconTile, LIFT, Section } from "./parts.jsx";
import { cx } from "../ui.jsx";

// Only features that already work: debts and reminders, the money check,
// products and low stock, the locked ledger with corrections.
const FEATURES = [
  [HandCoins, "Know who owes you", "Every customer's balance in one place, with a polite reminder ready to send from your own WhatsApp."],
  [TrendingDown, "See where money leaks", "The money check shows broken promises, goods sold below cost and stock that does not add up."],
  [Package, "Track your stock", "Your products and prices, with a warning when something is running low."],
  [
    Lock,
    "A record nobody can quietly change",
    "Every entry is locked in a chain. A mistake is fixed with a new correction, never by erasing.",
  ],
];

// Warm cards on the white section: cream with a soft orange edge. The 56px icon
// tiles alternate soft orange and marigold (a cream tile would vanish on a
// cream card).
export default function Features() {
  return (
    <Section id="features" tone="white" title="What it does for you">
      <ul className="grid gap-5 md:grid-cols-2 md:gap-6">
        {FEATURES.map(([icon, title, text], i) => (
          <Reveal as="li" key={title} delay={i * 70}>
            <article
              data-part="feature"
              className={cx(
                "grid h-full grid-cols-[3.5rem_1fr] content-start gap-x-4 gap-y-3 rounded-[24px] border border-sunset/25 bg-cream p-6 sm:gap-x-5 sm:gap-y-2 md:p-8",
                LIFT,
              )}
            >
              {/* Phones: the tile sits beside the title and the text runs full width below; wider: tile left, title and text right. */}
              <span className="self-center sm:row-span-2 sm:self-start">
                <IconTile icon={icon} tone={i % 2 === 0 ? "sunset" : "marigold"} size="lg" />
              </span>
              <h3 className="self-center text-2xl leading-snug font-extrabold sm:self-start">{title}</h3>
              <p className="col-span-2 text-[1.0625rem] leading-relaxed text-muted sm:col-span-1">{text}</p>
            </article>
          </Reveal>
        ))}
      </ul>
    </Section>
  );
}

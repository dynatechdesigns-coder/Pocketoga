import { HandCoins, Lock, Package, TrendingDown } from "lucide-react";
import { Reveal } from "./motion.jsx";
import { IconTile, LIFT, Section } from "./parts.jsx";
import { cx } from "../ui.jsx";

// Only features that already work: debts and reminders, the money check,
// products and low stock, the locked ledger with corrections.
const FEATURES = [
  [
    HandCoins,
    "sunset",
    "Know who owes you",
    "Every customer's balance in one place, with a polite reminder ready to send from your own WhatsApp.",
  ],
  [
    TrendingDown,
    "marigold",
    "See where money leaks",
    "The money check shows broken promises, goods sold below cost and stock that does not add up.",
  ],
  [Package, "marigold", "Track your stock", "Your products and prices, with a warning when something is running low."],
  [
    Lock,
    "sunset",
    "A record nobody can quietly change",
    "Every entry is locked in a chain. A mistake is fixed with a new correction, never by erasing.",
  ],
];

export default function Features() {
  return (
    <Section id="features" tone="white" title="What it does for you">
      <ul className="grid gap-5 md:grid-cols-2">
        {FEATURES.map(([icon, tone, title, text], i) => (
          <Reveal as="li" key={title} delay={i * 70}>
            <article data-part="feature" className={cx("flex h-full gap-4 rounded-[24px] border border-line bg-surface p-6 md:p-7", LIFT)}>
              <IconTile icon={icon} tone={tone} />
              <div className="grid content-start gap-1.5">
                <h3 className="text-xl font-extrabold">{title}</h3>
                <p className="text-[1.0625rem] leading-relaxed text-muted">{text}</p>
              </div>
            </article>
          </Reveal>
        ))}
      </ul>
    </Section>
  );
}

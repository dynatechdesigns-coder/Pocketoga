import { hasImage } from "./images.js";
import { Reveal } from "./motion.jsx";
import { CardRow, ImageCard, Section } from "./parts.jsx";

const GOODS = [
  ["goods-rice", "Rice by the bag", "Two open sacks of white rice on a market table."],
  ["goods-eggs", "Eggs by the crate", "Wooden crates full of brown eggs at a market stall."],
  ["goods-cartons", "Goods by the carton", "Stacks of flat brown cartons at a market stall."],
  ["goods-measure", "Beans by the paint", "Beans heaped in a metal paint bucket used as a measure."],
];

// "It understands how you sell": units the way traders say them.
export default function Market() {
  const goods = GOODS.filter(([slot]) => hasImage(slot));
  return (
    <Section id="market" tone="cream" title="It understands how you sell">
      {goods.length > 0 && (
        <Reveal>
          <CardRow label="Goods, the way you sell them">
            {goods.map(([slot, caption, alt]) => (
              <ImageCard key={slot} slot={slot} caption={caption} alt={alt} aspect="4 / 5" />
            ))}
          </CardRow>
        </Reveal>
      )}
      <Reveal as="p" className="mt-8 max-w-[60ch] text-[1.0625rem] leading-relaxed text-muted md:text-lg">
        Bags, crates, cartons, paints. You say it the way you sell it.
      </Reveal>
    </Section>
  );
}

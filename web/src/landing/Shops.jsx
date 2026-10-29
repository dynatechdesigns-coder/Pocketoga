import { hasImage } from "./images.js";
import { Reveal } from "./motion.jsx";
import { CardRow, ImageCard, Section } from "./parts.jsx";
import { STEP_SLOTS } from "./HowItWorks.jsx";

const SHOPS = [
  ["shop-provision", "Provision stores", "Shelves of tins, packets and bottled water in a provision store."],
  ["shop-kiosk", "Roadside kiosks", "A kiosk keeper under an umbrella beside shelves of oil, soap and small packets."],
  ["shop-counter", "Shop counters", "A notebook of daily sales held over a counter, beside a calculator and a bundle of cash."],
  ["shop-wholesale", "Wholesalers", "Sacks of grain and stacks of cartons outside a wholesaler's store."],
];

// "From kiosks to wholesalers". A photo already shown in How it works is not
// repeated, and with fewer than two photos the section is left out. Phones: a
// sideways snap row. Wider: 2x2, or three across when three photos are left.
export default function Shops() {
  const shops = SHOPS.filter(([slot]) => hasImage(slot) && !STEP_SLOTS.includes(slot));
  if (shops.length < 2) return null;
  const cols = shops.length === 3 ? 3 : 2;
  return (
    <Section id="shops" tone="cream" title="From kiosks to wholesalers" intro="Small stall or big store, the records work the same way.">
      <Reveal>
        <CardRow label="Shops like yours" cols={cols}>
          {shops.map(([slot, caption, alt]) => (
            <ImageCard key={slot} slot={slot} caption={caption} alt={alt} aspect={cols === 3 ? "4 / 5" : "4 / 3"} />
          ))}
        </CardRow>
      </Reveal>
    </Section>
  );
}

import { Check, Eye, HandCoins, MessageCircle } from "lucide-react";
import { WHATSAPP_LINK } from "../config.js";
import { Button, cx, rise } from "../ui.jsx";
import { hasImage } from "./images.js";
import { Container, IconTile, Photo, Pill } from "./parts.jsx";
import { PhoneScreen, WebMoney } from "./WhatsAppWeb.jsx";

const TICKS = ["Works with voice notes", "Pidgin and English", "Nothing saved without your OK"];

// First screen: the promise on the left; on the right the trader photo with a
// soft marigold shape behind it. The app's Money screen hangs off its top
// right corner (over the blurred market behind her) and two small chips bob
// gently: one over the awning at the top left, one just below the photo. So
// nothing covers her face, her phone or the goods on the counter. The photo
// is the only image that loads before the visitor scrolls.
export default function Hero({ onDemo }) {
  const photo = hasImage("hero-trader");
  return (
    <section
      aria-labelledby="hero-h"
      className="overflow-x-clip bg-surface pt-8 pb-20 md:flex md:min-h-[calc(100svh-4rem)] md:items-center md:pt-14 md:pb-24"
    >
      <Container className="grid items-center gap-14 lg:grid-cols-[1fr_1.15fr] lg:gap-14">
        <div className="grid content-start justify-items-start gap-6">
          <Pill {...rise(0)}>Made for market traders and small shops</Pill>
          <h1 id="hero-h" {...rise(1, "text-4xl leading-[1.08] font-extrabold tracking-tight text-balance md:text-[3.75rem] lg:text-[4.25rem]")}>
            Know where your shop{" "}
            <span className="relative isolate whitespace-nowrap after:absolute after:inset-x-0 after:bottom-[0.06em] after:-z-10 after:h-[0.28em] after:rounded-full after:bg-marigold/55 dark:after:bg-marigold/30 after:content-['']">
              money
            </span>{" "}
            dey go
          </h1>
          <p {...rise(2, "max-w-[52ch] text-[1.0625rem] leading-relaxed text-pretty text-muted md:text-lg")}>
            Talk to it on WhatsApp like you talk to your customers. It writes your sales, debts and stock, and you confirm every entry.
          </p>
          <div {...rise(3, "grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap")}>
            <Button
              data-part="hero-demo"
              variant="gradient"
              size="lg"
              className="sm:w-auto sm:min-w-52 hover:-translate-y-0.5"
              onClick={onDemo}
            >
              Try the demo shop
            </Button>
            <Button
              as="a"
              data-part="hero-whatsapp"
              variant="outline"
              size="lg"
              className="sm:w-auto sm:min-w-52 hover:-translate-y-0.5"
              href={WHATSAPP_LINK}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircle aria-hidden="true" /> Start on WhatsApp
            </Button>
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-2" data-part="ticks">
            {TICKS.map((t) => (
              <li
                key={t}
                className="inline-flex items-center gap-1.5 text-[0.9375rem] text-ink [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-sunset-ink"
              >
                <Check aria-hidden="true" strokeWidth={3} /> {t}
              </li>
            ))}
          </ul>
        </div>

        {photo && (
          <div data-part="hero-visual" className="relative isolate mx-auto w-full max-w-[560px] md:mr-0 lg:max-w-[640px]">
            {/* A soft marigold shape and a small sunset dot behind the photo. */}
            <span
              aria-hidden="true"
              className="absolute -top-6 -right-4 -z-10 h-[78%] w-[82%] rounded-[44%_56%_50%_50%/50%_44%_56%_50%] bg-marigold/35"
            />
            <span aria-hidden="true" className="absolute -bottom-5 left-[38%] -z-10 size-16 rounded-full bg-sunset/30" />

            <Photo
              slot="hero-trader"
              eager
              className="aspect-square object-[28%_center] md:aspect-[5/4] md:object-center"
              alt="A trader in a head wrap checks her phone at her stall, among sacks of rice and crates of eggs."
            />

            {/* The app's Money screen, small, hanging off the top right corner. */}
            <div
              aria-hidden="true"
              data-part="hero-phone"
              className="absolute -top-8 -right-2 h-[173px] w-[131px] md:-top-12 md:-right-6 md:h-[206px] md:w-[156px]"
            >
              <div className="w-[312px] origin-top-left scale-[0.42] md:scale-50">
                <PhoneScreen height={400}>
                  <WebMoney updated reduced />
                </PhoneScreen>
              </div>
            </div>

            <Chip className="-top-4 left-2 md:-top-5 md:-left-8" icon={HandCoins} tone="marigold">
              Ada owes ₦20,000
            </Chip>
            <Chip className="top-full right-3 mt-3 [animation-delay:-3s] md:right-8" icon={Eye} tone="sunset">
              3 things need your eye
            </Chip>
          </div>
        )}
      </Container>
    </section>
  );
}

// A small white card floating around the photo; bobs slowly (static with
// reduced motion). Decorative: the same facts are told in the sections below.
function Chip({ icon, tone, className, children }) {
  return (
    <span
      aria-hidden="true"
      data-part="hero-chip"
      className={cx(
        "absolute flex animate-bob items-center gap-2 rounded-2xl border border-line bg-card py-1.5 pr-3 pl-1.5 text-[0.8125rem] font-extrabold text-ink shadow-lift md:py-2 md:pr-3.5 md:pl-2 md:text-sm",
        className,
      )}
    >
      <IconTile icon={icon} tone={tone} size="sm" />
      {children}
    </span>
  );
}

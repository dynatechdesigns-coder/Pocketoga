import { DEMO_SHOP_ID } from "../api.js";
import Nav from "../landing/Nav.jsx";
import Hero from "../landing/Hero.jsx";
import Market from "../landing/Market.jsx";
import HowItWorks from "../landing/HowItWorks.jsx";
import WhatsAppWeb from "../landing/WhatsAppWeb.jsx";
import Features from "../landing/Features.jsx";
import Shops from "../landing/Shops.jsx";
import Trust from "../landing/Trust.jsx";
import FinalCta from "../landing/FinalCta.jsx";
import Footer from "../landing/Footer.jsx";

// The page a visitor sees when no shop is open: a photo story of the market
// (AI-generated images from public/landing/, resolved at build time), the
// WhatsApp showcase, and the trust story, each section in src/landing/.
// White and cream sections alternate; Trust is the one deep violet section.
// Motion is gentle and stops with prefers-reduced-motion.
const DEMO_SHOP = { id: DEMO_SHOP_ID, name: "Mama Nkechi Provisions", demo: true };

export default function Landing({ onOpen, onLogin }) {
  const demo = () => onOpen(DEMO_SHOP);
  return (
    <div data-part="landing" className="overflow-x-clip bg-surface text-ink">
      <Nav onDemo={demo} onLogin={onLogin} />
      <main>
        <Hero onDemo={demo} onLogin={onLogin} />
        <Market />
        <HowItWorks />
        <WhatsAppWeb />
        <Features />
        <Shops />
        <Trust />
        <FinalCta onDemo={demo} onLogin={onLogin} />
      </main>
      <Footer onDemo={demo} />
    </div>
  );
}

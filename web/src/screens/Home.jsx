import { useState } from "react";
import { HandCoins, Mic, ShieldCheck } from "lucide-react";
import { DEMO_SHOP_ID } from "../api.js";
import { Button, IconCircle, rise } from "../ui.jsx";
import { inputClass } from "./ConfirmCard.jsx";

const POINTS = [
  { icon: Mic, title: "Talk your sales", text: "English or Pidgin. PocketOga writes it down." },
  { icon: ShieldCheck, title: "You confirm every entry", text: "Nothing saves until you tap Save." },
  { icon: HandCoins, title: "See the money leaking", text: "Who owes you, broken promises, lost margin." },
];

// Landing screen: one clear way in — the demo shop, no signup or password.
export default function Home({ onOpen }) {
  const [name, setName] = useState("");

  // Testing only: opens a shop by name. No password yet — real auth comes later.
  function openNamed(e) {
    e.preventDefault();
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (id) onOpen({ id, name: name.trim(), demo: false });
  }

  return (
    <main className="mx-auto grid max-w-[460px] gap-6 px-5 pt-[calc(48px+env(safe-area-inset-top))] pb-10">
      <div {...rise(0, "grid gap-3")}>
        <img src="/icon.svg" alt="" width="56" height="56" className="size-14 rounded-[18px] shadow-lift" />
        <h1 className="mt-2 text-[2rem] leading-[1.15] font-extrabold tracking-tight">Find the money your shop is losing.</h1>
        <p className="text-[1.0625rem] text-muted">
          PocketOga keeps your records, chases what you are owed, and tells you where money is leaking.
        </p>
      </div>

      <ul className="grid gap-4">
        {POINTS.map((p, i) => (
          <li key={p.title} {...rise(i + 1, "flex items-center gap-3.5")}>
            <IconCircle icon={p.icon} tone="lavender" />
            <span>
              <strong>{p.title}</strong>
              <span className="block text-muted">{p.text}</span>
            </span>
          </li>
        ))}
      </ul>

      <div {...rise(4, "grid gap-2")}>
        <Button size="lg" onClick={() => onOpen({ id: DEMO_SHOP_ID, name: "Mama Nkechi Provisions", demo: true })}>
          Try the demo shop
        </Button>
        <p className="text-center text-sm text-muted">No signup. No password. Fake data only.</p>
      </div>

      <details className="border-t border-line pt-2">
        <summary className="flex min-h-12 cursor-pointer items-center font-semibold text-muted">Open a test shop by name</summary>
        <form onSubmit={openNamed} className="grid gap-4">
          <label htmlFor="shop-name" className="font-bold">
            Shop name
          </label>
          <input
            id="shop-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Test Shop 1"
            autoComplete="off"
            className={inputClass}
          />
          <Button variant="secondary" disabled={!name.trim()}>
            Open shop
          </Button>
        </form>
      </details>
    </main>
  );
}

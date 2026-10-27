import { useState } from "react";
import { createDemoShop, DEMO_SHOP_NAME } from "../localLedger.js";

// Landing screen: one big button into a demo shop full of fake entries.
export default function Home({ onOpen }) {
  const [name, setName] = useState("");

  function openDemo() {
    onOpen({ id: createDemoShop(), name: DEMO_SHOP_NAME, demo: true });
  }

  // Testing only: opens a shop by name. No password yet — real auth comes later.
  function openNamed(e) {
    e.preventDefault();
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (id) onOpen({ id, name: name.trim(), demo: false });
  }

  return (
    <main className="home">
      <img src="/icon.svg" alt="" className="home-logo" />
      <h1>PocketOga</h1>
      <p className="tagline">Talk your sales. Check am. Save am.</p>

      <button className="btn btn-primary btn-xl" onClick={openDemo}>
        Try the demo shop
      </button>
      <p className="hint">No signup. No password. Fake data only.</p>

      <details className="home-more">
        <summary>Open a test shop by name</summary>
        <form onSubmit={openNamed}>
          <label htmlFor="shop-name">Shop name</label>
          <input
            id="shop-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Test Shop 1"
            autoComplete="off"
          />
          <button className="btn btn-secondary" disabled={!name.trim()}>
            Open shop
          </button>
        </form>
      </details>
    </main>
  );
}

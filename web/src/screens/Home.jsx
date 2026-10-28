import { useState } from "react";
import { DEMO_SHOP_ID } from "../api.js";

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
    <main className="home">
      <img src="/icon.svg" alt="" className="home-logo" width="72" height="72" />
      <h1 className="home-title">PocketOga</h1>
      <p className="home-lead">Finds and protects the money your shop is losing.</p>

      <ul className="home-points">
        <li>Talk your sales. PocketOga writes them down.</li>
        <li>Nothing saves until you tap Save.</li>
        <li>See who owes you, and what is leaking.</li>
      </ul>

      <button
        className="btn btn-primary btn-lg"
        onClick={() => onOpen({ id: DEMO_SHOP_ID, name: "Mama Nkechi Provisions", demo: true })}
      >
        Try the demo shop
      </button>
      <p className="muted small center">No signup. No password. Fake data only.</p>

      <details className="home-more">
        <summary>Open a test shop by name</summary>
        <form onSubmit={openNamed} className="stack">
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

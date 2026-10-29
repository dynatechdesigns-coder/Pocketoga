import { useState } from "react";
import { ChevronRight, Package, Plus } from "lucide-react";
import { friendlyError, getProducts, setProductPrices } from "../api.js";
import { formatKobo, nairaInput, parseNaira, plural } from "../format.js";
import { Button, Card, EmptyState, ErrorState, Field, IconCircle, NotAvailable, Pill, ScreenHeader, Sheet, Skeleton, rise, useLoad } from "../ui.jsx";
import { inputClass } from "./ConfirmCard.jsx";

// GET /products: stock on hand, a low-stock pill, and a sheet to set the sell
// and cost prices (POST /products/:id). "Add product" pre-fills a restock note on
// Record, so it is saved through the normal check-and-confirm step. Cost prices are what let Reports
// count cost of goods; a product with none is left out of the estimate.
export default function ProductsScreen({ onGo }) {
  const { data: products, error, loading, unavailable, reload } = useLoad(getProducts);
  const [open, setOpen] = useState(null); // product
  const [shown, setShown] = useState(null); // kept while the sheet slides away
  const [saved, setSaved] = useState({}); // id -> product, after a save

  const list = products?.map((p) => saved[p.id] ?? p);

  function openProduct(p) {
    setShown(p);
    setOpen(p);
  }

  let body;
  if (loading && !products) body = <Skeleton blocks={[76, 76, 76, 76]} label="Loading products" />;
  else if (unavailable)
    body = <NotAvailable title="Products are not available yet">Stock and prices need the newer PocketOga server.</NotAvailable>;
  else if (error) body = <ErrorState message={error} onRetry={reload} />;
  else if (list.length === 0)
    body = (
      <EmptyState icon={Package} title="No products yet">
        Say “I restock 10 bags of rice” to add one. Products appear once you record restocks and sales.
      </EmptyState>
    );
  else
    body = (
      <Card as="ul" aria-label="Products" {...rise(0, "divide-y divide-line px-0 py-1.5")}>
        {list.map((p) => (
          <li key={p.id}>
            <button
              data-part="product-row"
              onClick={() => openProduct(p)}
              aria-label={`${p.name}: ${stockText(p)}${p.lowStock ? ", low stock" : ""}. Sells at ${priceText(p.sellPriceKobo, p.unit)}, costs ${priceText(p.costPriceKobo, p.unit)}. Set prices`}
              className="flex min-h-[76px] w-full items-center gap-3 rounded-card px-[18px] py-3 text-left transition duration-150 hover:bg-page active:scale-[0.98]"
            >
              <IconCircle icon={Package} tone="lavender" />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-bold">{p.name}</span>
                  {p.lowStock && <Pill tone="blue">{p.stockOnHand <= 0 ? "Out of stock" : "Low stock"}</Pill>}
                </span>
                <span className="text-[0.8125rem] text-muted">{stockText(p)}</span>
                <span className="text-[0.8125rem] text-muted">
                  Sell {priceText(p.sellPriceKobo, p.unit)} · Cost {p.costPriceKobo == null ? <strong className="text-coral-ink">not set</strong> : priceText(p.costPriceKobo, p.unit)}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="-mr-1.5 size-[18px] shrink-0 text-grey" />
            </button>
          </li>
        ))}
      </Card>
    );

  return (
    <section>
      <ScreenHeader title="Products" />
      {!unavailable && (
        <div className="mb-4">
          <Button data-part="add-product" variant="secondary" onClick={() => onGo("record", { text: "I restock " })}>
            <Plus aria-hidden="true" /> Add product
          </Button>
        </div>
      )}
      {body}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={shown ? `${shown.name} prices` : ""}>
        {shown && (
          <PriceForm
            key={shown.id}
            product={shown}
            onSaved={(p) => {
              setSaved((s) => ({ ...s, [p.id]: p }));
              setOpen(null);
            }}
          />
        )}
      </Sheet>
    </section>
  );
}

// stockOnHand can be below zero: more was sold than the records show bought.
const stockText = (p) =>
  p.stockOnHand < 0 ? `${plural(-p.stockOnHand, p.unit ?? "item")} sold more than you bought` : `${plural(p.stockOnHand, p.unit ?? "item")} in stock`;
const priceText = (kobo, unit) => (kobo == null ? "not set" : `${formatKobo(kobo)}${unit ? ` per ${unit}` : ""}`);

function PriceForm({ product, onSaved }) {
  const [sell, setSell] = useState(nairaInput(product.sellPriceKobo));
  const [cost, setCost] = useState(nairaInput(product.costPriceKobo));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const sellKobo = sell.trim() ? parseNaira(sell) : undefined;
  const costKobo = cost.trim() ? parseNaira(cost) : undefined;
  const bad = sellKobo === null || costKobo === null;
  // Only send what changed.
  const changes = {};
  if (sellKobo !== undefined && sellKobo !== null && sellKobo !== product.sellPriceKobo) changes.sellPriceKobo = sellKobo;
  if (costKobo !== undefined && costKobo !== null && costKobo !== product.costPriceKobo) changes.costPriceKobo = costKobo;
  const nothing = Object.keys(changes).length === 0;

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await setProductPrices(product.id, changes));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const per = product.unit ? ` per ${product.unit}` : "";
  return (
    <form className="grid gap-4" onSubmit={save} data-part="price-form">
      <p className="text-muted">{stockText(product)}. Prices are in naira{per}.</p>
      <Field id="sell-price" label={`Sell price${per} (₦)`}>
        <input id="sell-price" inputMode="decimal" autoComplete="off" value={sell} onChange={(e) => setSell(e.target.value)} placeholder="e.g. 59,000" className={inputClass} aria-invalid={sellKobo === null} />
      </Field>
      <Field id="cost-price" label={`Cost price${per} (₦)`} hint="What you pay your supplier. Reports use it to estimate profit.">
        <input
          id="cost-price"
          inputMode="decimal"
          autoComplete="off"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder="e.g. 52,000"
          className={inputClass}
          aria-describedby="cost-price-hint"
          aria-invalid={costKobo === null}
        />
      </Field>
      {bad && (
        <p role="alert" className="font-semibold text-coral-ink">
          Type a plain amount, like 59000 or 59,000.50.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-2xl bg-slate px-4 py-3">
          {error}
        </p>
      )}
      <Button size="lg" disabled={bad || nothing || busy}>
        {busy ? "Saving…" : "Save prices"}
      </Button>
    </form>
  );
}

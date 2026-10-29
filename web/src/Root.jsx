import { Suspense, lazy, useState } from "react";
import { loadShop, saveShop } from "./shop.js";
import Landing from "./screens/Landing.jsx";
import AccuracyPage from "./screens/AccuracyPage.jsx";

// The signed-in app is its own chunk: a visitor who only reads the landing
// page never downloads the screens.
const App = lazy(() => import("./App.jsx"));

// Not signed in: the landing page. Signed in: the app.
export default function Root() {
  const [shop, setShop] = useState(loadShop);

  function open(next) {
    saveShop(next);
    setShop(next);
  }

  function exit() {
    saveShop(null);
    setShop(null);
    window.scrollTo(0, 0);
  }

  // The accuracy page is planned; until it exists this path shows a placeholder.
  if (location.pathname === "/accuracy") return <AccuracyPage />;
  if (!shop) return <Landing onOpen={open} />;
  return (
    <Suspense fallback={<div role="status" aria-label="Loading" className="min-h-dvh" />}>
      <App shop={shop} onExit={exit} />
    </Suspense>
  );
}

import { Suspense, lazy, useEffect, useState } from "react";
import { SESSION_ENDED, logout } from "./api.js";
import { hasSession, loadShop, saveShop } from "./shop.js";
import { savedData } from "./savedData.js";
import Landing from "./screens/Landing.jsx";
import LoginScreen from "./screens/LoginScreen.jsx";
import AccuracyPage from "./screens/AccuracyPage.jsx";

// The signed-in app is its own chunk: a visitor who only reads the landing
// page never downloads the screens.
const App = lazy(() => import("./App.jsx"));

const ENDED = "Your login ended. Log in again with a new code.";

// A real shop is kept only while its session is live; the demo needs none.
const loadLive = () => {
  const shop = loadShop();
  return hasSession(shop) ? shop : null;
};

// Not signed in: the landing page, or the login at /login. Signed in: the app.
export default function Root() {
  const [shop, setShop] = useState(loadLive);
  const [onLogin, setOnLogin] = useState(() => location.pathname === "/login");
  const [notice, setNotice] = useState("");

  function go(login) {
    history.pushState(null, "", login ? "/login" : "/");
    setOnLogin(login);
    window.scrollTo(0, 0);
  }

  function open(next) {
    // Opening a different shop: the one we were in leaves nothing behind.
    if (shop && shop.id !== next.id) savedData.clearShop(shop.id);
    saveShop(next);
    setShop(next);
    setNotice("");
    if (location.pathname !== "/") history.replaceState(null, "", "/");
  }

  function exit() {
    if (shop) savedData.clearShop(shop.id); // signing out removes this device's saved copy
    if (shop && !shop.demo) logout(shop.token);
    saveShop(null);
    setShop(null);
    setOnLogin(false);
    history.replaceState(null, "", "/");
    window.scrollTo(0, 0);
  }

  // From the demo: leave it and open the login screen (no landing page between).
  function exitToLogin() {
    if (shop) savedData.clearShop(shop.id);
    saveShop(null);
    setShop(null);
    setNotice("");
    history.pushState(null, "", "/login");
    setOnLogin(true);
    window.scrollTo(0, 0);
  }

  useEffect(() => {
    const onPop = () => setOnLogin(location.pathname === "/login");
    // The server turned the token away: back to the login, with a reason.
    const onEnded = () => {
      const ended = loadShop();
      if (ended) savedData.clearShop(ended.id);
      saveShop(null);
      setShop(null);
      setNotice(ENDED);
      history.replaceState(null, "", "/login");
      setOnLogin(true);
    };
    // The token's own expiry, checked while the app sits open.
    const timer = setInterval(() => {
      const current = loadShop();
      if (current && !current.demo && !hasSession(current)) onEnded();
    }, 30000);
    window.addEventListener("popstate", onPop);
    window.addEventListener(SESSION_ENDED, onEnded);
    return () => {
      clearInterval(timer);
      window.removeEventListener("popstate", onPop);
      window.removeEventListener(SESSION_ENDED, onEnded);
    };
  }, []);

  // The public accuracy page: static, for everyone, signed in or not.
  if (location.pathname === "/accuracy") return <AccuracyPage />;
  // Nothing from a real shop renders without a live session.
  if (!hasSession(shop)) {
    if (onLogin) return <LoginScreen notice={notice} onLoggedIn={open} onBack={() => go(false)} />;
    return <Landing onOpen={open} onLogin={() => go(true)} />;
  }
  return (
    <Suspense fallback={<div role="status" aria-label="Loading" className="min-h-dvh" />}>
      <App shop={shop} onExit={exit} onLogin={exitToLogin} />
    </Suspense>
  );
}

import { useState } from "react";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { ApiError, login } from "../api.js";
import { WHATSAPP_LINK } from "../config.js";
import { EARLY_ACCESS_PRIVACY } from "../privacyNotes.js";
import { loadLastShop, saveLastShop } from "../shop.js";
import { Button, Card, Field, ThemeToggle, inputClass, rise } from "../ui.jsx";
import { Container, Pill } from "../landing/parts.jsx";

// One plain sentence per way a login can fail.
function loginError(err) {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  if (err.status === 0) return "Cannot reach PocketOga. Check your connection and try again.";
  if (err.status === 429) return "Too many wrong tries. Wait an hour, then ask for a new code.";
  if (err.status === 401) {
    if (/expired/i.test(err.message)) return "That code has expired. Send the word dashboard on WhatsApp for a new one.";
    if (/already used/i.test(err.message)) return "That code was already used. Send the word dashboard on WhatsApp for a new one.";
    return "That code is not right. Check the 6 digits and try again.";
  }
  if (err.status === 400) return "Enter the 6-digit code from WhatsApp.";
  if (err.status >= 500) return "PocketOga is not answering right now. Please try again in a moment.";
  return err.message.charAt(0).toUpperCase() + err.message.slice(1);
}

// The shop id comes from a link (?shop=...) or the last login on this device.
// Only when neither is there does the form ask for it.
function knownShop() {
  try {
    return new URLSearchParams(location.search).get("shop")?.trim() || loadLastShop();
  } catch {
    return loadLastShop();
  }
}

// Passwordless login: the trader sends "dashboard" on WhatsApp, gets a
// one-time code back, and types it here.
export default function LoginScreen({ notice, onLoggedIn, onBack }) {
  const [shop, setShop] = useState(knownShop);
  const [askShop] = useState(() => !knownShop());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(notice ?? "");

  const ready = code.trim().length > 0 && shop.trim().length > 0 && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const out = await login(shop.trim(), code.trim());
      saveLastShop(out.shop_id);
      onLoggedIn({ id: out.shop_id, name: "My shop", demo: false, token: out.token, expiresAt: out.expires_at });
    } catch (err) {
      setError(loginError(err));
      setBusy(false);
    }
  }

  return (
    <div data-part="login" className="min-h-dvh bg-cream text-ink">
      <header className="bg-surface">
        <Container className="flex h-16 items-center justify-between gap-2">
          <a href="/" aria-label="PocketOga home" className="flex min-h-12 min-w-12 items-center gap-2.5 text-lg font-extrabold tracking-tight text-ink no-underline" onClick={(e) => { e.preventDefault(); onBack(); }}>
            <img src="/icon.svg" alt="" width="36" height="36" className="size-9 rounded-[11px]" />
            PocketOga
          </a>
          <ThemeToggle />
        </Container>
      </header>

      <main id="main" className="px-5 py-10 md:py-16">
        <div className="mx-auto grid w-full max-w-[460px] gap-6">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-h-12 w-fit items-center gap-1.5 rounded-full pr-3 font-extrabold text-link [&_svg]:size-5"
          >
            <ArrowLeft aria-hidden="true" /> Back
          </button>

          <div className="grid justify-items-start gap-3">
            <Pill {...rise(0)}>Open my shop</Pill>
            <h1 {...rise(1, "text-[2rem] leading-tight font-extrabold tracking-tight md:text-[2.5rem]")}>Log in with a code</h1>
            <p {...rise(2, "text-[1.0625rem] leading-relaxed text-muted")}>
              Send the word <strong className="text-ink">dashboard</strong> to the PocketOga WhatsApp number, then enter the code here.
            </p>
          </div>

          <Card as="form" onSubmit={submit} noValidate className="grid gap-5 p-6">
            {askShop && (
              <Field id="login-shop" label="Shop ID" hint="Needed once on a new device.">
                <input
                  id="login-shop"
                  className={inputClass}
                  value={shop}
                  onChange={(e) => setShop(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck="false"
                  aria-describedby="login-shop-hint"
                />
              </Field>
            )}
            <Field id="login-code" label="Your code" hint="6 digits. It works once and expires in 10 minutes.">
              <input
                id="login-code"
                className={`${inputClass} text-center text-2xl font-extrabold tracking-[0.3em] tabular-nums`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                aria-describedby={error ? "login-code-hint login-error" : "login-code-hint"}
                aria-invalid={error ? "true" : undefined}
              />
            </Field>

            {error && (
              <p id="login-error" role="alert" className="rounded-2xl border-[1.5px] border-coral bg-coral-soft px-4 py-3 font-semibold text-coral-ink">
                {error}
              </p>
            )}

            <Button type="submit" variant="gradient" size="lg" disabled={!ready} calm>
              {busy ? "Checking…" : "Open my shop"}
            </Button>
            <p data-part="early-access-privacy" className="text-sm text-muted [overflow-wrap:anywhere]">
              {EARLY_ACCESS_PRIVACY}
            </p>
          </Card>

          <Button as="a" variant="outline" size="lg" href={WHATSAPP_LINK} target="_blank" rel="noopener noreferrer">
            <MessageCircle aria-hidden="true" /> Start on WhatsApp
          </Button>
        </div>
      </main>
    </div>
  );
}

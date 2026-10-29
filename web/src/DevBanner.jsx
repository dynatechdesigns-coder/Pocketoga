// A strip across the top while the dev mock is on, so fake numbers can never
// be mistaken for real ones. __MOCK_CONTRACT__ is set by vite.config.js and is
// the constant false in a production build, so this whole file is dropped.
export default function DevBanner() {
  return (
    <p data-part="dev-banner" role="note" className="bg-ink px-4 py-1.5 text-center text-xs font-bold text-page">
      Mock server on: profit, expenses, products and customers are fake (development only)
    </p>
  );
}

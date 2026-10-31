import { useMemo, useState, useSyncExternalStore } from "react";
import { CloudOff, Download } from "lucide-react";
import { getMonthlyCsv } from "./api.js";
import { connection, isOffline } from "./connection.js";
import { lagosToday } from "./format.js";
import { CSV_OFFLINE_MESSAGE, csvError, csvFileName, isMonth, monthOptions } from "./monthlyCsv.js";
import { Button, Card, Field, SectionTitle, inputClass } from "./ui.jsx";

// Hands the file to the browser's download. Nothing is opened in the page and
// nothing is kept: the temporary address is dropped right after.
function saveFile(blob, name) {
  const url = URL.createObjectURL(new Blob([blob], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// "Download this month as a spreadsheet": a month (this one by default, then
// the 12 before it) and one button. Offline, the button is off and says why.
export default function MonthlyDownload() {
  const options = useMemo(() => monthOptions(lagosToday()), []);
  const [month, setMonth] = useState(options[0]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const offline = isOffline(useSyncExternalStore(connection.subscribe, connection.get));

  async function download() {
    if (busy || offline || !isMonth(month)) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      saveFile(await getMonthlyCsv(month), csvFileName(month));
      setDone(csvFileName(month));
    } catch (err) {
      setError(csvError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="section" data-part="monthly-download" aria-labelledby="monthly-title" className="grid min-w-0 gap-3">
      <SectionTitle as="h2" id="monthly-title" className="mt-0">
        Download this month as spreadsheet
      </SectionTitle>
      <Field id="csv-month" label="Month">
        <select
          id="csv-month"
          data-part="csv-month"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setError(null);
            setDone(null);
          }}
          disabled={busy}
          className={`${inputClass} min-w-0`}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Button data-part="csv-download" onClick={download} disabled={busy || offline} aria-describedby={offline ? "csv-offline" : undefined}>
        <Download aria-hidden="true" /> {busy ? "Preparing…" : "Download spreadsheet (CSV)"}
      </Button>
      {offline && (
        <p id="csv-offline" data-part="csv-offline" role="status" className="flex items-start gap-2 text-sm font-semibold text-muted [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
          <CloudOff aria-hidden="true" /> <span className="min-w-0">{CSV_OFFLINE_MESSAGE}</span>
        </p>
      )}
      {error && (
        <p role="alert" data-part="csv-error" className="rounded-2xl bg-slate px-4 py-3 font-semibold [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      {done && (
        <p role="status" data-part="csv-done" className="text-sm font-semibold text-muted [overflow-wrap:anywhere]">
          Saved as {done}.
        </p>
      )}
    </Card>
  );
}

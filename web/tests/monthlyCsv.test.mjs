// Web tests for "Download spreadsheet (CSV)": the month list, the request, the
// offline state, plain errors and that nothing is cached. Fake data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";

const C = await import("../src/monthlyCsv.js");
const { ApiError, getMonthlyCsv, setShop } = await import("../src/api.js");

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const component = src("MonthlyDownload.jsx");

describe("the month list", () => {
  test("this month first, then the 12 before it (13 in all)", () => {
    const list = C.monthOptions("2026-11-01");
    assert.equal(list.length, 13);
    assert.deepEqual(list[0], { value: "2026-11", label: "November 2026 (this month)" });
    assert.equal(list[1].value, "2026-10");
    assert.equal(list[12].value, "2025-11");
  });

  test("goes back across a new year", () => {
    const list = C.monthOptions("2026-02-15");
    assert.deepEqual(list.slice(0, 4).map((o) => o.value), ["2026-02", "2026-01", "2025-12", "2025-11"]);
    assert.equal(list[12].value, "2025-02");
  });

  test("every value is YYYY-MM; a bad date gives no list", () => {
    for (const o of C.monthOptions("2026-11-01")) assert.ok(C.isMonth(o.value));
    assert.deepEqual(C.monthOptions("nonsense"), []);
    assert.equal(C.isMonth("2026-13"), false);
  });
});

describe("the request", () => {
  afterEach(() => setShop(null));

  test("GET /reports/monthly.csv?month=YYYY-MM with the app's sign-in, no cache, and the file comes back as a Blob", async () => {
    setShop("shop-1", "tok-123");
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("date,amount\r\n2026-10-01,100\r\n", { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } });
    };
    try {
      const blob = await getMonthlyCsv("2026-10");
      assert.match(calls[0].url, /\/reports\/monthly\.csv\?month=2026-10$/);
      assert.equal(calls[0].init.method, "GET");
      assert.equal(calls[0].init.cache, "no-store");
      assert.equal(calls[0].init.headers.Authorization, "Bearer tok-123");
      assert.equal(calls[0].init.headers["x-shop-id"], "shop-1");
      assert.match(await blob.text(), /^date,amount/);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("the file is named pocketoga-YYYY-MM.csv", () => {
    assert.equal(C.csvFileName("2026-10"), "pocketoga-2026-10.csv");
    assert.equal(C.csvPath("2026-10"), "/reports/monthly.csv?month=2026-10");
  });

  test("a 400 with { error } throws that message; a lost connection is status 0", async () => {
    setShop("shop-1", "tok");
    const real = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "month must be within the last 12 months" }), { status: 400 });
      await assert.rejects(getMonthlyCsv("2020-01"), (e) => e instanceof ApiError && e.status === 400 && /last 12 months/.test(e.message));
      globalThis.fetch = async () => {
        throw new TypeError("failed");
      };
      await assert.rejects(getMonthlyCsv("2026-10"), (e) => e.status === 0);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("plain errors", () => {
  test("the server's plain message is shown, capitalised", () => {
    assert.equal(C.csvError(new ApiError(400, "pick a month from the last year")), "Pick a month from the last year");
  });

  test("developer words and the app's filler never show", () => {
    for (const [status, m] of [[400, "month_invalid"], [400, "invalid payload: null"], [400, "sqlite error"], [500, "server error 500"], [400, "server error 400"], [502, "bad gateway"]]) {
      assert.equal(C.csvError(new ApiError(status, m)), C.CSV_FAILED_MESSAGE, m);
    }
    assert.equal(C.csvError(new ApiError(0, "network")), C.CSV_NETWORK_MESSAGE);
  });
});

describe("the button on Reports", () => {
  test("a month selector and one button 'Download spreadsheet (CSV)', on the Reports screen", () => {
    assert.match(component, /data-part="csv-month"/);
    assert.match(component, /monthOptions\(lagosToday\(\)\)/);
    assert.match(component, /Download spreadsheet \(CSV\)/);
    assert.match(component, /Download this month as spreadsheet/);
    assert.match(src("screens/ReportScreen.jsx"), /<MonthlyDownload \/>/);
  });

  test("offline: the button is disabled and the plain line shows", () => {
    assert.equal(C.CSV_OFFLINE_MESSAGE, "You need data to download this. Try again when you are back online.");
    assert.match(component, /data-part="csv-download"[^>]*disabled=\{busy \|\| offline\}/);
    assert.match(component, /isOffline\(useSyncExternalStore\(connection\.subscribe, connection\.get\)\)/);
    assert.match(component, /\{CSV_OFFLINE_MESSAGE\}/);
  });

  test("saved as a download, not opened in the page, and nothing is stored", () => {
    assert.match(component, /a\.download = name/);
    assert.match(component, /URL\.revokeObjectURL/);
    assert.doesNotMatch(component, /window\.open|location\.href|localStorage|sessionStorage|indexedDB|caches\./);
    assert.doesNotMatch(src("api.js").slice(src("api.js").indexOf("export async function getMonthlyCsv"), src("api.js").indexOf("// --- Login")), /saveSaved|savedData|caches\./);
  });

  test("the service worker never touches /api, so the CSV is not cached there", () => {
    assert.match(readFileSync(new URL("../sw.template.js", import.meta.url), "utf8"), /pathname\.startsWith\("\/api\/"\)\) return;/);
  });

  test("fits 320px: card and select can shrink; the button is a standard full-width Button (44px or more)", () => {
    assert.match(component, /className="grid min-w-0 gap-3"/);
    assert.match(component, /\$\{inputClass\} min-w-0/);
    assert.match(component, /\[overflow-wrap:anywhere\]/);
    assert.doesNotMatch(component, /\bw-\[\d+/);
  });
});

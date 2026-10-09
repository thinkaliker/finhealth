import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalize, analyze, exportJSON, exportMarkdown, payoffMonths, cdNextMaturity, addMonths, parseDate } from "../public/finhealth.js";

const EXAMPLE = JSON.parse(fs.readFileSync(new URL("../public/example.json", import.meta.url)));
const TODAY = "2026-10-08";
const data = normalize(EXAMPLE);
const A = analyze(data, TODAY);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

function amountsIn(o, out = new Set()) {
  if (Array.isArray(o)) o.forEach(v => amountsIn(v, out));
  else if (o && typeof o === "object") Object.values(o).forEach(v => amountsIn(v, out));
  else if (typeof o === "number" && Math.abs(o) >= 100) out.add(Math.round(Math.abs(o)));
  return out;
}

test("export contains no input or derived currency amounts", () => {
  const amounts = amountsIn(EXAMPLE);
  for (const [k, v] of Object.entries(A.amounts)) if (typeof v === "number") amountsIn(v, amounts);
  amountsIn(A.amounts.cds.map(c => c.balance), amounts);
  for (const text of [exportMarkdown(A), JSON.stringify(exportJSON(A))]) {
    const nums = (text.match(/\d[\d,]*\.?\d*/g) ?? []).map(n => Number(n.replace(/,/g, "")));
    const leaked = nums.filter(n => n >= 100 && n !== 100 && !(n >= 2000 && n < 2100) && [...amounts].some(a => Math.abs(n - a) < 1));
    assert.deepEqual([...new Set(leaked)], [], "possible amount leak");
  }
});

test("core ratios", () => {
  const r = A.ratios, burn = 4350 + 485;
  close(r.expenses_share_of_take_home, 4350 / 6200);
  close(r.liquid_cash_months, (4500 + 7000) / burn);
  // rung 1 matures in 68 days -> full; rung 2 in 250 days -> minus 3 months of interest
  close(r.emergency_fund_months, (4500 + 7000 + 2500 + 2500 - 2500 * 0.045 / 12 * 3) / burn);
  close(r.savings_rate, (1100 + 575 + 287.5) / (6200 + 575 + 287.5));
});

test("payoff months", () => {
  assert.equal(payoffMonths(10000, 0.24, 150), null);
  assert.equal(payoffMonths(1200, 0, 100), 12);
});

test("high-interest debt flagged", () => {
  assert.equal(A.checks.find(c => c.key === "high_interest_debt").status, "act");
});

test("dates: validation and month arithmetic clamp to month end", () => {
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(parseDate("10/01/2025"), null);
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2026-11-15", 3), "2027-02-15");
});

test("CD maturity rolls forward when renewing", () => {
  const cd = { maturity_date: "2025-01-31", term_months: 6, renews: true };
  assert.equal(cdNextMaturity(cd, "2026-10-08"), "2027-01-31");
  assert.equal(cdNextMaturity({ ...cd, term_months: 1 }, "2026-02-10"), "2026-02-28");
  assert.equal(cdNextMaturity({ ...cd, renews: false }, "2026-10-08"), null);
});

test("lapsed CD flagged; bad CD and APR input rejected", () => {
  const d = normalize({ accounts: [{ name: "old", type: "cd", balance: 1000, apr: 0.04, maturity_date: "2025-01-01", term_months: 12, renews: false }] });
  assert.equal(analyze(d, TODAY).checks.find(c => c.key === "cds").status, "watch");
  assert.throws(() => normalize({ accounts: [{ name: "x", type: "cd", balance: 1, maturity_date: "soon" }] }), /maturity_date/);
  assert.throws(() => normalize({ accounts: [{ name: "x", type: "hysa", balance: 1, apr: 4.5 }] }), /fraction/);
});

test("form input is coerced; blank rows dropped; bad allocation rejected", () => {
  const d = normalize({ income: { take_home_monthly: "5000" }, expenses: [{ name: "", amount: 5 }, { name: " rent ", amount: "1" }],
    accounts: [{ name: "a", type: "brokerage", balance: "", allocation: { stocks: 0.7, bonds: 0.3, cash: null } }] });
  assert.equal(d.income.take_home_monthly, 5000);
  assert.deepEqual(d.expenses, [{ name: "rent", amount: 1 }]);
  assert.deepEqual(d.accounts[0].allocation, { stocks: 0.7, bonds: 0.3 });
  assert.throws(() => normalize({ accounts: [{ name: "x", type: "brokerage", balance: 1, allocation: { stocks: 0.5 } }] }), /sums to 0.50/);
  assert.throws(() => normalize({ income: { take_home_monthly: "lots" } }), /expected a number/);
});

test("take-home per biweekly paycheck averages to monthly; export stays amount-free", () => {
  const input = { ...EXAMPLE, income: { take_home_biweekly: 2850, gross_annual: 115000 } };
  const d = normalize(input);
  const B = analyze(d, TODAY);
  close(B.amounts.take_home_monthly, 2850 * 26 / 12);
  close(B.ratios.expenses_share_of_take_home, 4350 / (2850 * 26 / 12));
  assert.ok(B.assumptions.some(a => /biweekly/.test(a)));
  assert.doesNotMatch(exportMarkdown(B), /2,?850|6,?175/);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(d))), d);
  // the key present picks the period, even at zero; a zero monthly alongside is dropped, a real one is an error
  assert.deepEqual(normalize({ income: { take_home_monthly: 0, take_home_biweekly: null } }).income, { take_home_biweekly: 0 });
  assert.throws(() => normalize({ income: { take_home_monthly: 6000, take_home_biweekly: 2800 } }), /not both/);
});

test("expenses accepted as an object too", () => {
  assert.deepEqual(normalize({ expenses: { rent: 100 } }).expenses, [{ name: "rent", amount: 100 }]);
});

test("empty data analyzes without errors", () => {
  const E = analyze(normalize({}), TODAY);
  assert.ok(Array.isArray(E.checks));
  assert.match(exportMarkdown(E), /amount-free/);
});

test("normalize is idempotent (saved files round-trip)", () => {
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(data))), data);
});

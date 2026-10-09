import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalize, analyze, exportJSON, exportMarkdown, payoffMonths, cdNextMaturity, addMonths, parseDate, matchPct, fullMatchAt } from "../public/finhealth.js";

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

function assertNoLeaks(input, R) {
  const amounts = amountsIn(input);
  for (const v of Object.values(R.amounts)) if (typeof v === "number") amountsIn(v, amounts);
  amountsIn(R.amounts.cds.map(c => c.balance), amounts);
  amountsIn(R.amounts.home ?? {}, amounts);
  for (const text of [exportMarkdown(R), JSON.stringify(exportJSON(R))]) {
    const nums = (text.match(/\d[\d,]*\.?\d*/g) ?? []).map(n => Number(n.replace(/,/g, "")));
    const leaked = nums.filter(n => n >= 100 && n !== 100 && !(n >= 2000 && n < 2100) && [...amounts].some(a => Math.abs(n - a) < 1));
    assert.deepEqual([...new Set(leaked)], [], "possible amount leak");
  }
}

test("export contains no input or derived currency amounts", () => assertNoLeaks(EXAMPLE, A));

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

test("taxes withheld = gross - 401k - other deductions - take-home", () => {
  const grossM = 115000 / 12;
  close(A.amounts.taxes_monthly, grossM - 575 - 6200);
  close(A.ratios.taxes_share_of_gross, (grossM - 575 - 6200) / grossM);
  const tc = A.checks.find(c => c.key === "taxes");
  assert.equal(tc.status, "info");
  assert.match(tc.detail, /No other deductions entered/);

  // biweekly paychecks with per-paycheck deductions
  const input = { ...EXAMPLE, income: { take_home_biweekly: 2850, other_deductions_biweekly: 150, gross_annual: 115000 } };
  const B = analyze(normalize(input), TODAY);
  close(B.amounts.other_deductions_monthly, 150 * 26 / 12);
  close(B.amounts.taxes_monthly, grossM - 575 - 150 * 26 / 12 - 2850 * 26 / 12);
  assert.doesNotMatch(B.checks.find(c => c.key === "taxes").detail, /No other deductions/);
  assertNoLeaks(input, B);

  // inconsistent inputs are flagged, missing inputs skip the check
  const bad = analyze(normalize({ income: { take_home_monthly: 5000, gross_annual: 50000 } }), TODAY);
  assert.equal(bad.checks.find(c => c.key === "taxes").status, "watch");
  assert.equal(analyze(normalize({ income: { take_home_monthly: 5000 } }), TODAY).amounts.taxes_monthly, null);
  assert.throws(() => normalize({ income: { other_deductions_monthly: 100, other_deductions_biweekly: 50 } }), /not both/);
});

test("tiered employer match: 100% of the first 4%, 50% of the next 4%, plus a flat 3%", () => {
  const ret = { match_tiers: [{ rate: 1, pct: 0.04 }, { rate: 0.5, pct: 0.04 }], employer_nonelective_pct: 0.03 };
  close(matchPct(ret, 0.03), 0.03);
  close(matchPct(ret, 0.06), 0.04 + 0.01);
  close(matchPct(ret, 0.10), 0.06);
  close(fullMatchAt(ret), 0.08);
  const grossM = 115000 / 12;
  const at = emp => analyze(normalize({ ...EXAMPLE, retirement: { ...ret, employee_contribution_pct: emp } }), TODAY);
  const six = at(0.06);
  close(six.amounts.employer_401k_monthly, (0.05 + 0.03) * grossM);
  close(six.ratios.employer_contribution_share_of_gross, 0.08);
  const mc = six.checks.find(c => c.key === "match");
  assert.equal(mc.status, "act");
  close(mc.value, 0.05 / 0.06);
  assert.match(mc.detail, /Contributing 8% of salary gets the full match \(tiered: 100% of the first 4%, then 50% of the next 4%\)/);
  assert.equal(at(0.08).checks.find(c => c.key === "match").status, "ok");

  // single rate + limit is the one-tier case; the example (50% up to 6%) is unchanged
  close(matchPct(EXAMPLE.retirement, 0.06), 0.03);
  assert.equal(A.checks.find(c => c.key === "match").status, "ok");

  // validation: fractions only, not both forms, blank tiers dropped, round-trips
  assert.throws(() => normalize({ retirement: { match_tiers: [{ rate: 100, pct: 4 }] } }), /fractions/);
  assert.throws(() => normalize({ retirement: { employer_match_rate: 0.5, match_tiers: [{ rate: 1, pct: 0.04 }] } }), /not both/);
  const d = normalize({ retirement: { match_tiers: [{ rate: "1", pct: "0.04" }, { rate: null, pct: null }] } });
  assert.deepEqual(d.retirement.match_tiers, [{ rate: 1, pct: 0.04 }]);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(d))), d);
});

test("home: housing is its own cash-flow line, equity counts in net worth, housing ratios checked", () => {
  const input = { ...EXAMPLE, expenses: EXAMPLE.expenses.filter(e => e.name !== "housing"),
    home: { value: 420000, mortgage_balance: 310000, mortgage_apr: 0.0625, mortgage_payment: 1910, costs_monthly: 520 } };
  const d = normalize(input), H = analyze(d, TODAY), grossM = 115000 / 12, burn = 2250 + 485 + 2430;
  close(H.amounts.surplus_monthly, 6200 - burn);
  close(H.amounts.net_worth, A.amounts.net_worth + 110000);
  close(H.amounts.investable, A.amounts.investable);
  close(H.ratios.emergency_fund_months, (4500 + 7000 + 2500 + 2500 - 2500 * 0.045 / 12 * 3) / burn);
  close(H.ratios.home.housing_to_gross, 2430 / grossM);
  close(H.ratios.home.total_debt_payments_to_gross, (2430 + 485) / grossM);
  close(H.ratios.home.loan_to_value, 310000 / 420000);
  assert.equal(H.ratios.home.mortgage_months_to_payoff, 360);
  const st = Object.fromEntries(H.checks.map(c => [c.key, c.status]));
  assert.deepEqual([st.housing, st.dti_total, st.home_equity], ["ok", "ok", "ok"]);
  assert.match(H.checks.find(c => c.key === "dti").label, /excluding housing/);
  assert.match(exportMarkdown(H), /## Home[\s\S]*payoff at current payment: 30\.0 years/);
  assertNoLeaks(input, H);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(d))), d);
});

test("home: renters unaffected; double-listed mortgage flagged; bad rate rejected", () => {
  assert.equal(A.ratios.home, null);
  assert.equal(A.amounts.home, null);
  assert.ok(!A.checks.some(c => ["housing", "dti_total", "home_equity"].includes(c.key)));
  const R = analyze(normalize({ home: { value: 300000, mortgage_balance: 0 }, debts: [{ name: "Mortgage", balance: 1, apr: 0.06, min_payment: 1 }] }), TODAY);
  assert.ok(R.assumptions.some(a => /Mortgage .*counted twice/.test(a)));
  assert.equal(R.checks.find(c => c.key === "home_equity").detail, "No mortgage; the home is owned outright.");
  assert.throws(() => normalize({ home: { mortgage_apr: 6.5 } }), /fraction/);
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

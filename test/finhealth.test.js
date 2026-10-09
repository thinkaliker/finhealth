import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalize, analyze, exportJSON, exportMarkdown, payoffMonths, cdNextMaturity, addMonths, parseDate, matchPct, fullMatchAt, fiPlan, moneyFormat, reportText, formatAmount, parseAmount } from "../public/finhealth.js";

const EXAMPLE = JSON.parse(fs.readFileSync(new URL("../public/example.json", import.meta.url)));
const TODAY = "2026-10-08";
const data = normalize(EXAMPLE);
const A = analyze(data, TODAY);
// the example with person 1's income or retirement replaced
const withPay = (income, retirement) => ({ ...EXAMPLE, people: [{ ...EXAMPLE.people[0], ...(income && { income }), ...(retirement && { retirement }) }] });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const NOT_AMOUNTS = new Set(["months_to_payoff", "apr"]); // counts and rates that sit next to amounts
function amountsIn(o, out = new Set()) {
  if (Array.isArray(o)) o.forEach(v => amountsIn(v, out));
  else if (o && typeof o === "object") Object.entries(o).forEach(([k, v]) => NOT_AMOUNTS.has(k) || amountsIn(v, out));
  else if (typeof o === "number" && Math.abs(o) >= 100) out.add(Math.round(Math.abs(o)));
  return out;
}

function assertNoLeaks(input, R) {
  const amounts = amountsIn(input);
  for (const v of Object.values(R.amounts)) if (typeof v === "number") amountsIn(v, amounts);
  amountsIn(R.amounts.cds.map(c => c.balance), amounts);
  amountsIn(R.amounts.real_estate ?? {}, amounts);
  for (const text of [exportMarkdown(R), JSON.stringify(exportJSON(R))]) {
    const nums = (text.match(/\d[\d,]*\.?\d*/g) ?? []).map(n => Number(n.replace(/,/g, "")));
    const leaked = nums.filter(n => n >= 100 && n !== 100 && !(n >= 2000 && n < 2100) && [...amounts].some(a => Math.abs(n - a) < 1));
    assert.deepEqual([...new Set(leaked)], [], "possible amount leak");
  }
}

test("export contains no input or derived currency amounts", () => assertNoLeaks(EXAMPLE, A));

test("core ratios", () => {
  const r = A.ratios, burn = 4350 + 485;
  close(r.expenses_share_of_income, 4350 / 6200);
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
  assert.equal(d.people[0].income.take_home_monthly, 5000);
  assert.deepEqual(d.expenses, [{ name: "rent", amount: 1 }]);
  assert.deepEqual(d.accounts[0].allocation, { stocks: 0.7, bonds: 0.3 });
  assert.throws(() => normalize({ accounts: [{ name: "x", type: "brokerage", balance: 1, allocation: { stocks: 0.5 } }] }), /sums to 0.50/);
  assert.throws(() => normalize({ income: { take_home_monthly: "lots" } }), /expected a number/);
});

test("take-home per biweekly paycheck averages to monthly; export stays amount-free", () => {
  const input = withPay({ take_home_biweekly: 2850, gross_annual: 115000 });
  const d = normalize(input);
  const B = analyze(d, TODAY);
  close(B.amounts.take_home_monthly, 2850 * 26 / 12);
  close(B.ratios.expenses_share_of_income, 4350 / (2850 * 26 / 12));
  assert.ok(B.assumptions.some(a => /biweekly/.test(a)));
  assert.doesNotMatch(exportMarkdown(B), /2,?850|6,?175/);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(d))), d);
  // the key present picks the period, even at zero; a zero monthly alongside is dropped, a real one is an error
  assert.deepEqual(normalize({ income: { take_home_monthly: 0, take_home_biweekly: null } }).people[0].income, { take_home_biweekly: 0 });
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
  const input = withPay({ take_home_biweekly: 2850, other_deductions_biweekly: 150, gross_annual: 115000 });
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
  const at = emp => analyze(normalize(withPay(null, { ...ret, employee_contribution_pct: emp })), TODAY);
  const six = at(0.06);
  close(six.amounts.employer_401k_monthly, (0.05 + 0.03) * grossM);
  close(six.ratios.employer_contribution_share_of_gross, 0.08);
  const mc = six.checks.find(c => c.key === "match");
  assert.equal(mc.status, "act");
  close(mc.value, 0.05 / 0.06);
  assert.match(mc.detail, /Contributing 8% of salary gets the full match \(tiered: 100% of the first 4%, then 50% of the next 4%\)/);
  assert.equal(at(0.08).checks.find(c => c.key === "match").status, "ok");

  // single rate + limit is the one-tier case; the example (50% up to 6%) is unchanged
  close(matchPct(EXAMPLE.people[0].retirement, 0.06), 0.03);
  assert.equal(A.checks.find(c => c.key === "match").status, "ok");

  // validation: fractions only, not both forms, blank tiers dropped, round-trips
  assert.throws(() => normalize({ retirement: { match_tiers: [{ rate: 100, pct: 4 }] } }), /fractions/);
  assert.throws(() => normalize({ retirement: { employer_match_rate: 0.5, match_tiers: [{ rate: 1, pct: 0.04 }] } }), /not both/);
  const d = normalize({ retirement: { match_tiers: [{ rate: "1", pct: "0.04" }, { rate: null, pct: null }] } });
  assert.deepEqual(d.people[0].retirement.match_tiers, [{ rate: 1, pct: 0.04 }]);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(d))), d);
});

test("FI plan: adjustable withdrawal rate and return; take-home after you stop working", () => {
  const base = { investable: 1_000_000, annual_contrib: 0, annual_spend: 40_000, tax_deferred_share: 0.5, age: 40 };
  const now = fiPlan(base, { retire_in_years: 0 });
  close(now.target, 1_000_000);
  assert.equal(now.years_to_fi, 0);
  close(now.at_retirement.monthly_before_tax, 40_000 / 12);
  close(now.at_retirement.monthly_after_tax, 40_000 / 12 * (1 - 0.5 * 0.10)); // only the tax-deferred half is taxed
  close(now.at_retirement.share_of_spending, 0.95);
  assert.equal(now.at_retirement.lasts_years, null); // 4% at 5% real lasts the whole 30 years
  assert.equal(now.projection.length, 31);
  // 6% a year at 0% return: 16 full withdrawals of 60k from 1M
  assert.equal(fiPlan(base, { retire_in_years: 0, withdrawal_rate: 0.06, real_return: 0 }).at_retirement.lasts_years, 16);
  close(fiPlan(base, { withdrawal_rate: 0.035 }).target, 40_000 / 0.035);

  // contributions stop when you stop working; retirement defaults to the year the target is reached
  const grow = { ...base, investable: 100_000, annual_contrib: 30_000 };
  const auto = fiPlan(grow, {});
  assert.ok(auto.years_to_fi > 0 && auto.settings.retire_in_years === auto.years_to_fi);
  const early = fiPlan(grow, { retire_in_years: 5 }), p = early.projection, start = early.at_retirement.balance;
  assert.equal(p[5].investable, Math.round(start));
  assert.ok(Math.abs(p[6].investable - start * 0.96 * 1.05) <= 1, "year after: 4% withdrawn, then 5% growth, no contribution");
  assert.ok(fiPlan(grow, { withdrawal_rate: 0.03 }).years_to_fi > auto.years_to_fi);
  assert.equal(fiPlan({ ...grow, annual_contrib: 0 }, {}).settings.retire_in_years, 25); // not reached: stop at 65

  // example data with defaults: 25x spending, same contributions as before
  const ap = A.amounts.fi_plan;
  close(ap.target, (4350 + 485) * 12 * 25);
  close(A.ratios.fi_progress, A.amounts.investable / ap.target);
  assert.equal(A.ratios.retirement.stop_working_in_years, A.ratios.years_to_fi);
  assert.match(exportMarkdown(A), /## Retirement plan[\s\S]*withdrawal rate 4% \(target 25x annual spending\)/);

  // settings are validated, saved files round-trip, and the export stays amount-free with custom settings
  assert.throws(() => normalize({ fi: { withdrawal_rate: 4 } }), /fi.withdrawal_rate/);
  assert.equal(normalize({ fi: {} }).fi, undefined);
  const input = { ...EXAMPLE, fi: { withdrawal_rate: 0.035, real_return: 0.04, retire_in_years: 12.4, retirement_tax_rate: 0.15 } };
  const d = normalize(input), C = analyze(d, TODAY);
  assert.equal(d.fi.retire_in_years, 12);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(d))), d);
  assert.equal(C.ratios.retirement.stop_working_in_years, 12);
  assertNoLeaks(input, C);
});

test("currency: formatting, validation, default USD, CLI report", () => {
  const usd = moneyFormat("USD", "en-US");
  assert.equal(usd.money(1234.4), "$1,234");
  assert.equal(usd.money(-5), "−$5");
  assert.equal(usd.money(-0.4), "$0");
  assert.equal(usd.short(1_250_000), "$1.3M");
  assert.equal(usd.symbol, "$");
  assert.equal(moneyFormat("EUR", "en-US").money(1234), "€1,234");
  assert.equal(moneyFormat("none", "en-US").money(1234), "1,234");
  assert.equal(moneyFormat("none", "en-US").symbol, "");
  assert.equal(normalize({ currency: " eur " }).currency, "EUR");
  assert.equal(normalize({ currency: "None" }).currency, "none");
  assert.throws(() => normalize({ currency: "dollars" }), /3-letter code/);
  assert.equal(A.currency, "USD");
  assert.match(reportText(A), /take_home_monthly\s+\$6,200/);
  assert.match(reportText(analyze(normalize({ ...EXAMPLE, currency: "GBP" }), TODAY)), /take_home_monthly\s+£6,200/);
  assert.doesNotMatch(exportMarkdown(A), /\$/); // the LLM export stays amount-free
});

test("money inputs: grouped display and parsing follow the currency's convention", () => {
  const cases = [ // [currency, typed, parsed, shown after leaving the field]
    ["USD", "98,000.50", 98000.5, "98,000.50"], ["USD", "$1,234", 1234, "1,234"], ["USD", "-5,000", -5000, "-5,000"],
    ["EUR", "98.000,50", 98000.5, "98.000,50"], ["EUR", "98,000", 98, "98"],
    ["CHF", "1’234.5", 1234.5, null], ["CHF", "1'234.5", 1234.5, null],
    ["INR", "1,23,456", 123456, "1,23,456"], ["SEK", "1 234,5", 1234.5, null], ["JPY", "1,000", 1000, "1,000"],
  ];
  for (const [cur, typed, n, shown] of cases) {
    assert.equal(parseAmount(typed, cur), n, `${cur} ${typed}`);
    if (shown) assert.equal(formatAmount(n, cur), shown, `${cur} ${n}`);
    assert.equal(parseAmount(formatAmount(n, cur), cur), n, `${cur} round-trip`); // whatever we show parses back
  }
  assert.equal(parseAmount("", "USD"), null);
  assert.equal(parseAmount("-", "USD"), null); // mid-typing a negative
  assert.equal(parseAmount("abc", "USD"), "abc"); // left for normalize() to report
  assert.throws(() => normalize({ income: { gross_annual: parseAmount("abc", "USD") } }), /expected a number/);
  assert.equal(formatAmount(null, "USD"), "");
  // results follow the same convention, including where the symbol goes
  const eur = moneyFormat("EUR");
  assert.equal(eur.money(1234), "1.234 €");
  assert.equal(eur.symbolAfter, true);
  assert.equal(moneyFormat("USD").symbolAfter, false);
});

test("real estate: an older single home converts to one residence and keeps its results", () => {
  const input = { ...EXAMPLE, expenses: EXAMPLE.expenses.filter(e => e.name !== "housing"),
    home: { value: 420000, mortgage_balance: 310000, mortgage_apr: 0.0625, mortgage_payment: 1910, costs_monthly: 520 } };
  const d = normalize(input), H = analyze(d, TODAY), grossM = 115000 / 12, burn = 2250 + 485 + 2430;
  assert.deepEqual(d.properties, [{ name: "Home", residence: true, value: 420000, costs_monthly: 520,
    loans: [{ name: "Mortgage", balance: 310000, apr: 0.0625, payment: 1910 }] }]);
  assert.equal(d.home, undefined);
  close(H.amounts.surplus_monthly, 6200 - burn);
  close(H.amounts.net_worth, A.amounts.net_worth + 110000);
  close(H.amounts.investable, A.amounts.investable);
  close(H.ratios.emergency_fund_months, (4500 + 7000 + 2500 + 2500 - 2500 * 0.045 / 12 * 3) / burn);
  close(H.ratios.real_estate.housing_to_gross, 2430 / grossM);
  close(H.ratios.real_estate.total_debt_payments_to_gross, (2430 + 485) / grossM);
  close(H.ratios.real_estate.properties[0].loan_to_value, 310000 / 420000);
  assert.equal(H.ratios.real_estate.properties[0].loans[0].months_to_payoff, 360);
  const st = Object.fromEntries(H.checks.map(c => [c.key, c.status]));
  assert.deepEqual([st.housing, st.dti_total, st.home_equity], ["ok", "ok", "ok"]);
  assert.match(H.checks.find(c => c.key === "dti").label, /excluding housing/);
  assert.match(H.checks.find(c => c.key === "home_equity").detail, /it is paid off in 30\.0 years/);
  assert.match(exportMarkdown(H), /## Real estate[\s\S]*Home \(lives here\): loan-to-value 74%; Mortgage at 6\.25%, payoff at current payment 30\.0 years/);
  assertNoLeaks(input, H);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(d))), d);
  assert.throws(() => normalize({ home: { value: 1 }, properties: [] }), /not both/);
});

test("real estate: a HELOC on the home plus a rental, with rent as other income", () => {
  const input = { ...EXAMPLE, expenses: EXAMPLE.expenses.filter(e => e.name !== "housing"),
    properties: [
      { name: "Home", residence: true, value: 420000, costs_monthly: 520, loans: [
        { name: "Mortgage", balance: 310000, apr: 0.0625, payment: 1910 }, { name: "HELOC", balance: 30000, apr: 0.085, payment: 400 }] },
      { name: "Rental", residence: false, value: 300000, costs_monthly: 400, loans: [{ name: "Mortgage", balance: 200000, apr: 0.07, payment: 1500 }] }],
    other_income: [{ name: "Rent", amount: 2200, continues: true }, { name: "Tutoring", amount: 300 }, { name: "", amount: 50 }] };
  const d = normalize(input), R = analyze(d, TODAY);
  assert.deepEqual(d.other_income, [{ name: "Rent", amount: 2200, continues: true }, { name: "Tutoring", amount: 300, continues: false }]);
  const income = 6200 + 2500, grossInc = 115000 / 12 + 2500, homeOut = 1910 + 400 + 520, rentalOut = 1500 + 400;
  close(R.amounts.income_monthly, income);
  close(R.amounts.surplus_monthly, income - 2250 - 485 - homeOut - rentalOut);
  close(R.amounts.net_worth, A.amounts.net_worth + (420000 - 340000) + (300000 - 200000));
  close(R.ratios.real_estate.housing_to_gross, homeOut / grossInc);                     // only where you live
  close(R.ratios.real_estate.total_debt_payments_to_gross, (homeOut + rentalOut + 485) / grossInc); // every loan
  close(R.ratios.expenses_share_of_income, 2250 / income);
  close(R.ratios.other_income_share_of_income, 2500 / income);
  close(R.checks.find(c => c.key === "home_equity").value, 1 - 340000 / 420000);
  assert.match(R.checks.find(c => c.key === "home_equity").detail, /the last loan is paid off/);
  // rent keeps paying after you stop working: it shrinks the target and adds to take-home then
  const spendYear = (2250 + 485 + homeOut + rentalOut) * 12;
  close(R.amounts.fi_plan.target, (spendYear - 2200 * 12) / 0.04);
  close(R.amounts.fi_plan.at_retirement.monthly_take_home, R.amounts.fi_plan.at_retirement.monthly_after_tax + 2200);
  assert.match(exportMarkdown(R), /Rental \(not lived in\)[\s\S]*other income \(e\.g\. rent\) share of income|other income \(e\.g\. rent\) share of income[\s\S]*Rental \(not lived in\)/);
  assertNoLeaks(input, R);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(d))), d);
  assert.match(reportText(R), /other_income_monthly\s+\$2,500[\s\S]*property_loans\s+\$540,000/);
  // a rental with no rent listed is pointed out; bad loan rates are rejected
  assert.ok(analyze(normalize({ properties: [{ name: "Cabin", value: 1 }] }), TODAY).assumptions.some(a => /no rent listed/.test(a)));
  assert.throws(() => normalize({ properties: [{ name: "X", loans: [{ apr: 6.5 }] }] }), /fraction/);
});

test("household: two earners add up; taxes and match are checked per person; names stay out of the export", () => {
  const sam = { name: "Sam", age: 32, income: { take_home_biweekly: 2000, gross_annual: 70000 },
    retirement: { employee_contribution_pct: 0.03, match_tiers: [{ rate: 1, pct: 0.04 }] } };
  const input = { ...EXAMPLE, people: [{ ...EXAMPLE.people[0], name: "Alex" }, sam] };
  const d = normalize(input), H = analyze(d, TODAY);
  const samTake = 2000 * 26 / 12, samGross = 70000 / 12, alexGross = 115000 / 12;
  close(H.amounts.take_home_monthly, 6200 + samTake);
  close(H.amounts.gross_monthly, alexGross + samGross);
  close(H.amounts.employee_401k_monthly, 0.06 * alexGross + 0.03 * samGross);
  close(H.amounts.employer_401k_monthly, 0.03 * alexGross + 0.03 * samGross);
  close(H.amounts.taxes_monthly, (alexGross - 575 - 6200) + (samGross - 0.03 * samGross - samTake));
  close(H.amounts.surplus_monthly, 6200 + samTake - 4350 - 485);
  close(H.ratios.debt_to_income, 485 / (alexGross + samGross));
  const per = k => H.checks.filter(c => c.key === k).map(c => [c.person, c.status]);
  assert.deepEqual(per("match"), [[0, "ok"], [1, "act"]]);
  assert.deepEqual(per("taxes"), [[0, "info"], [1, "info"]]);
  assert.equal(H.checks.find(c => c.key === "savings_rate").person, undefined); // household checks have no person
  close(H.ratios.people[1].share_of_household_take_home, samTake / (6200 + samTake));
  assert.deepEqual(H.amounts.fi_base.ages, [34, 32]);
  const md = exportMarkdown(H);
  assert.match(md, /Employer match captured \(person 2\) \| ACT/);
  assert.match(md, /## Household[\s\S]*- person 2: 41% of household take-home/);
  assert.doesNotMatch(md + JSON.stringify(exportJSON(H)), /Alex|Sam/);
  assert.match(reportText(H), /Sam: take-home\s+\$4,333/);
  assertNoLeaks(input, H);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(d))), d);
  // errors name the person when there are several
  assert.throws(() => normalize({ people: [{ name: "Alex" }, { name: "Sam", income: { gross_annual: "lots" } }] }), /^Error: Sam: income\.gross_annual/);
});

test("household: older files with top-level income, 401(k), and age become person 1", () => {
  const old = { profile: { age: 40 }, income: { take_home_monthly: 5000 }, retirement: { employee_contribution_pct: 0.05 } };
  const d = normalize(old);
  assert.deepEqual(d.people, [{ name: "", age: 40, income: { take_home_monthly: 5000 }, retirement: { employee_contribution_pct: 0.05 } }]);
  assert.equal(d.income, undefined);
  assert.equal(d.profile, undefined);
  assert.throws(() => normalize({ ...old, people: [] }), /not both/);
  assert.equal(analyze(normalize({}), TODAY).amounts.people.length, 0); // nobody entered yet still analyzes
});

test("FI: income that continues can cover all spending", () => {
  const R = analyze(normalize({ expenses: [{ name: "all", amount: 3000 }], other_income: [{ name: "Pension", amount: 3500, continues: true }] }), TODAY);
  assert.equal(R.amounts.fi_plan.target, 0);
  assert.equal(R.ratios.years_to_fi, 0);
  assert.equal(R.ratios.fi_progress, 1);
});

test("real estate: renters unaffected; double-listed mortgage flagged; bad rate rejected", () => {
  assert.equal(A.ratios.real_estate, null);
  assert.equal(A.amounts.real_estate, null);
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

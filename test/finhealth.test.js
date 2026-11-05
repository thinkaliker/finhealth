import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalize, analyze, exportJSON, exportMarkdown, payoffMonths, cdNextMaturity, addMonths, parseDate, matchPct, fullMatchAt, fiPlan, moneyFormat, reportText, formatAmount, parseAmount,
  bracketTax, bracketRate, taxYear, k401Limits, STATES } from "../public/finhealth.js";

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
  amountsIn(R.amounts.people, amounts); // pay, 401(k) flows, limits, and the pre-tax / Roth comparison
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
  assert.match(mc.detail, /Contributing 8% of salary \(pre-tax plus Roth\) gets the full match \(tiered: 100% of the first 4%, then 50% of the next 4%\)/);
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
  assert.deepEqual(d.people, [{ name: "", age: 40, income: { take_home_monthly: 5000 }, retirement: { pretax_pct: 0.05 } }]); // one contribution was pre-tax
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

test("growth: today's computed values are the last point and are marked as not a snapshot", () => {
  const pts = A.growth.points;
  assert.equal(pts.at(-1).date, TODAY);
  assert.equal(pts.at(-1).current, true);
  assert.ok(pts.slice(0, -1).every(p => !p.current));
  assert.equal(exportJSON(A).growth.points.at(-1).current, true);
  assert.match(exportMarkdown(A), new RegExp(`\\| ${TODAY} \\(today\\) \\|`));
});

test("growth: yearly rates only once the points span a calendar year", () => {
  assert.ok(A.growth.net_worth_cagr != null && A.growth.trend, "example spans two years");
  assert.equal(A.growth.rates_note, undefined);
  // snapshots on these dates (plus today's values as the last point)
  const since = (dates, today) => analyze(normalize({ ...EXAMPLE,
    history: dates.map((date, i) => ({ date, net_worth: 50000 + 5000 * i, investable: 40000 + 5000 * i })) }), today).growth;
  for (const [dates, today] of [[["2025-10-08"], TODAY], [["2024-02-29"], "2025-02-28"], [["2025-10-08", "2026-01-15"], TODAY]]) {
    const g = since(dates, today);
    assert.ok(g.net_worth_cagr != null && g.investable_cagr != null, `${dates[0]} to ${today} is a year`);
  }
  assert.ok(since(["2025-10-08", "2026-01-15"], TODAY).trend, "three points over a year: half-period rates and trend");
  for (const [dates, today] of [[["2025-10-09"], TODAY], [["2026-09-10"], TODAY], [["2024-03-01"], "2025-02-28"], [["2025-10-09", "2026-01-15"], TODAY]]) {
    const g = since(dates, today);
    for (const k of ["net_worth_cagr", "investable_cagr", "first_half_cagr", "second_half_cagr", "trend"]) assert.equal(g[k], undefined, `${dates[0]} to ${today}: ${k}`);
    assert.match(g.rates_note, /left out until the points span at least a year/);
  }
  const md = exportMarkdown(analyze(normalize({ ...EXAMPLE, history: [{ date: "2026-09-10", net_worth: 50000, investable: 40000 }] }), TODAY));
  assert.doesNotMatch(md, /cagr/);
  assert.match(md, /- Yearly growth rates are left out until the points span at least a year\./);
});

// ---------------------------------------------------------------- 401(k) split, income tax, limits
const FIG = taxYear("2026-06-01");
// Massachusetts: a flat 5%, so state tax changes are simple to check
const earner = (retirement, extra = {}) => ({ people: [{ age: 35, income: { gross_annual: 120000, take_home_monthly: 6000 },
  retirement: { employer_match_rate: 0.5, employer_match_limit_pct: 0.06, ...retirement } }], tax: { filing_status: "single", state: "MA" }, ...extra });

test("income tax: 2026 brackets match the IRS rate tables (Rev. Proc. 2025-32)", () => {
  // tax at the top of a bracket, as printed in the tables
  const at = { married_joint: [[100800, 11600], [211400, 35932], [768700, 206583.5]], head_of_household: [[67450, 7740], [105700, 16155], [640600, 191171]],
    single: [[50400, 5800], [201775, 41024], [640600, 192979.25]], married_separate: [[105700, 17966], [384350, 103291.75]] };
  for (const [status, rows] of Object.entries(at)) for (const [income, tax] of rows) close(bracketTax(income, FIG.federal.brackets[status]), tax);
  assert.equal(bracketRate(96700, FIG.federal.brackets.single), 0.22);
  assert.equal(bracketRate(105700, FIG.federal.brackets.single), 0.24); // the next dollar is in the 24% bracket
  assert.equal(bracketTax(0, FIG.federal.brackets.single), 0);
  assert.deepEqual(k401Limits(35, FIG), { year: 2026, deferral: 24500, total: 72000, catch_up: 0 });
  assert.equal(k401Limits(50, FIG).deferral, 32500);
  assert.equal(k401Limits(61, FIG).deferral, 35750);
  assert.equal(k401Limits(64, FIG).deferral, 32500);
  assert.equal(taxYear("2027-03-01").year, 2026); // no 2027 figures yet: the latest year on file
});

test("401(k) split: older single contribution is pre-tax; validation; paycheck split kept only when different", () => {
  assert.deepEqual(normalize({ retirement: { employee_contribution_pct: 0.08 } }).people[0].retirement, { pretax_pct: 0.08 });
  assert.throws(() => normalize({ retirement: { employee_contribution_pct: 0.08, roth_pct: 0.02 } }), /not both/);
  assert.throws(() => normalize({ retirement: { pretax_pct: 6 } }), /fractions of gross pay/);
  assert.throws(() => normalize({ retirement: { pretax_pct: 0.6, after_tax_pct: 0.5 } }), /at most 1/);
  const same = normalize(earner({ pretax_pct: 0.06, paycheck: { pretax_pct: 0.06, roth_pct: 0, after_tax_pct: 0 } }));
  assert.equal(same.people[0].retirement.paycheck, undefined);
  const diff = normalize(earner({ roth_pct: 0.06, match_after_tax: true, paycheck: { pretax_pct: 0.06 } }));
  assert.deepEqual(diff.people[0].retirement.paycheck, { pretax_pct: 0.06, roth_pct: 0, after_tax_pct: 0 });
  assert.equal(diff.people[0].retirement.match_after_tax, true);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(diff))), diff);
  assert.throws(() => normalize({ tax: { filing_status: "joint" } }), /filing_status/);
  assert.throws(() => normalize({ tax: { state: "XX" } }), /tax.state/);
  assert.deepEqual(normalize({ tax: { state: " ca " } }).tax, { state: "CA" });
  assert.equal(normalize({ tax: { state: "" } }).tax, undefined);
});

test("401(k) split: match basis, what-if take-home, and the pre-tax / Roth comparison", () => {
  const A1 = analyze(normalize(earner({ pretax_pct: 0.06, roth_pct: 0.02 })), TODAY), p = A1.amounts.people[0], k = p.k401;
  close(p.employee_401k, 0.08 * 10000);
  close(p.employer_401k, 0.03 * 10000); // 50% match up to 6%; pre-tax + Roth = 8%
  // taxable 120,000 x 0.94 - 16,100 = 96,700: 22% federal + 5% state
  assert.deepEqual(k.marginal, { federal: 0.22, state: 0.05, now: 0.27, state_taxes_pretax: false });
  assert.equal(k.favored, "pre-tax"); // 27% now vs 10% assumed on withdrawals
  const [mine, pre, roth] = k.scenarios;
  assert.deepEqual([mine.label, pre.label, roth.label], ["Your split", "All pre-tax", "All Roth"]);
  close(mine.take_home_monthly, 6000);
  close(pre.take_home_monthly, 6000 + 2400 * 0.27 / 12);
  close(roth.take_home_monthly, 6000 - 7200 * 0.27 / 12);
  close(roth.tax_now_change_annual, 7200 * 0.27);
  assert.ok(roth.at_withdrawal.after_tax > pre.at_withdrawal.after_tax);
  const c = A1.checks.find(x => x.key === "k401_tax");
  assert.equal(c.value, 0.27);

  // what-if: all Roth while the paycheck has 6% pre-tax + 2% Roth; take-home and taxes withheld follow
  const W = analyze(normalize(earner({ roth_pct: 0.08, paycheck: { pretax_pct: 0.06, roth_pct: 0.02 } })), TODAY).amounts.people[0];
  close(W.take_home, 6000 - 7200 * 0.27 / 12);
  assert.equal(W.take_home_entered, 6000);
  close(W.taxes, 10000 - 800 - W.take_home);

  // after-tax money counts toward the match only when the plan says so
  const at = mt => analyze(normalize(earner({ pretax_pct: 0.02, after_tax_pct: 0.04, match_after_tax: mt })), TODAY).amounts.people[0].employer_401k;
  close(at(false), 0.01 * 10000);
  close(at(true), 0.03 * 10000);
});

test("401(k) limits: catch-up, when contributions stop, and the even percentage", () => {
  const over = earner({ pretax_pct: 0.15, roth_pct: 0.05, after_tax_pct: 0.3, match_after_tax: true });
  over.people[0].age = 61; over.people[0].income.gross_annual = 200000;
  const A2 = analyze(normalize(over), TODAY), k = A2.amounts.people[0].k401;
  assert.deepEqual(k.limits, { year: 2026, deferral: 35750, total: 83250, catch_up: 11250 });
  close(k.deferral_stop_month, 12 * 35750 / 40000);
  close(k.even_deferral_pct, 35750 / 200000);
  close(k.after_tax_stop_month, 12 * 83250 / (40000 + 60000 + 6000)); // everything in reaches the total limit first
  const c = A2.checks.find(x => x.key === "k401_limit");
  assert.deepEqual([c.status, c.value, c.value_text], ["act", null, "Over"]);
  const under = analyze(normalize(earner({ pretax_pct: 0.06 })), TODAY).checks.find(x => x.key === "k401_limit");
  assert.deepEqual([under.status, under.value_text], ["ok", "Under"]);

  // married filing jointly: one bracket for the couple's combined taxable income
  const two = { people: [earner({ pretax_pct: 0.1 }).people[0], { ...earner({ roth_pct: 0.05 }).people[0], name: "B" }], tax: { filing_status: "married_joint" } };
  const [k1, k2] = analyze(normalize(two), TODAY).amounts.people.map(x => x.k401);
  assert.equal(k1.marginal.federal, 0.22); // 120,000 x 0.9 + 120,000 - 32,200 = 195,800
  assert.equal(k2.marginal.federal, 0.22);

  // outside USD there are no US limits or brackets
  assert.equal(analyze(normalize({ ...earner({ pretax_pct: 0.06 }), currency: "EUR" }), TODAY).amounts.people[0].k401, undefined);
});

test("tax tables: every state and DC, brackets in order, federal for each filing status", () => {
  assert.equal(STATES.length, 51);
  assert.deepEqual(Object.keys(FIG.federal.brackets).sort(), ["head_of_household", "married_joint", "married_separate", "single"]);
  for (const [code, s] of Object.entries(FIG.states)) {
    assert.match(code, /^[A-Z]{2}$/);
    for (const b of s.brackets ? [s.brackets.single, s.brackets.married_joint] : []) {
      assert.equal(b[0][0], 0, `${code} starts at 0`);
      b.forEach(([from, rate], i) => assert.ok(rate >= 0 && rate < 0.15 && (i === 0 || from > b[i - 1][0]), `${code} bracket ${i}`));
    }
  }
  assert.deepEqual(["AK", "FL", "NV", "NH", "SD", "TN", "TX", "WA", "WY"], Object.keys(FIG.states).filter(c => !FIG.states[c].brackets));
});

test("state income tax: brackets, standard deduction, joint returns, and a state that taxes pre-tax 401(k)", () => {
  const k = (state, ret = { pretax_pct: 0.06, roth_pct: 0.02 }, extra) =>
    analyze(normalize(earner(ret, { tax: { filing_status: "single", state }, ...extra })), TODAY).amounts.people[0].k401;
  // California: 120,000 x 0.94 - 5,540 = 107,260, in the 9.3% bracket
  assert.deepEqual(k("CA").marginal, { federal: 0.22, state: 0.093, now: 0.22 + 0.093, state_taxes_pretax: false });
  assert.equal(k("TX").marginal.state, 0);
  assert.equal(k(undefined).marginal.state, 0);
  // Pennsylvania taxes pre-tax contributions: moving them to Roth changes federal tax only
  const pa = k("PA");
  assert.deepEqual(pa.marginal, { federal: 0.22, state: 0.0307, now: 0.22, state_taxes_pretax: true });
  close(pa.scenarios.find(x => x.label === "All Roth").tax_now_change_annual, 7200 * 0.22);
  // New Jersey, married filing jointly: the couple's combined state income, on the joint brackets
  const two = { people: [earner({ pretax_pct: 0.1 }).people[0], { ...earner({ roth_pct: 0.05 }).people[0], name: "B" }],
    tax: { filing_status: "married_joint", state: "NJ" } };
  const [k1, k2] = analyze(normalize(two), TODAY).amounts.people.map(x => x.k401);
  assert.equal(k1.marginal.state, 0.0637); // 120,000 x 0.9 + 120,000 - 2,000 exemption = 226,000: over 150,000 on the joint brackets
  assert.equal(k2.marginal.state, 0.0637);
  const md = exportMarkdown(analyze(normalize(earner({ pretax_pct: 0.06 }, { tax: { state: "PA" } })), TODAY));
  assert.match(md, /3\.07% state \(pre-tax contributions don't lower the state part\)/);
  assert.doesNotMatch(md, /Pennsylvania/); // the state's name stays local
});

test("401(k) export: split and rates only; limits as under / near / over; no amounts", () => {
  // 18% of 130,000 is 95.5% of the deferral limit; taxable 130,000 x 0.87 - 16,100 = 96,999 (22%)
  const near = earner({ pretax_pct: 0.13, roth_pct: 0.05, after_tax_pct: 0.1 });
  near.people[0].income.gross_annual = 130000;
  near.people[0].retirement.paycheck = { pretax_pct: 0.18 };
  const R = analyze(normalize(near), TODAY), md = exportMarkdown(R);
  assertNoLeaks(near, R);
  assert.match(md, /## 401\(k\)[\s\S]*13% pre-tax, 5% Roth, 10% after-tax; the employer match counts pre-tax and Roth/);
  assert.match(md, /22% federal \+ 5% state, vs 10% assumed on withdrawals: pre-tax comes out ahead; take-home with the same pre-tax \+ Roth total, all pre-tax \+[\d.]+%, all Roth -[\d.]+% vs the current split/);
  assert.match(md, /pre-tax \+ Roth near the annual limit/);
  assert.match(md, /\| 401\(k\) contribution limit \| OK \| Near \|/);
  assert.match(md, /What-if: the 401\(k\) split differs from the paycheck split, so take-home pay is re-estimated \(-[\d.]+% vs the paycheck entered\)/);
  assert.doesNotMatch(md, /24,?500|72,?000|\$/);
  assert.deepEqual(exportJSON(R).ratios.k401[0].deferral_limit, "near");
});

test("empty data analyzes without errors", () => {
  const E = analyze(normalize({}), TODAY);
  assert.ok(Array.isArray(E.checks));
  assert.match(exportMarkdown(E), /amount-free/);
});

test("normalize is idempotent (saved files round-trip)", () => {
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(data))), data);
});

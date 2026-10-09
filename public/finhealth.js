// finhealth core: validation, analysis, and the amount-free export.
// Pure functions only (no DOM, no Node APIs) so the same file runs in the browser and in Node.

export const TAX_BUCKET = {
  cash: "cash", hysa: "cash", cd: "cash",
  brokerage: "taxable",
  "401k": "tax_deferred", "403b": "tax_deferred", traditional_ira: "tax_deferred",
  roth_ira: "tax_free", roth_401k: "tax_free", hsa: "tax_free",
};
export const ACCOUNT_TYPES = Object.keys(TAX_BUCKET);
export const CASH_LIKE = ["cash", "hysa", "cd"];
export const ALLOC_KEYS = ["stocks", "bonds", "cash", "single_stock", "other"];
export const HIGH_INTEREST_APR = 0.08;
export const FI_MULTIPLE = 25;              // 4% withdrawal rule of thumb
export const ASSUMED_REAL_RETURN = 0.05;
export const CD_PENALTY_FREE_DAYS = 90;     // a CD maturing this soon counts in full toward the emergency fund
export const CD_DEFAULT_PENALTY_MONTHS = 3; // early-withdrawal penalty, in months of interest, when not given
export const BIWEEKLY_TO_MONTHLY = 26 / 12;  // 26 paychecks a year; two months get a third one

// ---------------------------------------------------------------- dates (ISO strings, UTC arithmetic)

const DAY = 86400000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(s) {
  if (typeof s !== "string" || !ISO_RE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? t : null;
}
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function addMonths(iso, n) {
  const [y0, m0, d] = iso.split("-").map(Number);
  const idx = m0 - 1 + n;
  const y = y0 + Math.floor(idx / 12), m = ((idx % 12) + 12) % 12 + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / DAY);
const monthsBetween = (a, b) => daysBetween(a, b) / 30.4375;

/** Next maturity on or after today. A renewing CD rolls forward by its term; a lapsed one returns null. */
export function cdNextMaturity(acct, today) {
  const m = acct.maturity_date, term = Math.trunc(acct.term_months || 0);
  if (m >= today) return m;
  if (acct.renews && term > 0) {
    let k = 0;
    while (addMonths(m, k * term) < today) k++;
    return addMonths(m, k * term);
  }
  return null;
}

// ---------------------------------------------------------------- validation

function num(v, where) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "boolean") throw new Error(`${where}: expected a number`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${where}: expected a number, got ${JSON.stringify(v)}`);
  return n;
}

/** Validate and coerce input from a JSON file or the web form. Throws Error with a readable message. */
export function normalize(input) {
  const d = JSON.parse(JSON.stringify(input ?? {}));
  if (typeof d !== "object" || Array.isArray(d)) throw new Error("data must be a JSON object");
  for (const sec of ["income", "retirement", "savings", "profile", "home"]) {
    if (d[sec] == null) continue;
    for (const k of Object.keys(d[sec])) d[sec][k] = num(d[sec][k], `${sec}.${k}`);
  }
  if (d.home && !((d.home.mortgage_apr ?? 0) >= 0 && (d.home.mortgage_apr ?? 0) < 1))
    throw new Error("home: mortgage_apr should be a fraction, e.g. 0.065 for 6.5%");
  if (d.profile && d.profile.age === 0) delete d.profile.age;
  // take-home and other deductions are per month or per biweekly paycheck; the key that is present says which
  for (const base of ["take_home", "other_deductions"]) {
    if (!d.income || !(`${base}_biweekly` in d.income)) continue;
    if (d.income[`${base}_monthly`]) throw new Error(`income: give ${base}_monthly or ${base}_biweekly, not both`);
    delete d.income[`${base}_monthly`];
  }
  if (d.savings && Object.keys(d.savings).length === 0) delete d.savings;

  // expenses: canonical form is [{name, amount}]; an object {name: amount} is accepted too
  const ex = d.expenses ?? [];
  const rows = Array.isArray(ex) ? ex : Object.entries(ex).map(([name, amount]) => ({ name, amount }));
  d.expenses = rows
    .map((r, i) => ({ name: String(r.name ?? "").trim(), amount: num(r.amount, `expense ${r.name || i + 1}`) }))
    .filter(r => r.name);

  d.debts = (d.debts ?? []).map((x, i) => {
    const w = `debt ${x.name || i + 1}`;
    return { ...x, name: String(x.name ?? ""), balance: num(x.balance, w + " balance"), apr: num(x.apr, w + " apr"), min_payment: num(x.min_payment, w + " min_payment") };
  });

  d.history = (d.history ?? []).map((h, i) => {
    if (parseDate(String(h.date)) === null) throw new Error(`history row ${i + 1}: date must be YYYY-MM-DD`);
    return { date: String(h.date), net_worth: num(h.net_worth, `history ${h.date} net_worth`), investable: num(h.investable, `history ${h.date} investable`) };
  });

  d.accounts = (d.accounts ?? []).map(a0 => {
    const a = { ...a0 }, nm = JSON.stringify(a.name ?? "");
    a.name = String(a.name ?? "");
    a.balance = num(a.balance, `account ${nm} balance`);
    if (!(a.type in TAX_BUCKET)) throw new Error(`account ${nm}: unknown type ${JSON.stringify(a.type)}; use one of ${ACCOUNT_TYPES.join(", ")}`);
    if (a.type === "hysa" || a.type === "cd" || "apr" in a) {
      a.apr = num(a.apr, `account ${nm} apr`);
      if (!(a.apr >= 0 && a.apr < 1)) throw new Error(`account ${nm}: apr should be a fraction, e.g. 0.045 for 4.5%`);
    }
    if (a.type === "cd") {
      if (parseDate(String(a.maturity_date)) === null) throw new Error(`CD ${nm}: maturity_date must be YYYY-MM-DD`);
      a.maturity_date = String(a.maturity_date);
      a.term_months = Math.trunc(num(a.term_months, `CD ${nm} term_months`));
      a.penalty_months = num(a.penalty_months ?? CD_DEFAULT_PENALTY_MONTHS, `CD ${nm} penalty_months`);
      a.renews = Boolean(a.renews);
      if (a.renews && a.term_months <= 0) throw new Error(`CD ${nm}: a renewing CD needs term_months`);
    } else {
      for (const k of ["maturity_date", "term_months", "penalty_months", "renews"]) delete a[k];
    }
    if (CASH_LIKE.includes(a.type)) { delete a.allocation; return a; }
    const alloc = {};
    for (const [k, v] of Object.entries(a.allocation ?? {})) {
      const n = num(v, `account ${nm} allocation.${k}`);
      if (n) alloc[k] = n;
    }
    a.allocation = Object.keys(alloc).length ? alloc : { other: 1 };
    const total = Object.values(a.allocation).reduce((s, v) => s + v, 0);
    if (Math.abs(total - 1) > 0.01) throw new Error(`account ${nm}: allocation sums to ${total.toFixed(2)}, expected 1.0`);
    return a;
  });
  return d;
}

// ---------------------------------------------------------------- analysis

const ratio = (n, dnm) => (dnm ? n / dnm : null);
const sum = xs => xs.reduce((s, v) => s + v, 0);
const fmtPct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;

/** Monthly value of an income field entered per month (<base>_monthly) or per biweekly paycheck (<base>_biweekly). */
const perMonth = (inc, base) => `${base}_biweekly` in inc ? inc[`${base}_biweekly`] * BIWEEKLY_TO_MONTHLY : inc[`${base}_monthly`] ?? 0;

export function payoffMonths(balance, apr, payment) {
  if (balance <= 0) return 0;
  const r = apr / 12;
  if (payment <= balance * r) return null; // never pays off
  if (r === 0) return Math.ceil(balance / payment);
  return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
}

/**
 * Analyze normalized data. Returns {amounts, ratios, checks, growth, assumptions}.
 * `amounts` contains currency values and stays local; everything else is amount-free.
 */
export function analyze(d, today = todayISO()) {
  const assumptions = [];
  const inc = d.income ?? {}, ret = d.retirement ?? {};
  const takeHome = perMonth(inc, "take_home");
  if ("take_home_biweekly" in inc) assumptions.push("Take-home pay was entered per biweekly paycheck and averaged to monthly (26 paychecks over 12 months); two months a year have a third paycheck.");
  const grossM = (inc.gross_annual ?? 0) / 12;
  const expenses = {};
  for (const r of d.expenses ?? []) expenses[r.name] = (expenses[r.name] ?? 0) + r.amount;
  const expTotal = sum(Object.values(expenses));
  const debts = d.debts ?? [], accounts = d.accounts ?? [];
  const debtPay = sum(debts.map(x => x.min_payment));
  const debtBal = sum(debts.map(x => x.balance));

  // 401k flows
  const empPct = ret.employee_contribution_pct ?? 0, limit = ret.employer_match_limit_pct ?? 0;
  const employee401k = empPct * grossM;
  const employer401k = ((ret.employer_match_rate ?? 0) * Math.min(empPct, limit) + (ret.employer_nonelective_pct ?? 0)) * grossM;

  // taxes withheld: what's left of gross pay after take-home, your 401(k), and other paycheck deductions
  const otherDed = perMonth(inc, "other_deductions");
  const taxes = grossM > 0 && takeHome > 0 ? grossM - employee401k - otherDed - takeHome : null;

  // home (optional): equity counts toward net worth; mortgage payment plus property costs are their own cash-flow line
  const home = d.home ?? null;
  const housing = home ? (home.mortgage_payment ?? 0) + (home.costs_monthly ?? 0) : 0;
  const homeValue = home?.value ?? 0, mortBal = home?.mortgage_balance ?? 0, homeEquity = homeValue - mortBal;
  if (home) {
    assumptions.push("Net worth includes home equity at the entered home value; investable assets and FI progress exclude the home.");
    const dup = [...debts.map(x => x.name), ...Object.keys(expenses)].filter(n => /mortgage|property tax|\bhoa\b|homeowner/i.test(n));
    if (dup.length) assumptions.push(`The home section is filled in and ${dup.join(", ")} is also listed under debts or expenses; it may be counted twice.`);
  }

  const surplus = takeHome - expTotal - debtPay - housing;
  const sv = d.savings;
  let savedFromPay;
  if (sv) {
    savedFromPay = (sv.monthly_to_investments ?? 0) + (sv.monthly_to_cash ?? 0);
    if (savedFromPay > surplus + 1) assumptions.push("Stated monthly savings exceed computed surplus; expenses or savings inputs may be off.");
  } else {
    savedFromPay = Math.max(surplus, 0);
    assumptions.push("No savings section: the full monthly surplus is assumed saved.");
  }

  // balances
  const buckets = { cash: 0, taxable: 0, tax_deferred: 0, tax_free: 0 };
  const alloc = {};
  for (const a of accounts) {
    buckets[TAX_BUCKET[a.type]] += a.balance;
    for (const [k, frac] of Object.entries(CASH_LIKE.includes(a.type) ? { cash: 1 } : a.allocation)) alloc[k] = (alloc[k] ?? 0) + a.balance * frac;
  }
  const assets = sum(Object.values(buckets));
  const cash = buckets.cash; // balance-sheet cash, CDs at full value
  const investable = assets - cash;
  const netWorth = assets - debtBal + homeEquity;

  // emergency money: liquid cash plus CDs at their early-withdrawal value
  const liquid = sum(accounts.filter(a => a.type === "cash" || a.type === "hysa").map(a => a.balance));
  const cds = [];
  let cdAccess = 0;
  for (const a of accounts.filter(x => x.type === "cd")) {
    const nxt = cdNextMaturity(a, today);
    const days = nxt ? daysBetween(today, nxt) : 0;
    const penalty = a.balance * (a.apr ?? 0) / 12 * a.penalty_months;
    const accessible = days <= CD_PENALTY_FREE_DAYS ? a.balance : Math.max(a.balance - penalty, 0);
    cdAccess += accessible;
    cds.push({ name: a.name || "cd", balance: a.balance, apr: a.apr ?? 0, renews: a.renews, term_months: a.term_months,
      next_maturity: nxt, days_to_maturity: nxt ? days : null, lapsed: nxt === null,
      penalty_if_withdrawn_now: days > CD_PENALTY_FREE_DAYS ? penalty : 0 });
  }
  cds.sort((p, q) => (p.days_to_maturity ?? -1) - (q.days_to_maturity ?? -1));
  const emergencyCash = liquid + cdAccess;
  const cashAccts = accounts.filter(a => CASH_LIKE.includes(a.type));
  const cashBlendedApr = cash ? sum(cashAccts.map(a => a.balance * (a.apr ?? 0))) / cash : null;
  const cashZeroRateShare = cash ? sum(cashAccts.filter(a => !a.apr).map(a => a.balance)) / cash : null;
  const cashByType = Object.fromEntries(CASH_LIKE.map(t => [t, sum(accounts.filter(a => a.type === t).map(a => a.balance))]));

  // savings rate: everything saved / everything earned-and-kept (take-home + pre-tax + employer)
  const savingsRate = ratio(savedFromPay + employee401k + employer401k, takeHome + employee401k + employer401k);
  const burn = expTotal + debtPay + housing;
  const efMonths = burn ? emergencyCash / burn : null;
  const liquidMonths = burn ? liquid / burn : null;
  const dti = ratio(debtPay, grossM);
  const matchCaptured = limit ? Math.min(empPct, limit) / limit : null;
  const fiProgress = ratio(investable, burn * 12 * FI_MULTIPLE);
  const hiDebts = debts.filter(x => x.apr >= HIGH_INTEREST_APR);
  const hiDebtRatio = ratio(sum(hiDebts.map(x => x.balance)), grossM * 12);
  const stockPct = ratio((alloc.stocks ?? 0) + (alloc.single_stock ?? 0), investable);
  const singlePct = ratio(alloc.single_stock ?? 0, investable);

  // years to FI at an assumed real return, from current investable + annual contributions
  const annualContrib = (savedFromPay - (sv ? sv.monthly_to_cash ?? 0 : 0) + employee401k + employer401k) * 12;
  const target = burn * 12 * FI_MULTIPLE;
  let yearsToFi = null;
  if (target && investable < target && annualContrib > 0) {
    let bal = investable, y = 0;
    while (bal < target && y < 80) { bal = bal * (1 + ASSUMED_REAL_RETURN) + annualContrib; y++; }
    yearsToFi = bal >= target ? y : null;
  } else if (target && investable >= target) yearsToFi = 0;
  const horizon = Math.min(Math.max((yearsToFi ?? 0) + 5, 15), 45);
  const projection = [];
  for (let y = 0, bal = investable; y <= horizon; y++) {
    projection.push({ year: y, investable: Math.round(bal), target: Math.round(target) });
    bal = bal * (1 + ASSUMED_REAL_RETURN) + Math.max(annualContrib, 0);
  }

  const history = (d.history ?? []).filter(h => h.date < today).sort((p, q) => p.date.localeCompare(q.date))
    .map(h => ({ date: h.date, net_worth: h.net_worth, investable: h.investable }));
  history.push({ date: today, net_worth: netWorth, investable, current: true });

  const amounts = {
    take_home_monthly: takeHome, gross_monthly: grossM, taxes_monthly: taxes, other_deductions_monthly: otherDed,
    expenses_monthly: expTotal, debt_payments_monthly: debtPay,
    debt_balance: debtBal, employee_401k_monthly: employee401k, employer_401k_monthly: employer401k,
    saved_from_pay_monthly: savedFromPay, surplus_monthly: surplus, cash, investable, assets, net_worth: netWorth,
    expenses, buckets, allocation: alloc, liquid_cash: liquid, cd_accessible: cdAccess, emergency_cash: emergencyCash,
    cds, cash_by_type: cashByType, projection, annual_investment_contributions: annualContrib, history,
    home: home ? { value: homeValue, mortgage_balance: mortBal, equity: homeEquity, mortgage_payment: home.mortgage_payment ?? 0,
      costs: home.costs_monthly ?? 0, housing } : null,
  };

  const ratios = {
    savings_rate: savingsRate,
    taxes_share_of_gross: taxes === null ? null : taxes / grossM,
    expenses_share_of_take_home: ratio(expTotal, takeHome),
    debt_payments_share_of_take_home: ratio(debtPay, takeHome),
    surplus_share_of_take_home: ratio(surplus, takeHome),
    employer_contribution_share_of_gross: ratio(employer401k, grossM),
    emergency_fund_months: efMonths,
    liquid_cash_months: liquidMonths,
    cash_mix: cash ? Object.fromEntries(Object.entries(cashByType).filter(([, v]) => v).map(([t, v]) => [t, v / cash])) : {},
    cash_blended_apr: cashBlendedApr,
    cash_share_at_zero_rate: cashZeroRateShare,
    cds: cds.map(c => ({ name: c.name, apr: c.apr, term_months: c.term_months, renews: c.renews,
      days_to_maturity: c.days_to_maturity, lapsed: c.lapsed, share_of_cash: ratio(c.balance, cash) })),
    debt_to_income: dti,
    debt_balance_to_annual_gross: ratio(debtBal, grossM * 12),
    net_worth_to_annual_gross: ratio(netWorth, grossM * 12),
    investable_to_annual_spend: ratio(investable, burn * 12),
    fi_progress: fiProgress,
    years_to_fi: yearsToFi,
    stock_share: stockPct,
    single_stock_share: singlePct,
    expense_mix: expTotal ? Object.fromEntries(Object.entries(expenses).sort((p, q) => q[1] - p[1]).map(([k, v]) => [k, v / expTotal])) : {},
    tax_bucket_mix: assets ? Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v / assets])) : {},
    allocation_mix: investable ? Object.fromEntries(Object.entries(alloc).filter(([k]) => k !== "cash").map(([k, v]) => [k, v / investable])) : {},
    debts: debts.map(x => ({ name: x.name || "debt", apr: x.apr, share_of_total_debt: ratio(x.balance, debtBal),
      months_to_payoff_at_minimum: payoffMonths(x.balance, x.apr, x.min_payment) })),
    home: home ? {
      housing_to_gross: ratio(housing, grossM),                    // front-end ratio
      total_debt_payments_to_gross: ratio(housing + debtPay, grossM), // back-end ratio
      housing_share_of_take_home: ratio(housing, takeHome),
      loan_to_value: ratio(mortBal, homeValue),
      equity_share_of_net_worth: netWorth > 0 ? homeEquity / netWorth : null,
      mortgage_months_to_payoff: payoffMonths(mortBal, home.mortgage_apr ?? 0, home.mortgage_payment ?? 0), // 0 = no mortgage, null = never
    } : null,
  };

  // ---- checks (amount-free details)
  const checks = [];
  const C = (key, label, status, value, unit, detail) => checks.push({ key, label, status, value, unit, detail });
  const outflows = home ? "expenses, housing, and minimum debt payments" : "expenses and minimum debt payments";
  if (surplus < 0) C("cash_flow", "Monthly cash flow", "act", ratio(surplus, takeHome), "%", `Monthly ${outflows} exceed take-home pay.`);
  else C("cash_flow", "Monthly cash flow", "ok", ratio(surplus, takeHome), "%", `Take-home covers ${outflows}.`);
  if (savingsRate !== null) C("savings_rate", "Savings rate", savingsRate >= 0.2 ? "ok" : savingsRate >= 0.1 ? "watch" : "act", savingsRate, "%",
    "Includes 401k employee+employer and savings from take-home. Benchmarks: <10% low, 10-20% moderate, 20%+ strong.");
  if (taxes !== null) {
    const t = taxes / grossM;
    if (t < 0) C("taxes", "Taxes withheld (share of gross)", "watch", t, "%",
      "Take-home plus 401(k) and other deductions add up to more than gross salary. Check that gross is before any deductions, and that a bonus is counted in both or neither.");
    else C("taxes", "Taxes withheld (share of gross)", "info", t, "%",
      "Gross pay minus take-home, your 401(k), and other paycheck deductions: federal, state, and payroll taxes. This is withholding, not the final tax bill." +
      (otherDed ? "" : " No other deductions entered, so any health premiums or HSA/FSA withheld from pay are counted here too."));
  }
  if (efMonths !== null) C("emergency_fund", "Emergency fund", efMonths >= 6 ? "ok" : efMonths >= 3 ? "watch" : "act", efMonths, "months",
    `Cash divided by monthly ${outflows}. Common target 3-6 months; more if income is variable.` +
    (cds.length ? ` Includes CDs at early-withdrawal value; checking and savings alone cover ${liquidMonths.toFixed(1)} months.` : ""));
  if (matchCaptured !== null) C("match", "Employer match captured", matchCaptured >= 0.999 ? "ok" : "act", matchCaptured, "%",
    "Share of available employer match you are contributing enough to receive.");
  if (dti !== null) C("dti", home ? "Debt-to-income, excluding housing" : "Debt-to-income (payments / gross)", dti < 0.15 ? "ok" : dti <= 0.36 ? "watch" : "act", dti, "%",
    "Under 15% comfortable; lenders commonly cap around 36%.");
  if (home) {
    const H = ratios.home, front = H.housing_to_gross, back = H.total_debt_payments_to_gross, m = H.mortgage_months_to_payoff;
    if (front !== null) C("housing", "Housing cost (front-end ratio)", front <= 0.28 ? "ok" : front <= 0.36 ? "watch" : "act", front, "%",
      "Mortgage payment plus property tax, insurance, and HOA, over gross income. Common guideline: 28% or less.");
    if (back !== null) C("dti_total", "Debt-to-income, including housing (back-end)", back <= 0.36 ? "ok" : back <= 0.43 ? "watch" : "act", back, "%",
      "Housing plus all other debt payments, over gross income. Lenders look for 36% or less; 43% is a common ceiling.");
    if (homeValue > 0) {
      const eq = 1 - H.loan_to_value;
      C("home_equity", "Home equity", eq >= 0.2 ? "ok" : "watch", eq, "%", mortBal <= 0 ? "No mortgage; the home is owned outright."
        : "Share of the home's estimated value you own. Below 20%, conventional loans usually carry PMI. " +
          (m === null ? "At the current payment the mortgage never pays off." : `At the current payment the mortgage is paid off in ${(m / 12).toFixed(1)} years.`));
    }
  }
  if (hiDebts.length) C("high_interest_debt", "High-interest debt (balance / annual gross)", "act", hiDebtRatio, "%",
    `Debts at or above ${fmtPct(HIGH_INTEREST_APR)} APR: ${hiDebts.map(x => `${x.name} ${fmtPct(x.apr)}`).join(", ")}. Paying these down is a guaranteed return at that rate.`);
  else C("high_interest_debt", "High-interest debt", "ok", 0, "%", `No debts at or above ${fmtPct(HIGH_INTEREST_APR)} APR.`);
  if (singlePct) C("concentration", "Single-stock concentration", singlePct <= 0.1 ? "ok" : singlePct <= 0.2 ? "watch" : "act", singlePct, "%",
    "Share of investable assets in one company. Common guidance keeps this under 10%.");
  const age = d.profile?.age;
  if (age && stockPct !== null) {
    const ref = Math.max(0, Math.min(1, (110 - age) / 100)), gap = stockPct - ref;
    C("allocation", "Stock share vs age heuristic", Math.abs(gap) <= 0.15 ? "ok" : "watch", stockPct, "%",
      `Heuristic reference (110 - age) is ${fmtPct(ref)}; gap ${gap >= 0 ? "+" : ""}${fmtPct(gap)}. A rule of thumb, not a target.`);
  }
  if (cds.length) {
    const lapsed = cds.filter(c => c.lapsed), upcoming = cds.filter(c => !c.lapsed);
    const nxt = upcoming.length ? upcoming[0].days_to_maturity : null;
    const nRenew = cds.filter(c => c.renews).length;
    C("cds", "CDs", lapsed.length ? "watch" : "info", nxt, "days",
      `${cds.length} CD${cds.length !== 1 ? "s" : ""}, ${nRenew} set to renew. ` + (nxt !== null ? `Next maturity in ${nxt} days. ` : "") +
      (lapsed.length ? `${lapsed.length} past maturity and not renewing; update its type or balance.`
        : `Maturing within ${CD_PENALTY_FREE_DAYS} days counts in full toward the emergency fund; later ones net of penalty.`));
  }
  if (cash && cashBlendedApr !== null && accounts.some(a => a.type === "hysa" || a.type === "cd"))
    C("cash_yield", "Cash yield (blended APR)", "info", cashBlendedApr, "%",
      `Rate across checking, savings, and CDs. ${fmtPct(cashZeroRateShare)} of cash has no stated rate.`);
  if (fiProgress !== null) C("fi_progress", "Financial independence progress", "info", fiProgress, "%",
    `Investable assets vs ${FI_MULTIPLE}x annual spending. Years to reach at ${fmtPct(ASSUMED_REAL_RETURN)} real return and current contributions: ${yearsToFi ?? "n/a"}.`);

  return { amounts, ratios, checks, growth: growth(history), assumptions };
}

function growth(pts) {
  if (pts.length < 2) return { note: "Add history snapshots to see growth shape." };
  const [p0] = pts;
  const out = { base_date: p0.date, points: [] };
  let prev = null;
  for (const p of pts) {
    const row = {
      date: p.date,
      months_from_base: Math.round(monthsBetween(p0.date, p.date) * 10) / 10,
      net_worth_index: p0.net_worth > 0 ? Math.round(1000 * p.net_worth / p0.net_worth) / 10 : null,
      investable_index: p0.investable > 0 ? Math.round(1000 * p.investable / p0.investable) / 10 : null,
    };
    if (prev) row.net_worth_change_pct = prev.net_worth > 0 ? Math.round(1000 * (p.net_worth / prev.net_worth - 1)) / 10 : null;
    out.points.push(row);
    prev = p;
  }
  const last = pts[pts.length - 1];
  const years = monthsBetween(p0.date, last.date) / 12;
  if (years > 0 && p0.net_worth > 0 && last.net_worth > 0) out.net_worth_cagr = (last.net_worth / p0.net_worth) ** (1 / years) - 1;
  if (years > 0 && p0.investable > 0 && last.investable > 0) out.investable_cagr = (last.investable / p0.investable) ** (1 / years) - 1;
  if (pts.length >= 3) {
    const mid = Math.floor(pts.length / 2);
    const rate = (a, b) => {
      const yrs = monthsBetween(a.date, b.date) / 12;
      return yrs > 0 && a.net_worth > 0 && b.net_worth > 0 ? (b.net_worth / a.net_worth) ** (1 / yrs) - 1 : null;
    };
    const r1 = rate(pts[0], pts[mid]), r2 = rate(pts[mid], last);
    if (r1 !== null && r2 !== null) {
      out.trend = r2 > r1 + 0.02 ? "accelerating" : r2 < r1 - 0.02 ? "decelerating" : "steady";
      out.first_half_cagr = r1;
      out.second_half_cagr = r2;
    }
  }
  out.note = "Growth includes new contributions, not only market returns; a high rate can reflect saving, not investment performance.";
  return out;
}

// ---------------------------------------------------------------- export (amount-free)

export function fmtValue(v, unit) {
  if (v === null || v === undefined) return "n/a";
  if (unit.startsWith("%")) return (v !== 0 && Math.abs(v) < 0.1 ? fmtPct(v, 1) : fmtPct(v)) + unit.slice(1);
  if (unit === "months") return `${v.toFixed(1)} months`;
  if (unit === "years") return `${v.toFixed(0)} years`;
  if (unit === "days") return `${v.toFixed(0)} days`;
  return `${v.toFixed(2)}${unit}`;
}

/** Coarse rounding limits how much the export narrows down underlying amounts. */
function roundDeep(o) {
  if (typeof o === "number") return Math.round(o * 100) / 100;
  if (Array.isArray(o)) return o.map(roundDeep);
  if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, roundDeep(v)]));
  return o;
}

export function exportJSON(A) {
  return roundDeep({
    about: "Amount-free financial summary. Values are ratios (0-1 = 0-100%), durations, or indexes (base = 100). No currency amounts are included.",
    checks: A.checks, ratios: A.ratios, growth: A.growth, assumptions: A.assumptions,
  });
}

export function exportMarkdown(A) {
  const r = A.ratios, g = A.growth;
  const L = ["# Personal finance summary (amount-free)", "",
    "All figures are ratios, durations, or indexes. No currency amounts are included. " +
    "Use this to give general, educational observations; the user's full numbers stay local.",
    "", "## Health checks", "", "| Check | Status | Value | Notes |", "|---|---|---|---|"];
  for (const c of A.checks) L.push(`| ${c.label} | ${c.status.toUpperCase()} | ${fmtValue(c.value, c.unit)} | ${c.detail} |`);
  L.push("", "## Cash flow shape (share of monthly take-home)", "");
  if (r.home) L.push(`- housing (mortgage, property tax, insurance, HOA) share of take home: ${fmtValue(r.home.housing_share_of_take_home, "%")}`);
  for (const k of ["expenses_share_of_take_home", "debt_payments_share_of_take_home", "surplus_share_of_take_home"])
    L.push(`- ${k.replace(/_/g, " ")}: ${fmtValue(r[k], "%")}`);
  L.push(`- employer 401k contribution as share of gross: ${fmtValue(r.employer_contribution_share_of_gross, "%")}`);
  L.push("", "## Expense mix", "", ...Object.entries(r.expense_mix).map(([k, v]) => `- ${k}: ${fmtPct(v)}`));
  L.push("", "## Balance sheet shape", "",
    `- net worth / annual gross income: ${fmtValue(r.net_worth_to_annual_gross, "x")}`,
    `- investable assets / annual spending: ${fmtValue(r.investable_to_annual_spend, "x")}`,
    `- total debt / annual gross income: ${fmtValue(r.debt_balance_to_annual_gross, "x")}`,
    "- account tax treatment mix: " + Object.entries(r.tax_bucket_mix).map(([k, v]) => `${k} ${fmtPct(v)}`).join(", "),
    "- investment allocation (excl. cash accounts): " + Object.entries(r.allocation_mix).map(([k, v]) => `${k} ${fmtPct(v)}`).join(", "));
  if (r.home) {
    const h = r.home, m = h.mortgage_months_to_payoff;
    L.push("", "## Home", "",
      `- housing cost / gross income (front-end): ${fmtValue(h.housing_to_gross, "%")}`,
      `- all debt payments incl. housing / gross income (back-end): ${fmtValue(h.total_debt_payments_to_gross, "%")}`,
      `- mortgage loan-to-value: ${fmtValue(h.loan_to_value, "%")}`,
      `- home equity share of net worth: ${fmtValue(h.equity_share_of_net_worth, "%")}`,
      `- mortgage payoff at current payment: ${m === null ? "never (payment below interest)" : m === 0 ? "no mortgage" : `${(m / 12).toFixed(1)} years`}`);
  }
  if (Object.keys(r.cash_mix).length) {
    L.push("", "## Cash and CDs", "",
      "- cash by account type: " + Object.entries(r.cash_mix).map(([k, v]) => `${k} ${fmtPct(v)}`).join(", "),
      `- emergency fund counting only checking/savings: ${fmtValue(r.liquid_cash_months, "months")}`,
      `- blended cash APR: ${fmtValue(r.cash_blended_apr, "%")}`);
    for (const c of r.cds) {
      const when = c.lapsed ? "past maturity, not renewing" : `matures in ${c.days_to_maturity} days`;
      L.push(`- ${c.name} (CD): ${fmtPct(c.apr, 2)} APR, ${c.term_months}-month term, ${when}, ${c.renews ? "renews (ladder)" : "does not renew"}, ${fmtValue(c.share_of_cash, "%")} of cash`);
    }
  }
  if (r.debts.length) {
    L.push("", "## Debts", "");
    for (const x of r.debts) {
      const m = x.months_to_payoff_at_minimum;
      L.push(`- ${x.name}: APR ${fmtPct(x.apr, 1)}, ${fmtValue(x.share_of_total_debt, "%")} of total debt, payoff at minimum: ${m === null ? "never (payment below interest)" : `${m} months`}`);
    }
  }
  L.push("", "## Growth shape", "");
  if (g.points) {
    L.push("| Date | Months from base | Net worth index | Investable index | NW change vs prior |", "|---|---|---|---|---|");
    for (const p of g.points) {
      const ch = p.net_worth_change_pct;
      const f1 = v => (v == null ? "n/a" : v.toFixed(1));
      L.push(`| ${p.date} | ${f1(p.months_from_base)} | ${f1(p.net_worth_index)} | ${f1(p.investable_index)} | ${ch == null ? "" : `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`} |`);
    }
    for (const k of ["net_worth_cagr", "investable_cagr", "first_half_cagr", "second_half_cagr"])
      if (g[k] != null) L.push(`- ${k.replace(/_/g, " ")}: ${fmtPct(g[k], 1)}`);
    if (g.trend) L.push(`- trend: ${g.trend}`);
  }
  L.push(`- ${g.note}`);
  if (A.assumptions.length) L.push("", "## Assumptions", "", ...A.assumptions.map(a => `- ${a}`));
  return L.join("\n") + "\n";
}

/** Local report with amounts. Never share this one. */
export function reportText(A) {
  const a = A.amounts;
  const keys = ["gross_monthly", "take_home_monthly", "employee_401k_monthly", "employer_401k_monthly", "expenses_monthly", "debt_payments_monthly",
    "surplus_monthly", "saved_from_pay_monthly", "liquid_cash", "cash", "investable", "debt_balance", "net_worth"];
  const rows = [];
  for (const k of keys) {
    rows.push([k, a[k]]);
    if (k === "employer_401k_monthly" && a.taxes_monthly !== null) rows.push(["taxes_withheld_monthly", a.taxes_monthly]);
    if (k === "employer_401k_monthly" && a.other_deductions_monthly) rows.push(["other_deductions_monthly", a.other_deductions_monthly]);
    if (k === "debt_payments_monthly" && a.home) rows.push(["housing_monthly", a.home.housing]);
    if (k === "debt_balance" && a.home) rows.push(["home_value", a.home.value], ["mortgage_balance", a.home.mortgage_balance]);
  }
  const lines = ["LOCAL REPORT (contains amounts; do not share)", ""];
  for (const [k, v] of rows) lines.push(`  ${k.padEnd(28)} ${Math.round(v).toLocaleString("en-US").padStart(14)}`);
  return lines.join("\n") + "\n\n" + exportMarkdown(A);
}

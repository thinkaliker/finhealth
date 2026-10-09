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
// display currency (data.currency): an ISO code, or "none" for plain numbers. Amounts are whole units.
export const DEFAULT_CURRENCY = "USD";
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY", "CNY", "INR", "SGD", "HKD", "SEK", "NOK", "DKK", "MXN", "BRL", "ZAR"];

// number convention per currency (digit grouping, decimal mark, symbol position); "none" uses the browser's locale
export const CURRENCY_LOCALES = { USD: "en-US", EUR: "de-DE", GBP: "en-GB", CAD: "en-CA", AUD: "en-AU", NZD: "en-NZ", CHF: "de-CH",
  JPY: "ja-JP", CNY: "zh-CN", INR: "en-IN", SGD: "en-SG", HKD: "en-HK", SEK: "sv-SE", NOK: "nb-NO", DKK: "da-DK", MXN: "es-MX", BRL: "pt-BR", ZAR: "en-ZA" };
const localeFor = cur => CURRENCY_LOCALES[cur ?? DEFAULT_CURRENCY];

/**
 * Money formatting for a currency, in its convention: {money: "$1,234" / "1.234 €", short: "$1.2M" (axis ticks),
 * symbol: "$", symbolAfter: false}. Negatives use a true minus.
 */
export function moneyFormat(currency = DEFAULT_CURRENCY, locale = localeFor(currency)) {
  const cur = currency === "none" ? {} : { style: "currency", currency, currencyDisplay: "narrowSymbol" };
  const full = new Intl.NumberFormat(locale, { ...cur, minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(locale, { ...cur, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 });
  const signed = f => v => { const r = Math.round(v); return (r < 0 ? "−" : "") + f.format(Math.abs(r)); };
  const parts = full.formatToParts(1), at = parts.findIndex(p => p.type === "currency");
  return { money: signed(full), short: signed(compact), symbol: parts[at]?.value ?? "",
    symbolAfter: at > parts.findIndex(p => p.type === "integer") };
}

const inputFormats = new Map();
/** Number → text for a money input, grouped by the currency's convention ("98,000.5" / "98.000,5"); no symbol. */
export function formatAmount(v, cur) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v !== "number") return String(v); // unparseable text stays visible until fixed
  const cents = !Number.isInteger(Math.round(v * 100) / 100), key = `${localeFor(cur)}|${cents}`;
  if (!inputFormats.has(key)) inputFormats.set(key, new Intl.NumberFormat(localeFor(cur), { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }));
  return inputFormats.get(key).format(v); // 98,000 or 98,000.50
}

/**
 * Text typed into a money input → number, by the currency's convention: group marks (and spaces, apostrophes,
 * currency symbols) are dropped and its decimal mark is read as the decimal point, so "98,000" is 98000 in USD and 98
 * in EUR. Empty → null. Anything else that isn't a number is returned unchanged so normalize() reports it.
 */
export function parseAmount(text, cur) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const parts = new Intl.NumberFormat(localeFor(cur)).formatToParts(1234567.5);
  const group = parts.find(p => p.type === "group")?.value ?? ",", decimal = parts.find(p => p.type === "decimal")?.value ?? ".";
  let t = raw.replace(/[\s  '’]/g, "").split(group).join("").replace(/[−–]/g, "-");
  if (decimal !== ".") t = t.split(decimal).join(".");
  t = t.replace(/[^\d.-]/g, "");
  if (t === "" || t === "-") return t === "-" ? null : raw;
  const n = Number(t);
  return Number.isFinite(n) ? n : raw;
}

// financial independence settings (data.fi); the 4% rule means a target of 25x annual spending
export const FI_DEFAULTS = { withdrawal_rate: 0.04, real_return: 0.05, retirement_tax_rate: 0.10 };
export const FI_RANGES = { withdrawal_rate: [0.025, 0.06], real_return: [0, 0.10], retire_in_years: [0, 50], retirement_tax_rate: [0, 0.40] };
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
  // retirement.match_tiers (optional): [{rate, pct}] = "rate match on the next pct of pay"; replaces the single rate + limit
  const tiers = d.retirement?.match_tiers;
  if (d.retirement) delete d.retirement.match_tiers;
  // the older single "home" section becomes one residence in "properties"
  if (d.home) {
    if (d.properties) throw new Error('give "properties" or the older "home" section, not both');
    const h = d.home, hasLoan = h.mortgage_balance || h.mortgage_payment || h.mortgage_apr;
    d.properties = [{ name: "Home", residence: true, value: h.value, costs_monthly: h.costs_monthly,
      loans: hasLoan ? [{ name: "Mortgage", balance: h.mortgage_balance, apr: h.mortgage_apr, payment: h.mortgage_payment }] : [] }];
    delete d.home;
  }
  for (const sec of ["income", "retirement", "savings", "profile", "fi"]) {
    if (d[sec] == null) continue;
    for (const k of Object.keys(d[sec])) d[sec][k] = num(d[sec][k], `${sec}.${k}`);
  }
  if (tiers != null) {
    const r = d.retirement;
    if (!Array.isArray(tiers)) throw new Error("retirement.match_tiers must be a list");
    if (r.employer_match_rate || r.employer_match_limit_pct) throw new Error("retirement: give employer_match_rate and employer_match_limit_pct, or match_tiers, not both");
    delete r.employer_match_rate; delete r.employer_match_limit_pct;
    r.match_tiers = tiers.map((t, i) => {
      const rate = num(t.rate, `match tier ${i + 1} rate`), pct = num(t.pct, `match tier ${i + 1} pct`);
      if (!(rate >= 0 && rate <= 5 && pct >= 0 && pct < 1))
        throw new Error(`match tier ${i + 1}: rate and pct are fractions, e.g. rate 0.5 and pct 0.04 for "50% of the next 4%"`);
      return { rate, pct };
    }).filter(t => t.pct > 0);
  }
  if (d.currency != null) {
    const c = String(d.currency).trim();
    if (c.toLowerCase() === "none") d.currency = "none";
    else if (/^[a-z]{3}$/i.test(c)) d.currency = c.toUpperCase();
    else throw new Error('currency: use a 3-letter code like "USD", or "none"');
  }
  if (d.fi) {
    for (const [k, [lo, hi]] of Object.entries(FI_RANGES))
      if (k in d.fi && !(d.fi[k] >= lo && d.fi[k] <= hi))
        throw new Error(`fi.${k} must be between ${lo} and ${hi}` + (k === "retire_in_years" ? "" : " (a fraction, e.g. 0.04 for 4%)"));
    if ("retire_in_years" in d.fi) d.fi.retire_in_years = Math.round(d.fi.retire_in_years);
    if (!Object.keys(d.fi).length) delete d.fi;
  }
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

  // other income (rent, side work, a pension): monthly amounts received; `continues` = keeps paying after you stop working
  d.other_income = (d.other_income ?? [])
    .map((r, i) => ({ name: String(r.name ?? "").trim(), amount: num(r.amount, `other income ${r.name || i + 1}`), continues: Boolean(r.continues) }))
    .filter(r => r.name);

  // real estate: each property has a value, monthly costs (tax, insurance, HOA), and loans; `residence` = you live there
  d.properties = (d.properties ?? []).map((p, i) => {
    const w = `property ${p.name || i + 1}`;
    const loans = (p.loans ?? []).map((l, j) => {
      const lw = `${w}, loan ${l.name || j + 1}`, apr = num(l.apr, lw + " apr");
      if (!(apr >= 0 && apr < 1)) throw new Error(`${lw}: apr should be a fraction, e.g. 0.065 for 6.5%`);
      return { name: String(l.name ?? ""), balance: num(l.balance, lw + " balance"), apr, payment: num(l.payment, lw + " payment") };
    });
    return { name: String(p.name ?? ""), residence: Boolean(p.residence), value: num(p.value, w + " value"),
      costs_monthly: num(p.costs_monthly, w + " costs_monthly"), loans };
  });

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
const pctTxt = v => `${+(v * 100).toFixed(2)}%`; // 4.25%, 4%, no trailing zeros

const matchTiers = ret => ret.match_tiers ?? [{ rate: ret.employer_match_rate ?? 0, pct: ret.employer_match_limit_pct ?? 0 }];

/** Employer match as a fraction of pay when the employee contributes `emp` (a fraction; Infinity = the maximum match). */
export function matchPct(ret, emp) {
  let from = 0, m = 0;
  for (const t of matchTiers(ret)) { m += t.rate * Math.max(0, Math.min(emp - from, t.pct)); from += t.pct; }
  return m;
}

/** Employee contribution (fraction of pay) that receives the full match. */
export function fullMatchAt(ret) {
  let from = 0, at = 0;
  for (const t of matchTiers(ret)) { from += t.pct; if (t.rate > 0) at = from; }
  return at;
}

/** Monthly value of an income field entered per month (<base>_monthly) or per biweekly paycheck (<base>_biweekly). */
const perMonth = (inc, base) => `${base}_biweekly` in inc ? inc[`${base}_biweekly`] * BIWEEKLY_TO_MONTHLY : inc[`${base}_monthly`] ?? 0;

/**
 * Financial-independence plan in today's dollars (the return is after inflation). Contributions continue until
 * retire_in_years ("stop working": no more job income), then the same real amount, withdrawal_rate of the balance at
 * that point, is withdrawn at the start of every year. Target = annual spending / withdrawal_rate.
 * base: {investable, annual_contrib, annual_spend, tax_deferred_share, age, continuing_income_annual}; settings: data.fi (any subset).
 * Income that continues after you stop working (rent, a pension) lowers the target and adds to take-home.
 * Only tax-deferred withdrawals are taxed, at retirement_tax_rate; Roth/HSA are tax-free, brokerage gains are not modeled.
 */
export function fiPlan(base, settings = {}) {
  const s = { ...FI_DEFAULTS, ...settings }, wr = s.withdrawal_rate, r = s.real_return;
  const continuing = base.continuing_income_annual ?? 0; // other income that keeps paying, e.g. rent
  const target = Math.max(0, base.annual_spend - continuing) / wr;
  let yearsToFi = null;
  if (base.annual_spend > 0 && base.investable >= target) yearsToFi = 0;
  else if (target && base.annual_contrib > 0) {
    let bal = base.investable, y = 0;
    while (bal < target && y < 80) { bal = bal * (1 + r) + base.annual_contrib; y++; }
    yearsToFi = bal >= target ? y : null;
  }
  // default: stop working when the target is reached, else at 65, else in 30 years
  const [lo, hi] = FI_RANGES.retire_in_years;
  const retireIn = Math.min(hi, Math.max(lo, s.retire_in_years ?? yearsToFi ?? (base.age ? 65 - base.age : 30)));
  const projection = [];
  let bal = base.investable, start = 0, lasts = null;
  for (let y = 0; y <= retireIn + 30; y++) {
    if (y === retireIn) start = bal;
    projection.push({ year: y, investable: Math.round(bal), target: Math.round(target) });
    if (y < retireIn) bal = bal * (1 + r) + Math.max(base.annual_contrib, 0);
    else if (bal >= start * wr) bal = (bal - start * wr) * (1 + r);
    else { lasts ??= y - retireIn; bal = 0; } // can't fund a full year's withdrawal
  }
  const monthly = start * wr / 12, afterTax = monthly * (1 - base.tax_deferred_share * s.retirement_tax_rate);
  const takeHome = afterTax + continuing / 12;
  return {
    input: settings, settings: { ...s, retire_in_years: retireIn }, target, years_to_fi: yearsToFi, projection,
    at_retirement: { balance: start, monthly_before_tax: monthly, monthly_after_tax: afterTax, other_income_monthly: continuing / 12,
      monthly_take_home: takeHome, share_of_spending: base.annual_spend ? takeHome * 12 / base.annual_spend : null,
      lasts_years: lasts }, // lasts null = 30+ years
  };
}

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
  const empPct = ret.employee_contribution_pct ?? 0;
  const employee401k = empPct * grossM;
  const employer401k = (matchPct(ret, empPct) + (ret.employer_nonelective_pct ?? 0)) * grossM;

  // taxes withheld: what's left of gross pay after take-home, your 401(k), and other paycheck deductions
  const otherDed = perMonth(inc, "other_deductions");
  const taxes = grossM > 0 && takeHome > 0 ? grossM - employee401k - otherDed - takeHome : null;

  // other income (rent, side work, a pension) adds to monthly income and, for ratios, to gross income
  const otherIncome = sum((d.other_income ?? []).map(o => o.amount));
  const continuingIncome = sum((d.other_income ?? []).filter(o => o.continues).map(o => o.amount));
  const income = takeHome + otherIncome, grossIncomeM = grossM + otherIncome;

  // real estate: equity counts toward net worth; loan payments plus property costs are their own outflow ("housing").
  // Only the residence (where you live) counts for the front-end housing ratio.
  const props = (d.properties ?? []).map(p => {
    const loanBal = sum(p.loans.map(l => l.balance)), payments = sum(p.loans.map(l => l.payment));
    return { name: p.name || "property", residence: p.residence, value: p.value, loan_balance: loanBal, equity: p.value - loanBal,
      payments, costs: p.costs_monthly, outflow: payments + p.costs_monthly,
      loans: p.loans.map(l => ({ name: l.name || "loan", balance: l.balance, apr: l.apr, payment: l.payment,
        months_to_payoff: payoffMonths(l.balance, l.apr, l.payment) })) };
  });
  const residences = props.filter(p => p.residence);
  const housing = sum(props.map(p => p.outflow)), residenceHousing = sum(residences.map(p => p.outflow));
  const propEquity = sum(props.map(p => p.equity));
  if (props.length) {
    assumptions.push("Net worth includes property equity at the entered values; investable assets and FI progress exclude real estate.");
    const dup = [...debts.map(x => x.name), ...Object.keys(expenses)].filter(n => /mortgage|property tax|\bhoa\b|homeowner/i.test(n));
    if (dup.length) assumptions.push(`Real estate is filled in and ${dup.join(", ")} is also listed under debts or expenses; it may be counted twice.`);
    if (props.some(p => !p.residence) && !otherIncome) assumptions.push("A property you don't live in has no rent listed under other income.");
  }

  const surplus = income - expTotal - debtPay - housing;
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
  const netWorth = assets - debtBal + propEquity;

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

  // savings rate: everything saved / everything earned-and-kept (take-home + other income + pre-tax + employer)
  const savingsRate = ratio(savedFromPay + employee401k + employer401k, income + employee401k + employer401k);
  const burn = expTotal + debtPay + housing;
  const efMonths = burn ? emergencyCash / burn : null;
  const liquidMonths = burn ? liquid / burn : null;
  const dti = ratio(debtPay, grossIncomeM);
  const fullMatch = matchPct(ret, Infinity), fullAt = fullMatchAt(ret);
  const matchCaptured = fullMatch ? matchPct(ret, empPct) / fullMatch : null;
  const hiDebts = debts.filter(x => x.apr >= HIGH_INTEREST_APR);
  const hiDebtRatio = ratio(sum(hiDebts.map(x => x.balance)), grossIncomeM * 12);
  const stockPct = ratio((alloc.stocks ?? 0) + (alloc.single_stock ?? 0), investable);
  const singlePct = ratio(alloc.single_stock ?? 0, investable);

  // financial independence: invested contributions (not cash savings) until you stop working, then withdrawals
  const annualContrib = (savedFromPay - (sv ? sv.monthly_to_cash ?? 0 : 0) + employee401k + employer401k) * 12;
  const fiBase = { investable, annual_contrib: annualContrib, annual_spend: burn * 12, continuing_income_annual: continuingIncome * 12,
    tax_deferred_share: investable > 0 ? buckets.tax_deferred / investable : 0, age: d.profile?.age ?? null };
  const plan = fiPlan(fiBase, d.fi);
  // target 0 with spending > 0: income that continues already covers it
  const yearsToFi = plan.years_to_fi, fiProgress = plan.target ? investable / plan.target : burn > 0 ? 1 : null;

  const history = (d.history ?? []).filter(h => h.date < today).sort((p, q) => p.date.localeCompare(q.date))
    .map(h => ({ date: h.date, net_worth: h.net_worth, investable: h.investable }));
  history.push({ date: today, net_worth: netWorth, investable, current: true });

  const amounts = {
    take_home_monthly: takeHome, gross_monthly: grossM, taxes_monthly: taxes, other_deductions_monthly: otherDed,
    other_income_monthly: otherIncome, continuing_income_monthly: continuingIncome, income_monthly: income,
    expenses_monthly: expTotal, debt_payments_monthly: debtPay,
    debt_balance: debtBal, employee_401k_monthly: employee401k, employer_401k_monthly: employer401k,
    saved_from_pay_monthly: savedFromPay, surplus_monthly: surplus, cash, investable, assets, net_worth: netWorth,
    expenses, buckets, allocation: alloc, liquid_cash: liquid, cd_accessible: cdAccess, emergency_cash: emergencyCash,
    cds, cash_by_type: cashByType, projection: plan.projection, annual_investment_contributions: annualContrib, history,
    spending_monthly: burn, fi_base: fiBase, fi_plan: plan,
    real_estate: props.length ? { value: sum(props.map(p => p.value)), loan_balance: sum(props.map(p => p.loan_balance)), equity: propEquity,
      housing, residence_housing: residenceHousing, properties: props } : null,
  };

  const ratios = {
    savings_rate: savingsRate,
    taxes_share_of_gross: taxes === null ? null : taxes / grossM,
    expenses_share_of_income: ratio(expTotal, income),
    debt_payments_share_of_income: ratio(debtPay, income),
    surplus_share_of_income: ratio(surplus, income),
    other_income_share_of_income: ratio(otherIncome, income),
    continuing_income_share_of_spending: ratio(continuingIncome, burn),
    employer_contribution_share_of_gross: ratio(employer401k, grossM),
    emergency_fund_months: efMonths,
    liquid_cash_months: liquidMonths,
    cash_mix: cash ? Object.fromEntries(Object.entries(cashByType).filter(([, v]) => v).map(([t, v]) => [t, v / cash])) : {},
    cash_blended_apr: cashBlendedApr,
    cash_share_at_zero_rate: cashZeroRateShare,
    cds: cds.map(c => ({ name: c.name, apr: c.apr, term_months: c.term_months, renews: c.renews,
      days_to_maturity: c.days_to_maturity, lapsed: c.lapsed, share_of_cash: ratio(c.balance, cash) })),
    debt_to_income: dti,
    debt_balance_to_annual_gross: ratio(debtBal, grossIncomeM * 12),
    net_worth_to_annual_gross: ratio(netWorth, grossIncomeM * 12),
    investable_to_annual_spend: ratio(investable, burn * 12),
    fi_progress: fiProgress,
    years_to_fi: yearsToFi,
    retirement: {
      withdrawal_rate: plan.settings.withdrawal_rate, target_multiple_of_annual_spending: 1 / plan.settings.withdrawal_rate,
      real_return: plan.settings.real_return, retirement_tax_rate: plan.settings.retirement_tax_rate,
      stop_working_in_years: plan.settings.retire_in_years, tax_deferred_share_of_investable: fiBase.tax_deferred_share,
      take_home_after_stopping_share_of_current_spending: plan.at_retirement.share_of_spending, // withdrawals after tax + continuing income
      money_lasts_years: plan.at_retirement.lasts_years, // null = 30+ years
    },
    stock_share: stockPct,
    single_stock_share: singlePct,
    expense_mix: expTotal ? Object.fromEntries(Object.entries(expenses).sort((p, q) => q[1] - p[1]).map(([k, v]) => [k, v / expTotal])) : {},
    tax_bucket_mix: assets ? Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v / assets])) : {},
    allocation_mix: investable ? Object.fromEntries(Object.entries(alloc).filter(([k]) => k !== "cash").map(([k, v]) => [k, v / investable])) : {},
    debts: debts.map(x => ({ name: x.name || "debt", apr: x.apr, share_of_total_debt: ratio(x.balance, debtBal),
      months_to_payoff_at_minimum: payoffMonths(x.balance, x.apr, x.min_payment) })),
    real_estate: props.length ? {
      housing_to_gross: residences.length ? ratio(residenceHousing, grossIncomeM) : null, // front-end ratio: where you live
      total_debt_payments_to_gross: ratio(housing + debtPay, grossIncomeM),             // back-end ratio: every loan
      housing_share_of_income: ratio(housing, income),
      equity_share_of_net_worth: netWorth > 0 ? propEquity / netWorth : null,
      properties: props.map(p => ({ name: p.name, residence: p.residence, loan_to_value: ratio(p.loan_balance, p.value),
        loans: p.loans.map(l => ({ name: l.name, apr: l.apr, months_to_payoff: l.months_to_payoff })) })), // 0 = paid off, null = never
    } : null,
  };

  // ---- checks (amount-free details)
  const checks = [];
  const C = (key, label, status, value, unit, detail) => checks.push({ key, label, status, value, unit, detail });
  const outflows = props.length ? "expenses, housing, and minimum debt payments" : "expenses and minimum debt payments";
  const incomeWord = otherIncome ? "take-home plus other income" : "take-home pay";
  if (surplus < 0) C("cash_flow", "Monthly cash flow", "act", ratio(surplus, income), "%", `Monthly ${outflows} exceed ${incomeWord}.`);
  else C("cash_flow", "Monthly cash flow", "ok", ratio(surplus, income), "%", `${incomeWord[0].toUpperCase() + incomeWord.slice(1)} covers ${outflows}.`);
  if (savingsRate !== null) C("savings_rate", "Savings rate", savingsRate >= 0.2 ? "ok" : savingsRate >= 0.1 ? "watch" : "act", savingsRate, "%",
    `Includes 401k employee+employer and savings from ${incomeWord}. Benchmarks: <10% low, 10-20% moderate, 20%+ strong.`);
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
    `Share of available employer match you are contributing enough to receive. Contributing ${+(fullAt * 100).toFixed(2)}% of salary gets the full match` +
    (ret.match_tiers ? ` (tiered: ${ret.match_tiers.map((t, i) => `${+(t.rate * 100).toFixed(2)}% of the ${i ? "next" : "first"} ${+(t.pct * 100).toFixed(2)}%`).join(", then ")}).` : "."));
  const grossWord = otherIncome ? "gross income (salary plus other income)" : "gross income";
  if (dti !== null) C("dti", props.length ? "Debt-to-income, excluding housing" : "Debt-to-income (payments / gross)", dti < 0.15 ? "ok" : dti <= 0.36 ? "watch" : "act", dti, "%",
    "Under 15% comfortable; lenders commonly cap around 36%.");
  if (props.length) {
    const H = ratios.real_estate, front = H.housing_to_gross, back = H.total_debt_payments_to_gross;
    if (front !== null) C("housing", "Housing cost (front-end ratio)", front <= 0.28 ? "ok" : front <= 0.36 ? "watch" : "act", front, "%",
      `Loan payments plus property tax, insurance, and HOA for where you live, over ${grossWord}. Common guideline: 28% or less.`);
    if (back !== null) C("dti_total", "Debt-to-income, including housing (back-end)", back <= 0.36 ? "ok" : back <= 0.43 ? "watch" : "act", back, "%",
      `Payments and costs for every property plus all other debt payments, over ${grossWord}. Lenders look for 36% or less; 43% is a common ceiling.`);
    const resValue = sum(residences.map(p => p.value)), resLoans = residences.flatMap(p => p.loans).filter(l => l.balance > 0);
    if (resValue > 0) {
      const eq = 1 - sum(resLoans.map(l => l.balance)) / resValue, months = resLoans.map(l => l.months_to_payoff);
      C("home_equity", "Home equity", eq >= 0.2 ? "ok" : "watch", eq, "%", !resLoans.length ? "No mortgage; the home is owned outright."
        : "Share of your home's estimated value you own. Below 20%, conventional loans usually carry PMI. " +
          (months.includes(null) ? "At current payments a loan on it never pays off."
            : `At current payments ${resLoans.length > 1 ? "the last loan is" : "it is"} paid off in ${(Math.max(...months) / 12).toFixed(1)} years.`));
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
    `Investable assets vs ${+(1 / plan.settings.withdrawal_rate).toFixed(1)}x annual spending (${pctTxt(plan.settings.withdrawal_rate)} withdrawal rate). ` +
    `Years to reach at ${pctTxt(plan.settings.real_return)} real return and current contributions: ${yearsToFi ?? "n/a"}.`);

  return { amounts, ratios, checks, growth: growth(history), assumptions, currency: d.currency ?? DEFAULT_CURRENCY };
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
  L.push("", "## Cash flow shape (share of monthly income: take-home pay plus other income)", "");
  if (r.other_income_share_of_income) L.push(`- other income (e.g. rent) share of income: ${fmtValue(r.other_income_share_of_income, "%")}; ` +
    `the part that continues after stopping work covers ${fmtValue(r.continuing_income_share_of_spending, "%")} of current spending`);
  if (r.real_estate) L.push(`- housing (loan payments, property tax, insurance, HOA) share of income: ${fmtValue(r.real_estate.housing_share_of_income, "%")}`);
  for (const k of ["expenses_share_of_income", "debt_payments_share_of_income", "surplus_share_of_income"])
    L.push(`- ${k.replace(/_/g, " ")}: ${fmtValue(r[k], "%")}`);
  L.push(`- employer 401k contribution as share of gross: ${fmtValue(r.employer_contribution_share_of_gross, "%")}`);
  L.push("", "## Expense mix", "", ...Object.entries(r.expense_mix).map(([k, v]) => `- ${k}: ${fmtPct(v)}`));
  L.push("", "## Balance sheet shape", "",
    `- net worth / annual gross income: ${fmtValue(r.net_worth_to_annual_gross, "x")}`,
    `- investable assets / annual spending: ${fmtValue(r.investable_to_annual_spend, "x")}`,
    `- total debt / annual gross income: ${fmtValue(r.debt_balance_to_annual_gross, "x")}`,
    "- account tax treatment mix: " + Object.entries(r.tax_bucket_mix).map(([k, v]) => `${k} ${fmtPct(v)}`).join(", "),
    "- investment allocation (excl. cash accounts): " + Object.entries(r.allocation_mix).map(([k, v]) => `${k} ${fmtPct(v)}`).join(", "));
  if (r.real_estate) {
    const h = r.real_estate, payoff = m => m === null ? "never (payment below interest)" : m === 0 ? "paid off" : `${(m / 12).toFixed(1)} years`;
    L.push("", "## Real estate", "",
      `- housing cost where you live / gross income (front-end): ${fmtValue(h.housing_to_gross, "%")}`,
      `- all debt payments incl. every property / gross income (back-end): ${fmtValue(h.total_debt_payments_to_gross, "%")}`,
      `- property equity share of net worth: ${fmtValue(h.equity_share_of_net_worth, "%")}`);
    for (const p of h.properties)
      L.push(`- ${p.name} (${p.residence ? "lives here" : "not lived in"}): loan-to-value ${fmtValue(p.loan_to_value, "%")}` +
        (p.loans.length ? "; " + p.loans.map(l => `${l.name} at ${pctTxt(l.apr)}, payoff at current payment ${payoff(l.months_to_payoff)}`).join("; ") : "; no loans"));
  }
  const rp = r.retirement;
  L.push("", "## Retirement plan (today's dollars, user-set assumptions)", "",
    `- withdrawal rate ${pctTxt(rp.withdrawal_rate)} (target ${+rp.target_multiple_of_annual_spending.toFixed(1)}x annual spending); return ${pctTxt(rp.real_return)} a year after inflation`,
    `- years to target if contributions continue: ${r.years_to_fi ?? "not reached"}`,
    `- stops working (no job income) in ${rp.stop_working_in_years} years; after-tax withdrawals plus other income that continues then cover ` +
      `${fmtValue(rp.take_home_after_stopping_share_of_current_spending, "%")} of current spending (the target is reduced by that continuing income)`,
    `- ${pctTxt(rp.tax_deferred_share_of_investable)} of investable assets are tax-deferred, taxed at an assumed ${pctTxt(rp.retirement_tax_rate)} on withdrawal; Social Security not included unless entered as other income`,
    `- money lasts: ${rp.money_lasts_years === null ? "30+ years" : `${rp.money_lasts_years} years`} at that withdrawal`);
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
    if (k === "take_home_monthly" && a.other_income_monthly) rows.push(["other_income_monthly", a.other_income_monthly]);
    if (k === "debt_payments_monthly" && a.real_estate) rows.push(["housing_monthly", a.real_estate.housing]);
    if (k === "debt_balance" && a.real_estate) rows.push(["property_value", a.real_estate.value], ["property_loans", a.real_estate.loan_balance]);
  }
  const lines = ["LOCAL REPORT (contains amounts; do not share)", ""];
  const { money } = moneyFormat(A.currency ?? DEFAULT_CURRENCY);
  for (const [k, v] of rows) lines.push(`  ${k.padEnd(28)} ${money(v).padStart(14)}`);
  return lines.join("\n") + "\n\n" + exportMarkdown(A);
}

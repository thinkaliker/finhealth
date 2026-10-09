// Page controller. Alpine (CSP build) handles the form; calculations come from finhealth.js,
// results and charts from charts.js. Template expressions only reference properties and methods
// defined here, which is what the CSP build requires (no eval).
import Alpine from "./vendor/alpine-csp.esm.min.js";
import { normalize, analyze, exportMarkdown, todayISO, addMonths, BIWEEKLY_TO_MONTHLY } from "./finhealth.js";
import { renderResults, drawCharts } from "./charts.js";
import { detectStore } from "./store.js";

let nextId = 1;
const LISTS = ["expenses", "debts", "accounts", "history"];

/** Shape data for editing: every section present, every list row tagged with a stable _id for x-for keys. */
function forEditing(d) {
  const out = { ...d };
  for (const s of ["income", "retirement", "profile"]) out[s] = { ...(d[s] ?? {}) };
  for (const l of LISTS) out[l] = (d[l] ?? []).map(r => ({ ...r, _id: nextId++ }));
  for (const a of out.accounts) if (a.allocation) a.allocation = { ...a.allocation };
  if (d.savings) out.savings = { ...d.savings };
  if (d.home) out.home = { ...d.home };
  return out;
}
/** Strip editor-only keys (leading underscore) and proxies. */
const plain = d => JSON.parse(JSON.stringify(d, (k, v) => (k.startsWith("_") ? undefined : v)));
const blank = () => ({ income: {}, retirement: {}, profile: {}, expenses: [], debts: [], accounts: [], history: [] });
const money = v => (v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString();

/**
 * Pointer drag from a row's grip. Other rows slide to show the drop slot and the page scrolls near the
 * viewport edges; onDrop(from, to) runs once on release, so Alpine never moves the row mid-drag.
 */
let dragging = false;
function dragRows(ev, onDrop) {
  if (dragging) return; // a second finger on another grip
  dragging = true;
  const grip = ev.currentTarget, row = grip.closest("[data-drag]"), box = row.parentElement;
  const rows = [...box.children].filter(r => r.hasAttribute("data-drag"));
  const from = rows.indexOf(row);
  const boxes = rows.map(r => { const b = r.getBoundingClientRect(); return { top: b.top + scrollY, bottom: b.bottom + scrollY }; });
  const me = boxes[from], next = boxes[from + 1], prev = boxes[from - 1];
  const shift = me.bottom - me.top + (next ? next.top - me.bottom : prev ? me.top - prev.bottom : 0);
  const minDy = boxes[0].top - me.top, maxDy = boxes[boxes.length - 1].bottom - me.bottom;
  const startY = ev.clientY + scrollY, headerH = document.querySelector("header")?.offsetHeight ?? 0;
  let y = ev.clientY, to = from, raf = 0;

  const update = () => {
    const dy = Math.min(Math.max(y + scrollY - startY, minDy), maxDy), top = me.top + dy, bottom = me.bottom + dy;
    to = from;
    boxes.forEach((b, j) => {
      const mid = (b.top + b.bottom) / 2;
      if (j < from && top < mid) to--;
      if (j > from && bottom > mid) to++;
    });
    rows.forEach((r, j) => {
      const t = j === from ? dy : from < j && j <= to ? -shift : to <= j && j < from ? shift : 0;
      r.style.transform = t ? `translateY(${t}px)` : "";
    });
  };
  // auto-scroll near the edges, only while more of the list is hidden in that direction
  const EDGE = 48;
  const tick = () => {
    let v = y < headerH + EDGE ? -(headerH + EDGE - y) / 6 : y > innerHeight - EDGE ? (y - innerHeight + EDGE) / 6 : 0;
    v = Math.max(-16, Math.min(16, v));
    if ((v < 0 && boxes[0].top - scrollY < headerH) || (v > 0 && boxes[boxes.length - 1].bottom - scrollY > innerHeight)) {
      scrollBy(0, v); update();
    }
    raf = requestAnimationFrame(tick);
  };
  const move = e => { y = e.clientY; update(); };
  const end = () => {
    dragging = false;
    cancelAnimationFrame(raf);
    grip.removeEventListener("pointermove", move);
    box.classList.remove("sorting"); // before clearing transforms, so rows don't animate back
    row.classList.remove("dragging");
    for (const r of rows) r.style.transform = "";
    if (to !== from) onDrop(from, to);
  };
  grip.setPointerCapture(ev.pointerId);
  grip.addEventListener("pointermove", move);
  grip.addEventListener("lostpointercapture", end, { once: true }); // fires after pointerup and pointercancel
  box.classList.add("sorting");
  row.classList.add("dragging");
  raf = requestAnimationFrame(tick);
}

Alpine.data("app", () => ({
  data: blank(),
  savedSnap: "",
  mode: "",
  label: "",
  error: "",
  note: "",
  tab: "inputs",
  loading: true,
  onboarding: false,
  sums: {},
  accountTypes: [
    { value: "cash", label: "Checking / savings" }, { value: "hysa", label: "High-yield savings" }, { value: "cd", label: "CD" },
    { value: "brokerage", label: "Brokerage" }, { value: "401k", label: "401(k)" }, { value: "403b", label: "403(b)" },
    { value: "traditional_ira", label: "Traditional IRA" }, { value: "roth_ira", label: "Roth IRA" },
    { value: "roth_401k", label: "Roth 401(k)" }, { value: "hsa", label: "HSA" },
  ],
  payPeriods: [{ value: "month", label: "per month" }, { value: "biweekly", label: "every 2 weeks" }],
  allocKeys: [
    { key: "stocks", label: "Stocks" }, { key: "bonds", label: "Bonds" }, { key: "cash", label: "Cash" },
    { key: "single_stock", label: "1 stock" }, { key: "other", label: "Other" },
  ],

  async init() {
    this._store = await detectStore();
    this.mode = this._store.mode;
    this.label = this._store.label;
    try {
      const d = this._store.initial !== undefined ? this._store.initial : await this._store.load();
      if (d == null) this.onboarding = true;
      else this.setData(d, true);
    } catch (e) {
      this.error = e.message;
      this.onboarding = true;
    }
    this.loading = false;
    this.$watch("data", () => this.changed());
    let lastW = 0, rz;
    new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w === lastW) return;
      lastW = w; clearTimeout(rz); rz = setTimeout(drawCharts, 120);
    }).observe(this.$refs.results);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.recompute());
    addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (this.isDirty()) this.save(); } });
    addEventListener("beforeunload", e => { if (this.isDirty()) { e.preventDefault(); e.returnValue = ""; } });
    if (matchMedia("(max-width: 1000px)").matches && !this.onboarding) this.tab = "results";
  },

  // ---------------------------------------------------------------- state
  setData(d, saved) {
    normalize(d); // validate before accepting; throws with a readable message
    this.data = forEditing(d);
    this.savedSnap = saved ? this.snap() : "";
    this.onboarding = false;
    this.recompute();
  },
  snap() { return JSON.stringify(plain(this.data)); },
  isDirty() { return !this.onboarding && this.snap() !== this.savedSnap; },
  changed() { clearTimeout(this._t); this._t = setTimeout(() => this.recompute(), 200); },
  recompute() {
    let n, A;
    try {
      n = normalize(plain(this.data));
      A = analyze(n, todayISO());
    } catch (e) { this.error = e.message; return; }
    this.error = "";
    A.export_md = exportMarkdown(A);
    this._current = { A, n };
    const a = A.amounts;
    this.sums = {
      income: money(a.take_home_monthly) + " / mo",
      retirement: money(a.employee_401k_monthly + a.employer_401k_monthly) + " / mo",
      savings: n.savings ? money(a.saved_from_pay_monthly) + " / mo" : "assumed: full surplus",
      expenses: money(a.expenses_monthly) + " / mo",
      debts: n.debts.length + " · " + money(a.debt_balance),
      home: a.home ? money(a.home.housing) + " / mo · equity " + money(a.home.equity) : "off",
      accounts: n.accounts.length + " · " + money(a.assets),
      history: n.history.length + " snapshot" + (n.history.length === 1 ? "" : "s"),
    };
    renderResults(this.$refs.results, A, n);
  },

  // ---------------------------------------------------------------- persistence
  async save() {
    try {
      const n = normalize(plain(this.data));
      await this._store.save(n);
      this.savedSnap = this.snap();
      this.setNote("Saved " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      this.error = "";
    } catch (e) { this.error = "Not saved: " + e.message; }
  },
  async revert() {
    if (this.isDirty() && !confirm("Discard unsaved changes?")) return;
    try {
      const d = await this._store.load();
      if (d == null) { this.onboarding = true; this.data = blank(); this.savedSnap = ""; }
      else this.setData(d, true);
      this.note = "";
    } catch (e) { this.error = e.message; }
  },
  async loadExample() {
    try {
      const r = await fetch("example.json", { cache: "no-store" });
      this.setData(await r.json(), false);
      this.setNote("Example loaded, not saved");
    } catch (e) { this.error = "Could not load example: " + e.message; }
  },
  startEmpty() { this.setData(blank(), false); this.note = ""; },
  pickFile() { this.$refs.file.click(); },
  async importFile(ev) {
    const f = ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    if (this.isDirty() && !confirm("Replace unsaved changes with the imported file?")) return;
    try {
      this.setData(JSON.parse(await f.text()), false);
      this.setNote(`Imported ${f.name}, not saved`);
    } catch (e) { this.error = `Import failed: ${e instanceof SyntaxError ? "not valid JSON" : e.message}`; }
  },
  exportFile() {
    let n;
    try { n = normalize(plain(this.data)); } catch (e) { this.error = "Fix this first: " + e.message; return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, ...n }, null, 2) + "\n"], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `finhealth-${todayISO()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  async clearBrowser() {
    if (!confirm("Delete the data stored in this browser? Export a copy first if you want to keep it.")) return;
    await this._store.clear();
    this.data = blank(); this.savedSnap = ""; this.onboarding = true; this.setNote("Browser data deleted");
    this.$refs.results.replaceChildren();
  },

  // ---------------------------------------------------------------- header text
  statusText() {
    if (this.error) return "";
    const dirty = this.isDirty();
    if (this.note && this.snap() === this._noteSnap) return this.note; // note still describes the current data
    return dirty ? "Unsaved changes" : this.savedSnap ? "Saved" : "";
  },
  setNote(text) { this.note = text; this._noteSnap = this.snap(); },
  modeText() { return this.mode === "file" ? this.label : this.mode === "browser" ? "Stored in this browser only" : ""; },
  isBrowser() { return this.mode === "browser"; },
  selectTab(t) { this.tab = t; if (t === "results") this.$nextTick(() => drawCharts()); },
  sum(k) { return this.sums[k] ?? ""; },

  // ---------------------------------------------------------------- field helpers
  pctVal(obj, key) {
    const v = obj?.[key];
    return v === null || v === undefined || v === "" ? "" : typeof v === "number" ? +(v * 100).toFixed(4) : v;
  },
  setPct(obj, key, ev) {
    const raw = ev.target.value.trim();
    obj[key] = raw === "" ? null : Number.isFinite(Number(raw)) ? Number(raw) / 100 : raw;
  },
  // take-home pay: stored as take_home_monthly or take_home_biweekly, whichever key is present
  isBiweekly() { return "take_home_biweekly" in this.data.income; },
  isMonthly() { return !this.isBiweekly(); },
  isPeriod(p) { return (p.value === "biweekly") === this.isBiweekly(); },
  /** Converts the amount on switch so results don't jump before the user types their paycheck. */
  setPayPeriod(ev) {
    const inc = this.data.income, toBiweekly = ev.target.value === "biweekly";
    if (toBiweekly === this.isBiweekly()) return;
    const v = Number(toBiweekly ? inc.take_home_monthly : inc.take_home_biweekly) || 0;
    const conv = toBiweekly ? v / BIWEEKLY_TO_MONTHLY : v * BIWEEKLY_TO_MONTHLY;
    delete inc.take_home_monthly; delete inc.take_home_biweekly;
    inc[toBiweekly ? "take_home_biweekly" : "take_home_monthly"] = v ? Math.round(conv * 100) / 100 : null;
  },
  takeHomeHint() {
    if (!this.isBiweekly()) return "Net pay deposited to your bank.";
    const m = (Number(this.data.income.take_home_biweekly) || 0) * BIWEEKLY_TO_MONTHLY;
    return `Net pay per paycheck. Averages ${money(m)} / month (26 paychecks a year).`;
  },
  hasSavings() { return !!this.data.savings; },
  toggleSavings(ev) {
    if (ev.target.checked) this.data.savings = { monthly_to_investments: 0, monthly_to_cash: 0 };
    else delete this.data.savings;
  },
  hasHome() { return !!this.data.home; },
  toggleHome(ev) {
    if (ev.target.checked) this.data.home = { value: 0, mortgage_balance: 0, mortgage_apr: 0, mortgage_payment: 0, costs_monthly: 0 };
    else delete this.data.home;
  },

  // ---------------------------------------------------------------- lists
  remove(list, i) { this.data[list].splice(i, 1); },
  moveRow(list, from, to) { const a = this.data[list]; a.splice(to, 0, a.splice(from, 1)[0]); },
  dragStart(list, ev) {
    if (ev.button !== 0) return;
    ev.preventDefault(); // no text selection or focus change while dragging
    dragRows(ev, (from, to) => this.moveRow(list, from, to));
  },
  dragKey(list, i, ev) {
    const d = ev.key === "ArrowUp" ? -1 : ev.key === "ArrowDown" ? 1 : 0;
    if (!d) return;
    ev.preventDefault();
    const to = i + d, box = ev.currentTarget.closest("[data-drag]").parentElement;
    if (to < 0 || to >= this.data[list].length) return;
    this.moveRow(list, i, to);
    this.$nextTick(() => box.querySelectorAll(":scope > [data-drag] .grip")[to]?.focus());
  },
  addExpense() {
    this.data.expenses.push({ name: "", amount: 0, _id: nextId++ });
    this.$nextTick(() => this.$root.querySelector("#sec-expenses .row:last-of-type input")?.focus());
  },
  addDebt() { this.data.debts.push({ name: "", balance: 0, apr: 0, min_payment: 0, _id: nextId++ }); },
  addAccount() { this.data.accounts.push({ name: "", type: "brokerage", balance: 0, allocation: { stocks: 1 }, _id: nextId++ }); },
  addSnapshot() { this.data.history.push({ date: todayISO(), net_worth: 0, investable: 0, _id: nextId++ }); },
  recordToday() {
    const a = this._current?.A.amounts;
    if (!a) return;
    const row = { date: todayISO(), net_worth: Math.round(a.net_worth), investable: Math.round(a.investable) };
    const ex = this.data.history.find(h => h.date === row.date);
    if (ex) Object.assign(ex, row); else this.data.history.push({ ...row, _id: nextId++ });
    this.data.history.sort((p, q) => String(p.date).localeCompare(String(q.date)));
  },
  hasDebts() { return this.data.debts.length > 0; },
  hasHistory() { return this.data.history.length > 0; },

  // ---------------------------------------------------------------- accounts
  isCashLike(a) { return a.type === "cash" || a.type === "hysa" || a.type === "cd"; },
  isInvestment(a) { return !this.isCashLike(a); },
  hasApr(a) { return a.type === "hysa" || a.type === "cd"; },
  isCd(a) { return a.type === "cd"; },
  setType(a, ev) {
    const prev = a.type;
    a.type = ev.target.value;
    if (this.isCashLike(a)) delete a.allocation; else a.allocation ??= { stocks: 1 };
    if (a.type !== "cd") for (const k of ["maturity_date", "term_months", "penalty_months", "renews"]) delete a[k];
    if (this.hasApr(a)) a.apr ??= 0; else delete a.apr;
    if (a.type === "cd" && prev !== "cd") Object.assign(a, { term_months: 12, maturity_date: addMonths(todayISO(), 12), penalty_months: 3, renews: false });
  },
  allocPct(a, key) { return this.pctVal(a.allocation, key); },
  setAlloc(a, key, ev) {
    const raw = ev.target.value.trim();
    if (raw === "" || Number(raw) === 0) delete a.allocation[key];
    else a.allocation[key] = Number.isFinite(Number(raw)) ? Number(raw) / 100 : raw;
  },
  allocTotal(a) { return Object.values(a.allocation ?? {}).reduce((s, v) => s + (Number(v) || 0), 0); },
  allocBad(a) { return Math.abs(this.allocTotal(a) - 1) > 0.01; },
  allocText(a) { return `Allocation total ${+(this.allocTotal(a) * 100).toFixed(1)}%` + (this.allocBad(a) ? " — must be 100%" : ""); },
  renewNote(a) {
    return a.renews ? "Maturity rolls forward by the term each time it passes, so this rung stays current without editing."
      : "After maturity this CD is flagged until you update or remove it.";
  },
  rowKey(r) { return r._id; },
  inputId(prefix, r) { return prefix + "-" + r._id; },
}));

Alpine.start();

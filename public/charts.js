// Results view: check cards, charts (hand-built SVG/HTML), and the LLM export panel.
// Plain DOM code; all labels go through textContent. Colors come from CSS custom properties so
// light/dark steps are chosen in styles.css, not computed here.
import { CASH_LIKE, todayISO } from "./finhealth.js";

const S = { analysis: null, data: null, growthView: "amounts", root: null };
const NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------- helpers
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "style") e.style.cssText = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
function sv(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const money = v => (v < 0 ? "−" : "") + nf0.format(Math.abs(Math.round(v)));
const moneyShort = v => {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
  return s + Math.round(a);
};
const pct = (v, d = 0) => v == null ? "n/a" : (v * 100).toFixed(d) + "%";
const today = () => todayISO();
const fmtDate = s => new Date(s + "T00:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" });
const pretty = k => k.replace(/_/g, " ");

// ---------------------------------------------------------------- tooltip
let tip = null;
const ensureTip = () => tip ??= document.body.appendChild(el("div", { id: "tip", role: "tooltip" }));
function showTip(evOrEl, title, rows) {
  ensureTip();
  tip.replaceChildren();
  if (title) tip.append(el("div", { class: "t", text: title }));
  for (const r of rows) {
    const line = el("div", { class: "r" });
    if (r.color) line.append(el("i", { style: `background:${r.color}` + (r.dash ? ";background:none;border-top:2px dashed " + r.color : "") }));
    line.append(el("b", { text: r.value }), el("span", { text: r.name }));
    tip.append(line);
  }
  tip.style.display = "block";
  let x, y;
  if (evOrEl instanceof Event && evOrEl.clientX != null) { x = evOrEl.clientX; y = evOrEl.clientY; }
  else { const b = (evOrEl.target || evOrEl).getBoundingClientRect(); x = b.left + b.width / 2; y = b.top; }
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 14, top = y - th - 10;
  if (left + tw > innerWidth - 8) left = x - tw - 14;
  if (top < 8) top = y + 16;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = top + "px";
}
const hideTip = () => { if (tip) tip.style.display = "none"; };
function hoverable(node, getTip) {
  node.tabIndex = 0;
  node.addEventListener("pointermove", e => { const [t, r] = getTip(); showTip(e, t, r); });
  node.addEventListener("focus", e => { const [t, r] = getTip(); showTip(e, t, r); });
  node.addEventListener("pointerleave", hideTip);
  node.addEventListener("blur", hideTip);
}

const ALLOC_KEYS = [["stocks", "Stocks"], ["bonds", "Bonds"], ["cash", "Cash"], ["single_stock", "1 stock"], ["other", "Other"]];
// color follows the entity: fixed slot per key, never by rank
const COLORS = {
  alloc: { stocks: "--s1", bonds: "--s2", cash: "--s3", single_stock: "--s4", other: "--s5" },
  tax: { cash: "--s3", taxable: "--s2", tax_deferred: "--s1", tax_free: "--s4" },
  flow: { expenses: "--s1", debt: "--s2", saved: "--s3", unassigned: "--s4", housing: "--s5" },
  cash: { cash: "--s3", hysa: "--s1", cd: "--s2" },
  home: { equity: "--s3", mortgage: "--s2" },
};
const CASH_NAMES = { cash: "Checking / savings", hysa: "High-yield savings", cd: "CDs" };

// ---------------------------------------------------------------- charts
function niceTicks(lo, hi, n = 4) {
  if (lo === hi) { hi = lo + 1; }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const t = []; for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5; v += step) t.push(+v.toFixed(10));
  return t;
}

/** Line chart with crosshair. series: [{name, values, color, dash}] over shared xs (numbers). */
function lineChart(host, { xs, xLabel, series, yFmt, yFmtLong, height = 240, zero = false, xTickFmt, markers = true, annotate, xStep }) {
  host.replaceChildren();
  const W = Math.max(280, host.clientWidth || 600), H = height;
  const m = { l: 48, r: W < 420 ? 76 : 92, t: 10, b: 26 };
  const all = series.flatMap(s => s.values).filter(v => v != null);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (zero) lo = Math.min(0, lo);
  const pad = (hi - lo) * 0.06 || 1; lo = zero && lo >= 0 ? lo : lo - pad; hi += pad;
  const ticks = niceTicks(lo, hi); lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const x0 = xs[0], x1 = xs[xs.length - 1];
  const X = x => m.l + (x1 === x0 ? (W - m.l - m.r) / 2 : (x - x0) / (x1 - x0) * (W - m.l - m.r));
  const Y = v => H - m.b - (v - lo) / (hi - lo) * (H - m.t - m.b);
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": series.map(s => s.name).join(", ") + " chart" }, host);
  for (const t of ticks) {
    sv("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: css("--grid"), "stroke-width": 1 }, svg);
    sv("text", { x: m.l - 8, y: Y(t) + 4, "text-anchor": "end" }, svg).textContent = yFmt(t);
  }
  // x ticks: as many evenly spaced data positions as fit ~80px apart
  const maxT = Math.max(2, Math.min(xs.length, Math.floor((W - m.l - m.r) / 80) + 1));
  let idx = Array.from({ length: maxT }, (_, k) => Math.round(k * (xs.length - 1) / (maxT - 1)));
  if (xStep) { // numeric x (e.g. years): ticks on round multiples that fit the width
    let step = xStep;
    while ((xs[xs.length - 1] - xs[0]) / step + 1 > maxT) step *= 2;
    idx = xs.map((x, i) => [x, i]).filter(([x]) => x % step === 0).map(([, i]) => i);
  }
  for (const i of [...new Set(idx)]) {
    sv("text", { x: X(xs[i]), y: H - 8, "text-anchor": i === 0 ? "start" : i === xs.length - 1 ? "end" : "middle" }, svg).textContent = xTickFmt(xs[i], i);
  }
  if (annotate) annotate(svg, X, Y, { m, W, H });
  for (const s of series) {
    const d = s.values.map((v, i) => v == null ? null : `${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`).filter(Boolean);
    sv("polyline", { points: d.join(" "), fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dash ? "5 4" : "none" }, svg);
    if (markers && !s.dash && xs.length <= 16)
      s.values.forEach((v, i) => v != null && sv("circle", { cx: X(xs[i]), cy: Y(v), r: 4, fill: s.color, stroke: css("--surface"), "stroke-width": 2 }, svg));
  }
  // direct end labels, nudged apart to avoid collisions
  const ends = series.map(s => ({ s, y: Y(s.values[s.values.length - 1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) {
    const lx = W - m.r + 8;
    sv("line", { x1: lx, x2: lx + 10, y1: e.y, y2: e.y, stroke: e.s.color, "stroke-width": 2, "stroke-dasharray": e.s.dash ? "3 2" : "none" }, svg);
    sv("text", { x: lx + 14, y: e.y + 4, class: "endlab" }, svg).textContent = e.s.short || e.s.name;
  }
  // crosshair layer: hit area covers the whole plot, snaps to nearest x
  const cross = sv("line", { y1: m.t, y2: H - m.b, stroke: css("--text-3"), "stroke-width": 1, visibility: "hidden" }, svg);
  const dots = series.map(s => sv("circle", { r: 5, fill: s.color, stroke: css("--surface"), "stroke-width": 2, visibility: "hidden" }, svg));
  const hit = sv("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent", tabindex: 0 }, svg);
  let cur = xs.length - 1;
  const show = (i, ev) => {
    cur = i;
    const x = X(xs[i]);
    cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
    series.forEach((s, k) => { const v = s.values[i]; if (v == null) return; dots[k].setAttribute("cx", x); dots[k].setAttribute("cy", Y(v)); dots[k].setAttribute("visibility", "visible"); });
    const b = svg.getBoundingClientRect(), scale = b.width / W;
    const at = ev && ev.clientX != null ? ev : { clientX: b.left + x * scale, clientY: b.top + m.t };
    showTip(at, xLabel(xs[i], i), series.map(s => ({ color: s.color, dash: s.dash, name: s.name, value: s.values[i] == null ? "n/a" : (yFmtLong || yFmt)(s.values[i]) })));
  };
  const hide = () => { cross.setAttribute("visibility", "hidden"); dots.forEach(d => d.setAttribute("visibility", "hidden")); hideTip(); };
  hit.addEventListener("pointermove", ev => {
    const b = svg.getBoundingClientRect(), px = (ev.clientX - b.left) * W / b.width;
    let best = 0; xs.forEach((x, i) => { if (Math.abs(X(x) - px) < Math.abs(X(xs[best]) - px)) best = i; });
    show(best, ev);
  });
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(cur));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") { show(Math.max(0, cur - 1)); e.preventDefault(); }
    if (e.key === "ArrowRight") { show(Math.min(xs.length - 1, cur + 1)); e.preventDefault(); }
  });
}

function legend(items) {
  return el("div", { class: "legend" }, ...items.map(it => el("span", {},
    el("i", { class: it.kind === "line" ? "k-line" : it.kind === "dash" ? "k-dash" : "k-rect", style: it.kind === "dash" ? "" : `background:${it.color}` }),
    it.name, it.value != null ? el("b", { text: it.value }) : null)));
}
function stackBar(segs, fmtVal) {
  const total = segs.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  return el("div", { class: "stack", role: "img", "aria-label": segs.map(s => `${s.name} ${pct(s.value / total)}`).join(", ") },
    ...segs.filter(s => s.value > 0).map(s => {
      const d = el("div", { style: `flex:${s.value} 1 0;background:${s.color}` });
      hoverable(d, () => [s.name, [{ color: s.color, name: pct(s.value / total, 1) + " of total", value: fmtVal(s.value) }]]);
      return d;
    }));
}
function table(head, rows) {
  return el("details", { class: "tbl" }, el("summary", { text: "Data table" }),
    el("table", {}, el("thead", {}, el("tr", {}, ...head.map(h => el("th", { text: h })))),
      el("tbody", {}, ...rows.map(r => el("tr", {}, ...r.map(c => el("td", { text: c })))))));
}
function card(title, sub, ...body) {
  return el("div", { class: "card" }, el("h2", { text: title }), sub ? el("p", { class: "sub", text: sub }) : null, ...body);
}

// ---------------------------------------------------------------- results
const ICON = { ok: "✓", watch: "!", act: "✕", info: "i" };
const STATUS_WORD = { ok: "OK", watch: "Watch", act: "Act", info: "Info" };
function fmtCheck(c) {
  if (c.value == null) return "n/a";
  if (c.unit.startsWith("%")) return pct(c.value, c.value > 0 && Math.abs(c.value) < 0.1 ? 1 : 0);
  if (c.unit === "days") return Math.round(c.value) + " days";
  if (c.unit === "months") return c.value.toFixed(1) + " mo";
  if (c.unit === "years") return Math.round(c.value) + " yr";
  return c.value.toFixed(2) + c.unit;
}

export function renderResults(root, analysis, data) {
  S.root = root; S.analysis = analysis; S.data = data;
  draw();
}

function draw() {
  const R = S.root, A = S.analysis;
  if (!A) return;
  const a = A.amounts, r = A.ratios;
  const C = k => css(k);
  R.replaceChildren();

  // checks
  R.append(el("div", { class: "checks" }, ...A.checks.map(c => el("div", { class: "check", "data-s": c.status },
    el("div", { class: "lab", text: c.label }),
    el("div", { class: "val", text: fmtCheck(c) }),
    el("span", { class: "badge", "data-s": c.status }, el("i", { "aria-hidden": "true", text: ICON[c.status] }), STATUS_WORD[c.status]),
    el("div", { class: "det", text: c.detail })))));

  // growth
  const segBtns = el("div", { class: "seg", role: "group", "aria-label": "Growth view" },
    ...[["amounts", "Amounts"], ["index", "Shape (index)"]].map(([v, t]) => el("button", { type: "button", text: t, "aria-pressed": S.growthView === v ? "true" : "false",
      onclick: () => { S.growthView = v; draw(); } })));
  R.append(el("div", { class: "card" },
    el("div", { class: "cardhead" }, el("div", {}, el("h2", { text: "Net worth over time" }),
      el("p", { class: "sub", text: S.growthView === "index" ? "First snapshot = 100. This is the view the LLM export receives." : "Snapshots plus today's computed values." })), segBtns),
    el("div", { id: "lg-growth" }), el("div", { class: "chart", id: "ch-growth" }), el("div", { id: "ft-growth" })));

  const grid = el("div", { class: "grid2" });
  // cash flow
  const debtPay = a.debt_payments_monthly, exp = a.expenses_monthly, th = a.take_home_monthly;
  const saved = Math.min(a.saved_from_pay_monthly, Math.max(0, a.surplus_monthly));
  const unassigned = Math.max(0, a.surplus_monthly - saved);
  const flow = [
    ...(a.home ? [{ name: "Housing", value: a.home.housing, color: C(COLORS.flow.housing) }] : []),
    { name: "Expenses", value: exp, color: C(COLORS.flow.expenses) },
    { name: "Debt payments", value: debtPay, color: C(COLORS.flow.debt) },
    { name: "Saved from pay", value: saved, color: C(COLORS.flow.saved) },
    { name: "Unassigned", value: unassigned, color: C(COLORS.flow.unassigned) },
  ];
  const pay401 = [
    { name: "Your 401k", value: a.employee_401k_monthly, color: C("--s1") },
    { name: "Employer 401k", value: a.employer_401k_monthly, color: C("--s3") },
  ];
  grid.append(card("Where take-home pay goes", "Per month. 401(k) money comes out before take-home and is shown separately.",
    a.surplus_monthly < 0 ? el("p", { class: "sub", style: "color:var(--critical);font-weight:600", text: `Spending exceeds take-home by ${money(-a.surplus_monthly)} / month.` }) : null,
    el("div", { class: "stacklab", text: `Take-home ${money(th)}` }), stackBar(flow, money),
    legend(flow.map(f => ({ ...f, value: `${money(f.value)} · ${pct(th ? f.value / th : 0)}` }))),
    el("div", { class: "stacklab", text: `Pre-tax retirement ${money(a.employee_401k_monthly + a.employer_401k_monthly)}` }), stackBar(pay401, money),
    legend(pay401.map(f => ({ ...f, value: money(f.value) }))),
    table(["Item", "Per month", "Share of take-home"], [...flow, ...pay401].map(f => [f.name, money(f.value), th ? pct(f.value / th, 1) : "n/a"]))));

  // expense mix
  const ex = Object.entries(a.expenses).sort((p, q) => q[1] - p[1]);
  const exMax = Math.max(...ex.map(e => e[1]), 1);
  grid.append(card("Expenses by category", `Total ${money(exp)} / month.`,
    ex.length ? el("div", {}, ...ex.map(([k, v]) => {
      const fill = el("div", { class: "fill", style: `width:${v / exMax * 100}%` });
      hoverable(fill, () => [k, [{ color: C("--s1"), name: pct(v / exp, 1) + " of expenses", value: money(v) }]]);
      return el("div", { class: "hbar" }, el("span", { class: "name", text: k, title: k }), el("div", { class: "track" }, fill),
        el("span", { class: "v" }, money(v), el("small", { text: pct(v / exp) })));
    })) : el("div", { class: "empty", text: "Add expense categories." }),
    table(["Category", "Per month", "Share"], ex.map(([k, v]) => [k, money(v), pct(v / exp, 1)]))));

  // portfolio
  const allocSegs = ALLOC_KEYS.map(([k, t]) => ({ name: t, value: a.allocation[k] || 0, color: C(COLORS.alloc[k]) })).filter(s => s.value > 0);
  const taxNames = { tax_deferred: "Tax-deferred", tax_free: "Tax-free", taxable: "Taxable", cash: "Cash accounts" };
  const taxSegs = ["tax_deferred", "tax_free", "taxable", "cash"].map(k => ({ name: taxNames[k], value: a.buckets[k] || 0, color: C(COLORS.tax[k]) })).filter(s => s.value > 0);
  const allocTotal = allocSegs.reduce((s, x) => s + x.value, 0), taxTotal = a.assets;
  grid.append(card("Portfolio", `Assets ${money(a.assets)} · investable ${money(a.investable)} · debt ${money(a.debt_balance)}.`,
    el("div", { class: "stacklab", text: "What it holds (all accounts)" }), stackBar(allocSegs, money),
    legend(allocSegs.map(s => ({ ...s, value: pct(s.value / (allocTotal || 1)) }))),
    el("div", { class: "stacklab", text: "How it is taxed" }), stackBar(taxSegs, money),
    legend(taxSegs.map(s => ({ ...s, value: pct(s.value / (taxTotal || 1)) }))),
    table(["Group", "Amount", "Share"], [...allocSegs.map(s => ["Holds: " + s.name, money(s.value), pct(s.value / (allocTotal || 1), 1)]),
      ...taxSegs.map(s => ["Tax: " + s.name, money(s.value), pct(s.value / (taxTotal || 1), 1)])])));

  // cash and CDs
  const cashTotal = a.cash;
  if (cashTotal > 0) {
    const cashSegs = CASH_LIKE.map(t => ({ name: CASH_NAMES[t], value: a.cash_by_type[t] || 0, color: C(COLORS.cash[t]) })).filter(x => x.value > 0);
    const cds = a.cds;
    const maxDays = Math.max(365, ...cds.map(c => c.days_to_maturity || 0));
    const fmtD = iso => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    grid.append(card("Cash and CDs",
      `Emergency fund ${r.emergency_fund_months?.toFixed(1) ?? "n/a"} months counting CDs, ${r.liquid_cash_months?.toFixed(1) ?? "n/a"} months from checking and savings alone. Blended APR ${pct(r.cash_blended_apr, 2)}.`,
      el("div", { class: "stacklab", text: `Cash ${money(cashTotal)}` }), stackBar(cashSegs, money),
      legend(cashSegs.map(x => ({ ...x, value: `${money(x.value)} · ${pct(x.value / cashTotal)}` }))),
      cds.length ? el("div", {},
        el("div", { class: "stacklab", text: "CD maturities (days from today)" }),
        ...cds.map(c => {
          const lapsed = c.lapsed, d = c.days_to_maturity;
          const color = lapsed ? C("--critical") : C(COLORS.cash.cd);
          const fill = el("div", { class: "fill", style: `width:${lapsed ? 100 : Math.max(1, d / maxDays * 100)}%;background:${color}` });
          hoverable(fill, () => [c.name, [
            { color, name: lapsed ? "past maturity, not renewing" : "matures " + fmtD(c.next_maturity), value: lapsed ? "lapsed" : d + " days" },
            { name: `APR · ${c.term_months}-mo term`, value: pct(c.apr, 2) },
            { name: "balance", value: money(c.balance) },
            { name: c.renews ? "renews at maturity" : "does not renew", value: c.renews ? "↻" : "—" },
            ...(c.penalty_if_withdrawn_now ? [{ name: "penalty if withdrawn now", value: money(c.penalty_if_withdrawn_now) }] : [])]]);
          return el("div", { class: "hbar" }, el("span", { class: "name", text: (c.renews ? "↻ " : "") + c.name, title: c.name }),
            el("div", { class: "track" }, fill),
            el("span", { class: "v" }, lapsed ? "lapsed" : d + " d", el("small", { text: pct(c.apr, 2) })));
        }),
        el("p", { class: "note", text: `↻ renews at maturity. CDs maturing within 90 days count in full toward the emergency fund; later ones count net of their early-withdrawal penalty.` })) : null,
      table(["Item", "Balance", "APR", "Matures", "Renews"], [
        ...cashSegs.filter(x => x.name !== "CDs").map(x => [x.name, money(x.value), "", "", ""]),
        ...cds.map(c => [c.name, money(c.balance), pct(c.apr, 2), c.lapsed ? "lapsed" : fmtD(c.next_maturity), c.renews ? "yes" : "no"])])));
  }

  // debts
  grid.append(card("Debts", r.debts.length ? "Months to pay off at the minimum payment." : "",
    r.debts.length ? el("div", {}, ...(() => {
      const mx = Math.max(...r.debts.map(d => d.months_to_payoff_at_minimum ?? 0), 12);
      return r.debts.map((d, i) => {
        const raw = S.data.debts[i] || {};
        const m = d.months_to_payoff_at_minimum, hi = d.apr >= 0.08;
        const fill = el("div", { class: "fill", style: `width:${m == null ? 100 : m / mx * 100}%;background:${hi ? C("--critical") : C("--s1")}` });
        hoverable(fill, () => [d.name || "debt", [{ color: hi ? C("--critical") : C("--s1"), name: `APR ${pct(d.apr, 1)}`, value: m == null ? "never at minimum" : m + " months" },
          { name: "balance", value: money(raw.balance || 0) }]]);
        return el("div", { class: "hbar" }, el("span", { class: "name", text: d.name || "debt", title: d.name }), el("div", { class: "track" }, fill),
          el("span", { class: "v" }, m == null ? "never" : m + " mo", el("small", { text: pct(d.apr, 1) + (hi ? " ⚠" : "") })));
      });
    })(), el("p", { class: "note", text: "Red bars are at or above 8% APR." })) : el("div", { class: "empty", text: "No debts." }),
    r.debts.length ? table(["Debt", "Balance", "APR", "Min / mo", "Payoff (months)"], r.debts.map((d, i) => {
      const raw = S.data.debts[i] || {};
      return [d.name, money(raw.balance || 0), pct(d.apr, 1), money(raw.min_payment || 0), d.months_to_payoff_at_minimum ?? "never"];
    })) : null));

  // home
  if (a.home) {
    const h = a.home, H = r.home, m = H.mortgage_months_to_payoff;
    const segs = [
      { name: "Equity", value: Math.max(0, h.equity), color: C(COLORS.home.equity) },
      { name: "Mortgage", value: h.mortgage_balance, color: C(COLORS.home.mortgage) },
    ];
    grid.append(card("Home", `Value ${money(h.value)} · equity ${money(h.equity)} · housing ${money(h.housing)} / month.`,
      h.value > 0 ? el("div", {}, el("div", { class: "stacklab", text: "Who owns the home's value" }), stackBar(segs, money),
        legend(segs.map(s => ({ ...s, value: `${money(s.value)} · ${pct(s.value / h.value)}` })))) : el("div", { class: "empty", text: "Enter the home's value to see equity." }),
      el("p", { class: "note", text: `Housing is ${pct(H.housing_to_gross)} of gross income (guideline 28% or less); with other debt payments, ${pct(H.total_debt_payments_to_gross)} (guideline 36%). ` +
        (m === 0 ? "No mortgage." : m === null ? "At the current payment the mortgage never pays off." : `Mortgage paid off in ${(m / 12).toFixed(1)} years at the current payment.`) }),
      table(["Item", "Amount"], [["Home value", money(h.value)], ["Mortgage balance", money(h.mortgage_balance)], ["Equity", money(h.equity)],
        ["Mortgage payment / month", money(h.mortgage_payment)], ["Property tax, insurance, HOA / month", money(h.costs)]])));
  }
  R.append(grid);

  // FI projection
  const proj = a.projection;
  const fiYear = r.years_to_fi;
  R.append(card("Projection to financial independence",
    `Investable assets growing at 5% after inflation plus ${money(a.annual_investment_contributions)} / year of contributions, against 25× annual spending (${money(proj[0].target)}). ` +
    (fiYear == null ? "Target not reached within the horizon." : fiYear === 0 ? "Target already reached." : `Reached in about ${fiYear} years.`),
    legend([{ name: "Projected investable", kind: "line", color: C("--s1") }, { name: "Target (25× spending)", kind: "dash" }]),
    el("div", { class: "chart", id: "ch-proj" }),
    table(["Year", "Projected investable", "Target"], proj.filter((_, i) => i % 5 === 0 || i === proj.length - 1).map(p => [p.year, money(p.investable), money(p.target)]))));

  // export
  const pre = el("pre", { class: "export", text: A.export_md });
  R.append(card("LLM export", "Amount-free summary: ratios, durations, and indexes only. Paste this into an LLM.",
    el("div", { class: "addrow" },
      el("button", { class: "btn small", type: "button", text: "Copy", onclick: async e => {
        try { await navigator.clipboard.writeText(A.export_md); e.target.textContent = "Copied"; }
        catch { const rg = document.createRange(); rg.selectNodeContents(pre); getSelection().removeAllRanges(); getSelection().addRange(rg); e.target.textContent = "Selected — press Ctrl/Cmd+C"; }
        setTimeout(() => e.target.textContent = "Copy", 1600);
      } }),
      el("button", { class: "btn small", type: "button", text: "Download .md", onclick: () => {
        const u = URL.createObjectURL(new Blob([A.export_md], { type: "text/markdown" }));
        el("a", { href: u, download: `finance-summary-${today()}.md` }).click(); setTimeout(() => URL.revokeObjectURL(u), 1000);
      } })),
    pre, A.assumptions.length ? el("p", { class: "note", text: "Assumptions: " + A.assumptions.join(" ") }) : null));

  drawCharts();
}

export function drawCharts() {
  if (!S.root || !S.analysis) return;
  const A = S.analysis; if (!A) return;
  const a = A.amounts, C = k => css(k);
  const gHost = S.root.querySelector("#ch-growth");
  if (gHost) {
    const hist = a.history;
    S.root.querySelector("#lg-growth").replaceChildren(); S.root.querySelector("#ft-growth").replaceChildren();
    if (hist.length < 2) {
      gHost.replaceChildren(el("div", { class: "empty", text: "Add at least one past snapshot under History to see growth." }));
    } else {
      const xs = hist.map(h => new Date(h.date + "T00:00:00").getTime());
      const idx = S.growthView === "index";
      const base = hist[0];
      const val = (h, k) => idx ? (base[k] > 0 ? 100 * h[k] / base[k] : null) : h[k];
      const series = [
        { name: "Net worth", short: "Net worth", color: C("--s1"), values: hist.map(h => val(h, "net_worth")) },
        { name: "Investable", short: "Investable", color: C("--s2"), values: hist.map(h => val(h, "investable")) },
      ];
      S.root.querySelector("#lg-growth").append(legend(series.map(s => ({ name: s.name, kind: "line", color: s.color }))));
      lineChart(gHost, {
        xs, series, zero: !idx,
        yFmt: idx ? v => v.toFixed(0) : moneyShort,
        yFmtLong: idx ? v => v.toFixed(1) : money,
        xTickFmt: x => fmtDate(new Date(x).toISOString().slice(0, 10)),
        xLabel: (x, i) => fmtDate(hist[i].date) + (hist[i].current ? " (today)" : ""),
      });
      const g = A.growth;
      S.root.querySelector("#ft-growth").append(
        g.net_worth_cagr != null ? el("p", { class: "note", text: `Net worth CAGR ${pct(g.net_worth_cagr, 1)}${g.trend ? ", " + g.trend : ""}. ${g.note}` }) : "",
        table(["Date", "Net worth", "Investable", "NW index"], hist.map(h => [h.date + (h.current ? " (today)" : ""), money(h.net_worth), money(h.investable), base.net_worth > 0 ? (100 * h.net_worth / base.net_worth).toFixed(1) : "n/a"])));
    }
  }
  const pHost = S.root.querySelector("#ch-proj");
  if (pHost) {
    const proj = a.projection, fiYear = A.ratios.years_to_fi;
    lineChart(pHost, {
      xs: proj.map(p => p.year), zero: true, markers: false, xStep: 5,
      series: [
        { name: "Projected investable", short: "Projected", color: C("--s1"), values: proj.map(p => p.investable) },
        { name: "Target", short: "Target", color: C("--ref"), dash: true, values: proj.map(p => p.target) },
      ],
      yFmt: moneyShort, yFmtLong: money,
      xTickFmt: x => x === 0 ? "Now" : "+" + x + " yr",
      xLabel: x => x === 0 ? "Now" : `Year ${x} (${new Date().getFullYear() + x})`,
      annotate: fiYear ? (svg, X, Y, { m, H }) => {
        sv("line", { x1: X(fiYear), x2: X(fiYear), y1: m.t, y2: H - m.b, stroke: css("--text-3"), "stroke-width": 1, "stroke-dasharray": "2 3" }, svg);
        sv("text", { x: X(fiYear) - 4, y: m.t + 10, "text-anchor": "end" }, svg).textContent = `Target in ~${fiYear} yr`;
      } : null,
    });
  }
}


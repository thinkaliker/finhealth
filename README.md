# finhealth

Personal-finance health check that runs in your browser. Enter take-home pay, 401(k), expenses, debts, and accounts; it computes checks and charts locally and produces an **amount-free export** (ratios, durations, growth indexes) to paste into an LLM.

All code is plain JavaScript. One calculation module (`public/finhealth.js`) is shared by:

| Mode | How to run | Data lives in |
|---|---|---|
| Static webapp | GitHub Pages, or any static host serving `public/` | this browser's localStorage |
| Local server | `node cli.js serve data.json --open` | `data.json` on disk |
| CLI | `node cli.js export data.json` | `data.json` on disk |

Requires Node 18+ for the server and CLI. No npm dependencies. The page uses [Alpine.js](https://alpinejs.dev) (CSP build, vendored in `public/vendor/`) for the form; charts are hand-written SVG.

## Quick start

```sh
node cli.js init data.json              # copy the example data
node cli.js serve data.json --open      # web page + API at http://127.0.0.1:8765
node cli.js export data.json            # amount-free markdown for an LLM
node cli.js export data.json --json     # same, as JSON
node cli.js report data.json            # local report with amounts (don't share)
npm test
```

## Storage

The page decides where to save when it loads:

- **Served by `node cli.js serve`**: the server marks the page, and Save writes the JSON file (atomically, keeping `data.json.bak`).
- **Anywhere else** (GitHub Pages, `python -m http.server`): Save writes to localStorage. Nothing is uploaded. Browsers can clear this storage, and it does not sync between browsers or devices, so use **Export** to keep a file copy and **Import** to restore or move it. **Delete browser data** removes it.

Opening `index.html` directly from disk (`file://`) does not work, because browsers block ES modules there. Use the Node server or any static server.

## Privacy

- `index.html` sets a Content-Security-Policy: scripts only from the same origin, network requests only to the same origin, no `eval`. Even if the code were changed to send data somewhere, the browser would block requests to other domains.
- No third-party scripts, fonts, or analytics. Alpine is vendored, not loaded from a CDN.
- On GitHub Pages you run whatever is in the repo at load time. Review changes before you push.
- The Node server binds to 127.0.0.1, refuses requests with a foreign `Host` header (DNS rebinding), and only accepts JSON POSTs with no foreign `Origin`.

## API (Node server only)

| Route | Returns |
|---|---|
| `GET /api/data` | current data file contents |
| `POST /api/data` | validate, save, return the analysis |
| `POST /api/analyze` | analysis of the posted data, without saving |
| `GET /api/analysis` | analysis of the saved file (includes amounts) |
| `GET /api/export` | amount-free JSON |
| `GET /api/export.md` | amount-free markdown |

A static host has no API, so on GitHub Pages the export is available via the Copy/Download buttons on the page.

## Data file

JSON. See `public/example.json`.

```jsonc
{
  "version": 1,
  "currency":   "USD",                                           // optional; ISO code or "none"; set in the header
  "profile":    { "age": 34 },                                   // optional
  "income":     { "take_home_monthly": 6200, "gross_annual": 115000 },  // or "take_home_biweekly": 2860 per paycheck
  "retirement": { "employee_contribution_pct": 0.06, "employer_match_rate": 0.5,
                  "employer_match_limit_pct": 0.06, "employer_nonelective_pct": 0 },
  // tiered match instead of rate + limit: 100% of the first 4%, then 50% of the next 4%
  // "retirement": { ..., "match_tiers": [{ "rate": 1, "pct": 0.04 }, { "rate": 0.5, "pct": 0.04 }] },
  "savings":    { "monthly_to_investments": 800, "monthly_to_cash": 300 },  // optional
  "other_income": [{ "name": "Rent", "amount": 2200, "continues": true }],  // optional; monthly
  "properties": [                                                // optional; "residence": you live there
    { "name": "Home", "residence": true, "value": 420000, "costs_monthly": 520,
      "loans": [{ "name": "Mortgage", "balance": 310000, "apr": 0.0625, "payment": 1910 },
                { "name": "HELOC", "balance": 30000, "apr": 0.085, "payment": 400 }] }
  ],
  "fi":         { "withdrawal_rate": 0.04, "real_return": 0.05, "retire_in_years": 20,  // optional; set by the sliders
                  "retirement_tax_rate": 0.10 },
  "expenses":   [{ "name": "groceries", "amount": 650 }],
  "debts":      [{ "name": "credit card", "balance": 2300, "apr": 0.2399, "min_payment": 75 }],
  "accounts":   [
    { "name": "checking", "type": "cash", "balance": 4500 },
    { "name": "savings",  "type": "hysa", "balance": 7000, "apr": 0.041 },
    { "name": "CD rung 1", "type": "cd", "balance": 2500, "apr": 0.043, "maturity_date": "2026-12-15",
      "term_months": 12, "penalty_months": 3, "renews": true },
    { "name": "work 401k", "type": "401k", "balance": 98000, "allocation": { "stocks": 0.9, "bonds": 0.1 } }
  ],
  "history":    [{ "date": "2025-10-01", "net_worth": 121000, "investable": 132000 }]
}
```

Rates and percentages are fractions (`0.045` = 4.5%); the web form shows them as percents. Take-home pay is either `take_home_monthly` or `take_home_biweekly` (one paycheck), not both; biweekly is averaged to monthly as × 26 ÷ 12, so months with a third paycheck are spread across the year. Optional `other_deductions_monthly` / `other_deductions_biweekly` (health premiums, HSA/FSA, anything withheld besides taxes and 401k) works the same way. Taxes withheld are estimated as gross − your 401k − other deductions − take-home, so `gross_annual` should be before deductions and should include a bonus only if take-home does. Account types: `cash`, `hysa`, `cd`, `brokerage`, `401k`, `403b`, `traditional_ira`, `roth_ira`, `roth_401k`, `hsa`. Investment accounts take an `allocation` (`stocks`, `bonds`, `cash`, `single_stock`, `other`) summing to 1.

Other income (optional): money besides your paycheck, per month, as received (rent, side work, a pension). It adds to monthly income for cash flow and the savings rate, and to gross income for the debt-to-income checks. `continues: true` means it keeps paying after you stop working: it lowers the FI target and adds to take-home after you stop.

Real estate (`properties`, optional): each property has a `value`, `costs_monthly` (property tax, insurance, PMI, HOA), and `loans` whose `payment` is principal and interest only. Leave these out of `expenses` and `debts`. Net worth includes the equity in every property; loan payments plus costs for all properties are one monthly outflow ("housing") in cash flow, the emergency fund, and the FI target. The 28% housing check uses only properties marked `residence`; the 36%/43% check includes every property. Investable assets and FI progress exclude real estate. Rent you collect goes under `other_income`; rent you pay goes under `expenses`. Files with the older single `home` section load as one residence and are saved in the new form.

Financial independence (`fi`, set with the sliders on the results page; all optional): the target is annual spending ÷ `withdrawal_rate` (4% = 25×). Investable assets grow at `real_return` (after inflation, so everything is in today's dollars) plus invested contributions until `retire_in_years`, when job income stops; from then on, `withdrawal_rate` of that balance is withdrawn each year. Without `retire_in_years`, you stop working when the target is reached (else at 65 if age is set, else in 30 years). Take-home after you stop working taxes only withdrawals from tax-deferred accounts, at `retirement_tax_rate`, using today's account mix; Roth and HSA are tax-free, and brokerage gains tax, Social Security, and pensions aren't modeled.

CDs: `renews: true` models a ladder rung. Once `maturity_date` passes, the next maturity rolls forward by `term_months`. For the emergency fund, a CD maturing within 90 days counts in full; later ones count net of `penalty_months` of interest. A non-renewing CD past maturity raises a "watch" check.

## Checks

| Check | Formula | Thresholds |
|---|---|---|
| Cash flow | (income − expenses − housing − debt minimums) / income; income = take-home + other income | negative = act |
| Savings rate | (saved from pay + employee 401k + employer 401k) / (income + employee 401k + employer 401k) | <10% act, 10–20% watch |
| Emergency fund | (checking + HYSA + CDs at accessible value) / (expenses + housing + debt minimums) | <3 mo act, 3–6 watch |
| Taxes withheld | (gross − employee 401k − other deductions − take-home) / gross | info; negative = watch (inputs don't add up) |
| Match captured | match at your deferral / maximum match (single rate + limit, or tiers) | <100% act |
| Debt-to-income | debt minimums (excluding housing) / gross monthly income (salary + other income) | >36% act, 15–36% watch |
| Housing cost (with a residence) | (loan payments + property costs where you live) / gross monthly income | >36% act, 28–36% watch |
| Debt-to-income incl. housing (with property) | (payments + costs for every property + debt minimums) / gross monthly income | >43% act, 36–43% watch |
| Home equity (with a residence) | (value − loan balances) / value where you live; time until the last loan is paid off | <20% watch |
| High-interest debt | balances at APR ≥ 8% / annual gross | any = act |
| Concentration | single_stock / investable | >20% act, 10–20% watch |
| Allocation vs age | stock share vs (110 − age) | >15 pt gap = watch |
| CDs | days to next maturity; lapsed non-renewing CDs | lapsed = watch |
| Cash yield | balance-weighted APR across cash accounts | info |
| FI progress | investable / (annual spending ÷ withdrawal rate); years to reach at the set real return (defaults 4%, 5%) | info |

## Running on a server (e.g. a dev VM)

The server listens on 127.0.0.1 only and has no login, so don't expose it on a network port. Reach it over an SSH tunnel instead:

```sh
# on the VM
node cli.js serve ~/finhealth-data.json --port 8765

# on your laptop
ssh -L 8765:127.0.0.1:8765 user@vm
# then open http://127.0.0.1:8765
```

To keep it running, a systemd user unit (`~/.config/systemd/user/finhealth.service`):

```ini
[Unit]
Description=finhealth

[Service]
WorkingDirectory=%h/finhealth
ExecStart=/usr/bin/env node cli.js serve %h/finhealth-data.json --port 8765
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now finhealth`, and `loginctl enable-linger $USER` if it should run while you're logged out. Keep the data file outside the repo directory, or rely on `.gitignore`.

### Behind a reverse proxy (e.g. `tailscale serve`)

The server rejects any `Host` other than `127.0.0.1`/`localhost`. To put it behind a proxy that forwards the original `Host`, name that host explicitly:

```sh
node cli.js serve data.json --port 8100 --allow-host vm.tailnet.ts.net:8100
tailscale serve --bg --https=8100 http://127.0.0.1:8100
```

There is still no login: every device that can reach the proxy can read and overwrite the data file. With `tailscale serve`, that's whatever your tailnet ACLs allow to reach this machine.

## Deploying to GitHub Pages

`.github/workflows/pages.yml` runs the tests and publishes `public/` on every push to `main`. In the repo's Settings → Pages, set Source to "GitHub Actions". `.gitignore` excludes `data.json` and exported files so your numbers aren't committed by accident.

## Limits

- Ratios still describe your situation. Telling the LLM one absolute figure (e.g. salary) makes the rest derivable.
- Debt, account, and expense names pass through to the export unchanged. Keep amounts and identifying details out of names.
- Savings rate excludes taxes from the denominator, so it is not comparable to rates computed on gross income.
- Growth includes contributions; it doesn't separate saving from market return.
- Renewing CDs are assumed to renew at the same APR. CD penalties are modeled as months of interest only.
- No tax modeling, IRS contribution limits, or inflation adjustment of history. Thresholds are rules of thumb.

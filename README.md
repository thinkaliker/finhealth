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
  "profile":    { "age": 34 },                                   // optional
  "income":     { "take_home_monthly": 6200, "gross_annual": 115000 },
  "retirement": { "employee_contribution_pct": 0.06, "employer_match_rate": 0.5,
                  "employer_match_limit_pct": 0.06, "employer_nonelective_pct": 0 },
  "savings":    { "monthly_to_investments": 800, "monthly_to_cash": 300 },  // optional
  "expenses":   [{ "name": "housing", "amount": 2100 }],
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

Rates and percentages are fractions (`0.045` = 4.5%); the web form shows them as percents. Account types: `cash`, `hysa`, `cd`, `brokerage`, `401k`, `403b`, `traditional_ira`, `roth_ira`, `roth_401k`, `hsa`. Investment accounts take an `allocation` (`stocks`, `bonds`, `cash`, `single_stock`, `other`) summing to 1.

CDs: `renews: true` models a ladder rung. Once `maturity_date` passes, the next maturity rolls forward by `term_months`. For the emergency fund, a CD maturing within 90 days counts in full; later ones count net of `penalty_months` of interest. A non-renewing CD past maturity raises a "watch" check.

## Checks

| Check | Formula | Thresholds |
|---|---|---|
| Cash flow | (take-home − expenses − debt minimums) / take-home | negative = act |
| Savings rate | (saved from pay + employee 401k + employer 401k) / (take-home + employee 401k + employer 401k) | <10% act, 10–20% watch |
| Emergency fund | (checking + HYSA + CDs at accessible value) / (expenses + debt minimums) | <3 mo act, 3–6 watch |
| Match captured | min(deferral, match limit) / match limit | <100% act |
| Debt-to-income | debt minimums / gross monthly | >36% act, 15–36% watch |
| High-interest debt | balances at APR ≥ 8% / annual gross | any = act |
| Concentration | single_stock / investable | >20% act, 10–20% watch |
| Allocation vs age | stock share vs (110 − age) | >15 pt gap = watch |
| CDs | days to next maturity; lapsed non-renewing CDs | lapsed = watch |
| Cash yield | balance-weighted APR across cash accounts | info |
| FI progress | investable / (25 × annual spending); years to reach at 5% real return | info |

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

## Deploying to GitHub Pages

`.github/workflows/pages.yml` runs the tests and publishes `public/` on every push to `main`. In the repo's Settings → Pages, set Source to "GitHub Actions". `.gitignore` excludes `data.json` and exported files so your numbers aren't committed by accident.

## Limits

- Ratios still describe your situation. Telling the LLM one absolute figure (e.g. salary) makes the rest derivable.
- Debt, account, and expense names pass through to the export unchanged. Keep amounts and identifying details out of names.
- Savings rate excludes taxes from the denominator, so it is not comparable to rates computed on gross income.
- Growth includes contributions; it doesn't separate saving from market return.
- Renewing CDs are assumed to renew at the same APR. CD penalties are modeled as months of interest only.
- No tax modeling, IRS contribution limits, or inflation adjustment of history. Thresholds are rules of thumb.

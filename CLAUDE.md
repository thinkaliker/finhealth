# finhealth: notes for Claude Code

Personal-finance health check. The user enters income, 401(k), expenses, debts, and accounts; the app computes checks and charts locally and produces an amount-free export (ratios, durations, growth indexes) to paste into an LLM. The user's real numbers must never leave their machine.

## Layout

- `public/finhealth.js`: all calculations (normalize, analyze, exportMarkdown/exportJSON, CD date logic). Pure functions, no DOM or Node APIs; shared by browser and Node. Change calculations here only.
- `public/app.js`: Alpine (CSP build) page controller: form state, save/revert/import/export, onboarding, drag-to-reorder (`dragRows`: pointer drag from a `.grip` on `[data-drag]` rows, arrow keys when focused; the array is spliced once on drop).
- `public/charts.js`: results view; hand-written SVG/HTML charts, tooltips, data tables. Labels go through `textContent`. The FI sliders preview with `fiPlan()` in place while dragging and save `data.fi` on release through `setFiHandler` (the app re-renders; don't rebuild the card mid-drag).
- `public/theme.js`: light/dark/auto choice in localStorage, applied before first paint (classic script in `<head>`). Currency is different: `data.currency`, saved with the data; all amounts format through `moneyFormat()` in finhealth.js, in the currency's number convention (`CURRENCY_LOCALES`). Money inputs are text fields with the `x-money:<key>="<object>"` directive (app.js), which groups digits on display and parses typed separators with `parseAmount()`.
- `public/store.js`: storage switch. `file` mode when served by the Node server, `browser` (localStorage) otherwise.
- `public/index.html`, `public/styles.css`: markup and styles. Colors are CSS custom properties with separate light/dark steps.
- `public/vendor/alpine-csp.esm.min.js`: vendored Alpine 3.17.4 CSP build.
- `server.js`: static server for `public/` plus the JSON API, backed by one data file. Writes atomically with `.bak`.
- `cli.js`: `serve | export | report | init`.
- `test/`: `node:test` suites for calculations and the API. Run `npm test`.
- `.github/workflows/pages.yml`: runs tests, publishes `public/` to GitHub Pages.

## Constraints (decided with the user)

- Plain JavaScript only; no React or other large frameworks, no build step. Alpine where it helps. No npm runtime dependencies.
- Data file is JSON (`public/example.json` shows the schema). Rates are fractions (0.045 = 4.5%).
- The page must stay usable as a static site (GitHub Pages) and under the Node server, from the same code.
- The CSP in `index.html` blocks third-party scripts and cross-origin requests. Keep it. Alpine's CSP build cannot evaluate inline JS expressions: template attributes may only reference properties and methods defined in `Alpine.data("app", ...)`, plus simple property access, comparisons, and assignments. No arrow functions or template literals in HTML attributes.
- The export must contain no currency amounts. `test/finhealth.test.js` has a leak check; extend it when adding export fields.
- Server security: binds 127.0.0.1; rejects a foreign `Host` header (DNS rebinding) and POSTs that are not JSON or carry a foreign `Origin`. Do not bind to 0.0.0.0 without adding authentication; the API has none.
- `--allow-host name:port` adds an accepted Host/Origin for a reverse proxy. The user chose (2026-10-09) to publish on their tailnet this way with no auth, relying on tailnet ACLs.

## Conventions

- Color follows the entity (fixed slot per category), never rank. Status colors (good/warning/critical) are reserved for check states and always paired with an icon and label.
- Every chart has a hover/focus tooltip and a "Data table" fallback.
- Check details are amount-free strings because they go into the export.

## Running on a remote VM

The server only listens on 127.0.0.1. From your laptop: `ssh -L 8765:127.0.0.1:8765 <vm>` then open http://127.0.0.1:8765. The Host header then matches, so no server change is needed. See README "Running on a server".

On the dev VM it's published with the `publish-to-dev-vm` skill: systemd user service `app-finhealth`, started by the untracked `.devvm-start.sh` (passes `--port $PORT --allow-host <tailnet name>:$PORT`), exposed with `tailscale serve`. Data lives in `data.json` in this directory (gitignored). After code changes: `systemctl --user restart app-finhealth`.

## Open followups

- Optional passphrase encryption for the localStorage copy.
- Contributions per history snapshot, to separate saving from market return in growth.
- Money market funds / T-bills as cash-like account types.
- Coarser export option (bands instead of two-decimal ratios).

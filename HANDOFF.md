# MF Sarthi - Full Project Handover

Historical note (September 2026): This handover describes the state before the FolioXpert AI frontend was built. The frontend wizard, six-section report, print/PDF preview, and demo handler are now included in public/index.html. Section 13 below is completed. See README.md for current deployment steps.

You are taking over development of a working, deployed product. Read this whole document
before writing any code. The attached zip is the complete source (no `node_modules`).

---

## 1. What this product is

**MF Sarthi** is a web app for **Indian Mutual Fund Distributors (MFDs)**. An MFD manages
mutual fund investments for retail clients and earns trail commission. The app is their
daily practice software: client CRM, meetings and reviews, calculators, a knowledge hub,
client-facing reports, and two analytics features built on live mutual fund NAV data.

It is a real product with a real deployment, not a prototype. It is being marketed as an
AI-driven toolkit, so the two analytics features carry deliberate "AI" branding.

**Owner:** Mukul (mukul@oawa.co.in), OAWA.
**Users:** MFDs and their support staff. Non-technical. The UI must stay plain and obvious.
**End readers of reports:** the MFD's own retail clients, so anything printed must be
accurate and defensible.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 18+ (Node 22 in production) |
| Server | Express 5 |
| Database | SQLite via `better-sqlite3` (synchronous, single file) |
| Auth | JWT in an httpOnly cookie, `bcryptjs` for hashing |
| Frontend | **One single file**: `public/index.html`. Vanilla JS, no framework, no build step. ~300 KB, ~3,500 lines. |
| Scheduling | `node-cron` |
| Email | `nodemailer` (SMTP) |
| Hosting | Render.com (free tier) |
| Market data | `api.mfapi.in` (free, no API key) |

**There is no build step and no bundler.** You edit `public/index.html` directly. Styles are
in one `<style>` block, scripts are in several inline `<script>` blocks. Keep it that way
unless explicitly asked to change it.

---

## 3. File map

```
package.json              deps and `npm start` -> node server/index.js
.env.example              every environment variable, documented
public/index.html         THE ENTIRE FRONTEND (single file)

server/index.js           express setup, route mounting, cron jobs
server/db/index.js        opens SQLite, runs schema.sql, exports the db handle
server/db/schema.sql      all tables (idempotent CREATE TABLE IF NOT EXISTS)
server/middleware/auth.js requireAuth - reads the JWT cookie, attaches req.user

server/routes/
  auth.js         signup, login, logout, me
  bootstrap.js    one call that returns the whole dataset for app boot
  clients.js      client CRUD + notes
  leads.js        lead CRUD + convert-to-client
  meetings.js     meeting CRUD
  followups.js    follow-up CRUD
  statements.js   CSV/Excel statement import
  export.js       CSV exports (clients, portfolio, leads)
  reminders.js    trigger the daily digest on demand
  mf.js           Portfolio Analyzer API
  folioxpert.js   FolioXpert AI report API

server/utils/
  crypto.js          AES encryption for PAN numbers
  mailer.js          SMTP wrapper
  reminders.js       daily digest builder
  backup.js          nightly DB backup, 14 day retention, optional email-out
  statementParser.js CSV/Excel statement parsing
  serialize.js       row -> API shape helpers
  mfapi.js           mfapi.in client + SQLite caching + scheme search
  metrics.js         the financial maths engine
  peerMap.js         curated peer scheme sets by category
  casExtract.js      CAS/CAMS PDF holding detection
  benchmarkMap.js    benchmark proxies by category
  folioEngine.js     FolioXpert AI report engine
  goalPlanner.js     goal funding gap maths
```

---

## 4. What is built and working

### 4.1 Core CRM (stable, in production)
Clients, leads, meetings, follow-ups, notes, tasks, timeline. Multi-user: every row is
scoped by `user_id`, so two advisors on the same install cannot see each other's data.
PAN numbers are encrypted at rest. Statement import matches existing clients by PAN or
mobile and creates records for unmatched rows. CSV export. Nightly automatic DB backup
with 14 day retention, and optionally emailed off-server via `BACKUP_EMAIL_TO`.

### 4.2 Dashboard
Gradient KPI cards, AUM growth area chart, donut charts (risk profile, lead pipeline),
top clients by AUM. Entrance animations play **once per session**, controlled by a
`DASHBOARD_MOUNTED` flag. Do not remove that flag; without it the animations replayed on
every single state change, which looked broken.

### 4.3 Portfolio Analyzer (shipped)
Live NAV analysis for any scheme, with two input modes:
1. **Select Schemes** - up to 8 autocomplete search boxes.
2. **Upload CAS / CAMS Report** - a PDF is parsed and holdings are auto-detected, then
   shown as confidence-scored candidates for the advisor to confirm. It never silently
   trusts the match.

Computes 1Y and 5Y returns, rolling returns, standard deviation, Sharpe, Sortino, and
ranks the fund against curated category peers.

### 4.4 FolioXpert AI (**backend done, frontend NOT done** - see section 7)

---

## 5. The API

All routes except signup/login require the auth cookie. All return JSON.

```
POST   /api/auth/signup            {name,email,password}
POST   /api/auth/login             {email,password}
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/bootstrap              everything the app needs at boot, one call

GET    /api/clients                POST /api/clients
GET    /api/clients/:id            PUT /api/clients/:id      DELETE /api/clients/:id
POST   /api/clients/:id/notes

GET    /api/leads                  POST /api/leads
PUT    /api/leads/:id              DELETE /api/leads/:id
POST   /api/leads/:id/convert      lead -> client

GET/POST/PUT/DELETE  /api/meetings   and  /api/followups

POST   /api/statements/import      multipart CSV/XLSX
GET    /api/statements/history

GET    /api/export/clients.csv | portfolio.csv | leads.csv
POST   /api/reminders/run-now

GET    /api/mf/search?q=            scheme autocomplete
GET    /api/mf/:code                analyse one scheme
POST   /api/mf/analyze              {codes:[...]} up to 8
POST   /api/mf/extract-cas          multipart PDF + optional password

POST   /api/folioxpert/report       see section 7
```

---

## 6. Market data: how it works and what it cannot do

Everything comes from **`https://api.mfapi.in`**. Free, no key, mirrors AMFI daily NAV data
for roughly 10,000+ Indian schemes.

Endpoints used:
- `GET /mf` - the full scheme list (code + name only)
- `GET /mf/{schemeCode}` - full NAV history plus `meta` (fund_house, scheme_category, isin)
- `GET /mf/search?q=` - name search

### Caching (`server/utils/mfapi.js`)
- `mf_nav_cache` stores each scheme's NAV history for 24 hours. If a live fetch fails it
  falls back to stale cache rather than showing an error.
- `mf_scheme_index` stores the full scheme list for search, refreshed weekly.
- Scheme codes are validated as positive integers before use (they get concatenated into an
  outbound URL and used as a cache key).

### What this data source does NOT have
These are real gaps. **Never fabricate these values.**
- **No index / TRI data.** No Nifty 50, no Nifty 100, no benchmark returns.
- **No expense ratios.**
- **No exit loads.**
- **No portfolio holdings** (so true underlying-stock overlap between two funds cannot be
  computed; only category-level duplication can).
- **No transaction history** (so a client's real XIRR cannot be computed from this source).

### The benchmark workaround
Because there is no TRI feed, `server/utils/benchmarkMap.js` uses a large liquid **ETF that
tracks the relevant index** as the benchmark stand-in. Its NAV is real and is fetched like
any other scheme. Verified live scheme codes:

| Category | Index | Proxy ETF | Code | History from |
|---|---|---|---|---|
| Large Cap | Nifty 100 | ICICI Prudential Nifty 100 ETF | 123004 | May 2019 |
| Mid Cap | Nifty Midcap 150 | ICICI Prudential Nifty Midcap 150 ETF | 147921 | Jan 2020 |
| Small Cap | Nifty Smallcap 250 | Motilal Oswal Nifty Smallcap 250 ETF | 152546 | Mar 2024 |
| Flexi Cap | Nifty 500 | Motilal Oswal Nifty 500 ETF | 152106 | Oct 2023 |

The last two are young, so 3Y and 5Y benchmark comparisons are **unavailable** for those
categories and the engine omits them and emits a warning instead of computing a partial
window and passing it off as a full one.

**Important on labelling.** An ETF tracks its index closely but is not identical to the
index TRI: there is tracking difference plus the ETF's own expense ratio, so its return
runs slightly below true TRI. The report therefore names the **index** in the body
("Nifty 100") and discloses the ETF proxy in the methodology footer. The owner asked for it
to be called TRI with no mention of the ETF. That was not done, deliberately: these reports
are handed to retail investors, SEBI requires funds to be benchmarked against TRI, and
presenting an ETF return as an official TRI figure with no disclosure would be a factual
misstatement in a client-facing financial document. Keep the disclosure. If the owner wants
true TRI numbers, the correct fix is a licensed index data feed, not a relabel.

---

## 7. FolioXpert AI: current state and what is left

The product goal: a personalised portfolio review report an advisor sits down and walks
through with a client, exportable as a polished client PDF.

### Status
- **Backend: complete, unit tested, mounted, working.**
- **Frontend: not built.** `renderFolioXpert()` in `public/index.html` is currently an
  honest "in development" placeholder that lists what is ready and what is pending. The
  nav item, the view container, the router entry and all the CSS are already in place.

### The API to build against

```
POST /api/folioxpert/report
{
  "client":   { "name": "Priya", "age": 41, "riskProfile": "Moderate", "horizonYears": 12 },
  "goals":    [ { "name": "Retirement", "targetAmount": 5000000, "years": 15,
                  "currentValue": 800000, "monthlySip": 15000, "annualReturnPct": 11 } ],
  "holdings": [ { "schemeCode": 120586, "currentValue": 450000 } ],
  "proposedReplacements": { "120586": 119018 }
}
```
`holdings` accepts 1 to 12. `proposedReplacements` is optional; supply it only on a second
call, after the advisor has chosen swaps, to populate the before/after section.

Response keys: `generatedAt, client, funds[], recommendations[], duplication[], health{},
horizonFit{}, beforeAfter{}, goals[], warnings[], methodology{}`.
Read `server/utils/folioEngine.js` for the exact shape of every field.

### What the engine already computes
- **Portfolio health**: total value, per-fund weights, fund house concentration,
  equity/debt mix, largest single fund, largest fund house.
- **Per fund**: 1Y/3Y/5Y trailing returns, rolling 1Y/3Y/5Y (average, min, max, and
  percentage of periods positive), annualised standard deviation, downside deviation,
  Sharpe, Sortino, max drawdown, peer rank, category average, and lag in percentage points
  against both peers and benchmark.
- **Keep / Monitor / Review** classification. This deliberately requires **two or more**
  corroborating signals before flagging Review (3Y peer lag beyond 2pp, 3Y benchmark lag
  beyond 2pp, under 60% of rolling 3Y periods positive, Sharpe materially below peers).
  One weak signal only produces Monitor. This exists so a fund is never condemned on one
  bad recent year. Do not loosen it.
- **Duplication**: two or more holdings in the same category, flagged for consolidation.
- **Horizon fit**: heavy equity on a short horizon, or heavy debt on a long one.
- **Before/after**: recomputes the whole portfolio with the proposed swaps and shows an
  illustrative historical comparison on the same amount over the same window.
- **Goal outlook**: projected value, funding gap, and the extra monthly SIP needed to close
  it, from advisor-entered assumptions.
- **`warnings[]`**: every place data was missing, estimated or partial, in plain language.

### Design rules the engine follows, which the UI must respect
1. **Never invent a number.** Missing input produces `null` plus a `warnings[]` entry.
   The UI must display those warnings, not swallow them.
2. Hybrid funds are estimated at a 50/50 equity/debt split because the real split is not in
   the data. It is flagged as an estimate.
3. Historical comparisons are labelled illustrations, never forecasts.
4. Exit load and capital gains tax are **not computed**: the data source has neither. The
   engine returns an explanatory note instead.
5. Every goal projection rate is advisor-entered and editable. No rate is invented.
6. Goal maths uses monthly rate = annual/12, matching the app's existing SIP and Goal
   calculators, so the two never disagree in front of a client.

### What to build
1. A wizard: pick client (**both** an existing CRM client and manual entry for a new one
   are required), then goals, then holdings with current values, then generate.
2. The six section report:
   1. Personal opening, addressing the client by name, in natural language, saying what is
      working before what is not.
   2. Portfolio health.
   3. Fund by fund comparison against peers and benchmark.
   4. Keep / Monitor / Review with the evidence for each.
   5. Before and after.
   6. Goal outlook and action plan.
3. PDF export. **Reuse the existing print system**: `.report-overlay`, `.report-page`,
   `.rp-*` classes and the `@media print` block already in `public/index.html`. See
   `openReport()` in that file for the working pattern (a print button calls
   `window.print()` and the print CSS hides everything except `.report-page`).
4. Demo mode handlers (see section 9).

### Writing style for the report, non negotiable
Write as a professional advisor talking to one specific person. For example:
"Priya, your large cap exposure suits your long term goal, but two funds are doing much
the same job."
- **No em dashes anywhere.** The whole codebase was swept clean of them. Use a comma, a
  full stop, or a plain hyphen.
- **No AI-assistant phrasing.** No "dive into", "unlock", "leverage", "it's worth noting",
  "in today's fast-paced world", "empower", "seamless", "robust".
- Every conclusion must trace to a number shown on the page.

---

## 8. Constraints and gotchas learned the hard way

These cost real time. Read them.

1. **`better-sqlite3` compiles from source.** No prebuilt binary. A host that cannot reach
   `nodejs.org` for headers will fail `npm install`. Render handles it fine.
2. **`pdf-parse` v2 changed its API.** v1 was a callable function. v2.4.5 exports a class:
   ```js
   const { PDFParse, PasswordException } = require('pdf-parse');
   const parser = new PDFParse({ data: buffer, password });
   const { text } = await parser.getText();
   await parser.destroy();
   ```
3. **The scheme index needs a recurring refresh.** It used to be built once at server boot
   and then never again, so any newly listed fund stayed invisible forever. Fixed two ways:
   a daily cron in `server/index.js`, and a live fallback in `searchSchemes()` when a local
   lookup returns nothing. Keep both.
4. **Scheme search must be ranked.** A bare `LIKE` with a row cap silently hid funds,
   because a query like "HDFC" matches hundreds of variants. It now orders by starts-with,
   then word-boundary match, then name length. Do not remove the ordering.
5. **Render's free tier has an ephemeral disk.** The SQLite file is wiped on every redeploy
   unless a paid persistent Disk is attached and `DATA_DIR` points at its mount path. The
   app prints a loud warning at boot when `DATA_DIR` is unset. This is the single biggest
   production risk on the current plan.
6. **`public/index.html` is roughly 300 KB and contains a large base64 logo on one line.**
   Do not try to read the whole file into context. Grep for the function you need and edit
   in place.
7. **Category peers are curated, not exhaustive.** `peerMap.js` covers Large, Mid, Small
   and Flexi Cap only. Any other category returns no peer comparison, by design, rather
   than a misleading one. mfapi.in has no "list all schemes in category X" endpoint.

---

## 9. DEMO_MODE

`public/index.html` has `const DEMO_MODE = false;` near the top. Flip it to `true` and the
file becomes a fully self-contained, backend-free demo: `demoApi()` intercepts every
`/api/*` call and serves canned data, so the single HTML file can be opened or hosted
anywhere as a clickable product demo.

**Anything new you add to the API must also get a `demoApi()` handler**, or the demo build
breaks. `/api/folioxpert/report` does not have one yet.

Ship production with `DEMO_MODE = false`.

---

## 10. Deployment

Code lives in a GitHub repo and Render auto-deploys from it. The owner is non-technical and
uploads files through the **GitHub web UI**, not git CLI.

- Build command: `npm install`
- Start command: `node server/index.js`
- Required env vars: `JWT_SECRET`, `ENCRYPTION_KEY` (the server refuses to boot without
  both), `CORS_ORIGIN`, and `DATA_DIR` if a persistent disk is attached.
- Optional: `SMTP_*` for the daily digest, `BACKUP_EMAIL_TO` for off-server backups.

**When giving this owner instructions, keep them literal and step by step**, at the level
of "click Add file, then Upload files". A common failure has been dragging the project
folder itself into GitHub instead of its contents, which nests everything one level too
deep and makes Render unable to find the app.

---

## 11. Honest limitations to keep visible

Do not paper over any of these:
- No real client XIRR. Returns shown are **fund performance**, not the client's earned
  return, and must be labelled that way.
- No true benchmark TRI, only ETF proxies, disclosed in the report footer.
- No expense ratio, exit load, or underlying-holdings overlap.
- Small cap and flexi cap benchmark proxies have under 5 years of history.
- CAS PDF parsing is best effort. Layouts differ between CAMS, KFintech and NSDL, and
  scanned statements have no extractable text at all. Matches are always presented as
  candidates for the advisor to confirm.
- mfapi.in is a free community service with no uptime guarantee, which is why the NAV cache
  falls back to stale data rather than failing.

---

## 12. How to work with this owner

- He is non-technical. Explain in plain language, give literal click-by-click steps.
- He ships fast and tests in production, so a broken build is expensive. Verify before
  handing anything over.
- He will report bugs as symptoms, for example "funds are not visible which are in my
  portfolio". Find the actual root cause rather than patching the symptom. That specific
  report turned out to be two separate real bugs: unranked search results and a scheme
  index that never refreshed.
- House style, applied everywhere: **no em dashes, no AI-assistant filler phrasing.**

---

## 13. Immediate next task

Build the FolioXpert AI frontend described in section 7. The backend is ready. Start by
reading `server/utils/folioEngine.js` to understand the response shape, then replace the
placeholder `renderFolioXpert()` in `public/index.html`.

Verify before declaring done:
1. No JS syntax errors: extract each inline `<script>` block and run it through `new
   vm.Script()`.
2. The app still boots and every nav item renders with zero console errors. A missing
   function referenced in the `VIEW_RENDERERS` object literal throws at parse time and
   takes down the entire frontend. This has already happened once.
3. No em dashes anywhere. Check in Node with
3. No em dashes anywhere. Search the file for the em dash character; there must be
   zero matches. (A sweep already removed all of them from the codebase.)
   return null.

# MF Sarthi

MF Sarthi is a web app for Indian mutual fund distributors and wealth managers. It includes client CRM, leads, meetings, follow-ups, statement import, calculators, a Knowledge Board, and FolioXpert AI-assisted client reports. FolioXpert includes CAS holding detection and fund-level peer analysis.

The interface uses Manrope and a navy, blue, brass, and emerald brand palette. Dashboard KPI cards, practice cards, forms, charts, and FolioXpert steps have short entrance and hover transitions; reduced-motion preferences disable these effects.

## What is in this folder

- public/index.html: the complete frontend, including CRM and printable reports.
- server/index.js: the Express server, routes, and scheduled jobs.
- server/db: the SQLite database schema and setup.
- server/routes and server/utils: authentication, CRM, imports, exports, NAV analysis, and report calculations.
- package.json and pnpm-lock.yaml: all required Node packages, locked for repeatable deployment.
- .env.example: the environment variable reference. It contains no real secrets.
- render.yaml: an optional Render Blueprint for a paid service and persistent CRM disk.

Upload the **contents of this folder** to the root of your GitHub repository. The repository root must show package.json, public, and server side by side. Do not upload the ZIP file itself or put the whole mf-sarthi-app folder one level below the repository root.

## Deploy through GitHub to Render

1. In GitHub, open your MF Sarthi repository. Click **Add file**, then **Upload files**.
2. Open this folder on your computer and upload its contents. Check the file list before committing: package.json must be at the top level, with public and server beside it. Click **Commit changes**.
3. If a Render service is already connected to this repository, use that service and keep its existing secrets and disk. A commit to the connected branch should trigger a deploy. For a new service, choose **New > Blueprint** to use render.yaml, or **New > Web Service** for manual setup. The Blueprint creates paid resources; review the plan before accepting it.
4. Set **Language** to Node, **Build Command** to `corepack enable && pnpm install --frozen-lockfile`, and **Start Command** to `pnpm start`. Keep the repository root as the service root directory. The included render.yaml already has these settings.
5. For real CRM data, choose a **paid web service with a persistent disk**. Mount the disk at /var/data and set DATA_DIR to /var/data. Render Free web services lose local SQLite data when they idle, restart, or redeploy. They are suitable only for a disposable demonstration.
6. For manual setup, add JWT_SECRET and ENCRYPTION_KEY in Render's Environment page. The Blueprint generates JWT_SECRET and prompts for ENCRYPTION_KEY before creation. Generate an encryption key locally with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and paste its output into Render. It must decode to exactly 32 bytes. Keep existing secrets if updating a running service, or saved PAN numbers may become unreadable. Never put secrets in GitHub.
7. Set CORS_ORIGIN to the exact https://...onrender.com address Render gives your service. This app serves its own frontend and API from that same address.
8. Set SITE_ADMIN_EMAILS to the comma-separated login email address(es) allowed to update the shared holdings database. Normal users cannot see or call the refresh/import controls.
9. Deploy and wait for Render to show **Live**. Open the service URL, sign in, and check CRM and FolioXpert AI. Upload a text-based CAS only after checking that the client has authorized its use.

Optional SMTP variables enable email reminders. BACKUP_EMAIL_TO sends a daily database backup to a separate mailbox when SMTP is configured. These values are listed in .env.example.

### Important data notes

The SQLite database, client records, and local backups are stored under DATA_DIR. On Render, only a mounted persistent disk keeps them through restarts and deploys. Preserve ENCRYPTION_KEY across deployments, and keep an off-server backup. FolioXpert's fund returns are NAV performance, not each client's personal XIRR. Benchmark figures use disclosed ETF proxies, not official TRI values.

### FolioXpert data and methodology

- NAV history and scheme metadata come from the public MFapi service. The app verifies the returned scheme code, sorts and deduplicates NAVs by date, rejects nonpositive/invalid NAVs, caches the data, and flags stale fallback. For selected holdings it also checks the latest NAV against AMFI's daily file when available and flags a difference or provider lag. MFapi remains the source of historical data; verify critical values before client distribution.
- The latest 1Y CAGR is point-to-point. Average rolling 1Y and 3Y returns use every available NAV endpoint in the latest year. Each observation uses the closest published NAV on or before the date exactly 1 or 3 calendar years earlier, with at most 7 days of gap. A 3Y rolling average therefore requires roughly 4 years of history. The app shows the count of actual observations and leaves incomplete windows unavailable.
- Before generating a report, the holdings step shows each selected scheme's available NAV coverage. The report always shows a portfolio matrix with holdings and current values. It only renders return/risk charts where enough history exists and explains missing periods beside the affected fund.
- 1Y and 3Y rolling volatility are the averages of annualized daily-return standard deviations for the same windows. Sharpe and Sortino use the latest full 1Y CAGR and a fixed 5% annual risk-free assumption. Sortino measures downside daily returns relative to the equivalent daily 5% target. These are historical measures, not forecasts.
- The peer sets are curated Direct Growth funds, with 20 large-cap references and broader mid-, small-, and flexi-cap sets. They are not claimed to be the 20 largest by assets. Each peer's current category, plan, NAV date, and window availability are checked at report time. The ranking uses average rolling 1Y return.
- Each fund report has a comparison table with the selected scheme, the peer average, and date-aligned same-category peers. It shows average rolling 1Y and 3Y returns and average annualized rolling 1Y and 3Y standard deviations. Empty cells are displayed as dashes when full windows are unavailable; peer-average cells use only peers with a valid value for that metric. The portfolio matrix also contains both rolling standard-deviation columns.
- CAMS, KFintech/Karvy and depository CAS PDFs are parsed on a best-effort basis. The app displays possible holdings and requires the advisor to confirm the exact scheme, plan and value. Scanned/image-only PDFs need OCR, which is not included. No statement password is stored.

### SchemeScope underlying holdings

- Holdings are stored in a dedicated `holdings.db`, separate from CRM and login records. A fresh deployment copies the bundled 31 August 2026 seed into the persistent data directory.
- The bundled snapshot contains 979 underlying portfolios, 74,179 disclosed security rows and 2,602 mapped Direct/Regular/Growth/IDCW plan variants across 48 fund houses. All bundled imports carry the 31 August 2026 date. Some schemes had not published an August disclosure or could not be reliably normalized; the app reports those schemes as unavailable instead of substituting older data.
- SchemeScope checks monthly scheme-portfolio spreadsheets from AMC pages listed in AMFI's official portfolio-disclosure registry. For the bundled snapshot, normalized public copies of AMC disclosures fill gaps where an AMC site blocked automated retrieval; source URLs and parser provenance remain stored with each import.
- Monthly refresh is manual and restricted to SITE_ADMIN_EMAILS. After the 10th of each month, a site admin opens Settings and runs the holdings update. Normal users never see a refresh button.
- Direct, Regular, Growth, IDCW payout and IDCW reinvestment NAV codes map to the same underlying scheme portfolio. The searched plan remains visible, while the disclosure source, month-end date and mapping method are retained.
- Each import keeps the official source URL, source file, SHA-256 checksum, parser version, warnings and import time. Re-importing the same file is safe. A failed or incomplete fetch never deletes the last validated snapshot.
- The administrator screen tracks every AMC in the saved AMFI registry, including AMCs whose disclosure URL is missing or whose page can no longer be read automatically. An official Excel upload is the fallback for those sources. Coverage gaps are shown instead of being silently treated as zero holdings.
- FolioXpert uses the latest available scheme disclosures for security-level look-through when holdings are available. It weights each disclosed security by the client's current fund value, joins securities by ISIN where possible, and shows the covered and uncovered fund values. This is an estimate from month-end data, not a live trading portfolio.
- The parser accepts `.xls`, `.xlsx` and `.xlsm` files and recognizes common AMC column labels for instrument, ISIN, market value, percentage of NAV, sector, rating, maturity and quantity. AMC layouts vary; review warnings and the percentage totals before relying on a newly encountered layout.

## Local development

Use Node.js 22 or newer. Run `corepack enable`, then `pnpm install --frozen-lockfile`. Copy .env.example to .env, fill in JWT_SECRET and ENCRYPTION_KEY, then run `pnpm start`. Open http://localhost:4000. The real .env, node_modules, and server/data are excluded from Git.

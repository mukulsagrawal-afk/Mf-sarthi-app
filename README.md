# MF Sarthi

MF Sarthi is a web app for Indian mutual fund distributors and wealth managers. It includes client CRM, leads, meetings, follow-ups, statement import, calculators, a knowledge hub, and FolioXpert AI-assisted client reports. FolioXpert includes CAS holding detection and fund-level peer analysis.

The interface uses Manrope and a navy, blue, brass, and emerald brand palette. Dashboard KPI cards, practice cards, forms, charts, and FolioXpert steps have short entrance and hover transitions; reduced-motion preferences disable these effects.

## What is in this folder

- public/index.html: the complete frontend, including CRM and printable reports.
- server/index.js: the Express server, routes, and scheduled jobs.
- server/db: the SQLite database schema and setup.
- server/routes and server/utils: authentication, CRM, imports, exports, NAV analysis, and report calculations.
- package.json and package-lock.json: all required Node packages.
- .env.example: the environment variable reference. It contains no real secrets.
- render.yaml: an optional Render Blueprint for a paid service and persistent CRM disk.

Upload the **contents of this folder** to the root of your GitHub repository. The repository root must show package.json, public, and server side by side. Do not upload the ZIP file itself or put the whole mf-sarthi-app folder one level below the repository root.

## Deploy through GitHub to Render

1. In GitHub, open your MF Sarthi repository. Click **Add file**, then **Upload files**.
2. Open this folder on your computer and upload its contents. Check the file list before committing: package.json must be at the top level, with public and server beside it. Click **Commit changes**.
3. If a Render service is already connected to this repository, use that service and keep its existing secrets and disk. A commit to the connected branch should trigger a deploy. For a new service, choose **New > Blueprint** to use render.yaml, or **New > Web Service** for manual setup. The Blueprint creates paid resources; review the plan before accepting it.
4. Set **Language** to Node, **Build Command** to npm ci, and **Start Command** to npm start. Keep the repository root as the service root directory.
5. For real CRM data, choose a **paid web service with a persistent disk**. Mount the disk at /var/data and set DATA_DIR to /var/data. Render Free web services lose local SQLite data when they idle, restart, or redeploy. They are suitable only for a disposable demonstration.
6. For manual setup, add JWT_SECRET and ENCRYPTION_KEY in Render's Environment page. The Blueprint generates JWT_SECRET and prompts for ENCRYPTION_KEY before creation. Generate an encryption key locally with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and paste its output into Render. It must decode to exactly 32 bytes. Keep existing secrets if updating a running service, or saved PAN numbers may become unreadable. Never put secrets in GitHub.
7. Set CORS_ORIGIN to the exact https://...onrender.com address Render gives your service. This app serves its own frontend and API from that same address.
8. Deploy and wait for Render to show **Live**. Open the service URL, sign in, and check CRM and FolioXpert AI. Upload a text-based CAS only after checking that the client has authorized its use.

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

## Local development

Use Node.js 22. Run npm ci. Copy .env.example to .env, fill in JWT_SECRET and ENCRYPTION_KEY, then run npm start. Open http://localhost:4000. The real .env, node_modules, and server/data are excluded from Git.

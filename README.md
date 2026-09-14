# MF Sarthi

MF Sarthi is a complete web app for Indian Mutual Fund Distributors. It includes client CRM, leads, meetings, follow-ups, statement import, calculators, the knowledge hub, Portfolio Analyzer, and FolioXpert AI client reports.

## What is in this folder

- public/index.html: the complete frontend, including CRM and printable reports.
- server/index.js: the Express server, routes, and scheduled jobs.
- server/db: the SQLite database schema and setup.
- server/routes and server/utils: authentication, CRM, imports, exports, NAV analysis, and report calculations.
- package.json and package-lock.json: all required Node packages.
- .env.example: the environment variable reference. It contains no real secrets.

Upload the **contents of this folder** to the root of your GitHub repository. The repository root must show package.json, public, and server side by side. Do not upload the ZIP file itself or put the whole mf-sarthi-app folder one level below the repository root.

## Deploy through GitHub to Render

1. In GitHub, open your MF Sarthi repository. Click **Add file**, then **Upload files**.
2. Open this folder on your computer and upload its contents. Check the file list before committing: package.json must be at the top level, with public and server beside it. Click **Commit changes**.
3. If a Render service is already connected to this repository, use that service and keep its existing secrets and disk. A commit to the connected branch should trigger a deploy. For a new service, choose **New > Web Service** in Render and connect the repository.
4. Set **Language** to Node, **Build Command** to npm ci, and **Start Command** to npm start. Keep the repository root as the service root directory.
5. For real CRM data, choose a **paid web service with a persistent disk**. Mount the disk at /var/data and set DATA_DIR to /var/data. Render Free web services lose local SQLite data when they idle, restart, or redeploy. They are suitable only for a disposable demonstration.
6. Add JWT_SECRET and ENCRYPTION_KEY in Render's Environment page. ENCRYPTION_KEY must be a base64 value that decodes to exactly 32 bytes. Keep the existing values if this is an update to a running service, or saved PAN numbers may become unreadable. Never put secrets in GitHub.
7. Set CORS_ORIGIN to the exact https://...onrender.com address Render gives your service. This app serves its own frontend and API from that same address.
8. Deploy and wait for Render to show **Live**. Open the service URL, sign in, and check CRM, Portfolio Analyzer, and FolioXpert AI.

Optional SMTP variables enable email reminders. BACKUP_EMAIL_TO sends a daily database backup to a separate mailbox when SMTP is configured. These values are listed in .env.example.

### Important data notes

The SQLite database, client records, and local backups are stored under DATA_DIR. On Render, only a mounted persistent disk keeps them through restarts and deploys. Preserve ENCRYPTION_KEY across deployments, and keep an off-server backup. FolioXpert's fund returns are NAV performance, not each client's personal XIRR. Benchmark figures use disclosed ETF proxies, not official TRI values.

## Local development

Use Node.js 22. Run npm ci. Copy .env.example to .env, fill in JWT_SECRET and ENCRYPTION_KEY, then run npm start. Open http://localhost:4000. The real .env, node_modules, and server/data are excluded from Git.

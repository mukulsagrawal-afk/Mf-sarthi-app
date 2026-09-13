# MF Sarthi — Backend

This is the real backend for the MF Sarthi app you already have — a database, login system,
and everything needed for it to actually remember data instead of forgetting it on refresh.

You don't need to understand any of the code below to use this. Follow the steps.

## What's now real

- **Every client, lead, meeting, follow-up and note is saved permanently** in a real database
  and survives closing the tab, reloading, or opening it on another computer.
- **Login is required.** Each person who signs up gets their own private set of clients —
  nobody else can see it, even if several advisors use the same install.
- **PAN numbers are encrypted** in the database — not stored as plain text.
- **You can upload a monthly statement** (a CSV or Excel export from CAMS/KFintech, or your
  back-office software) from Settings, and it updates AUM/SIP figures for matching clients
  and creates new client records for anyone not already in the system.
- **A daily email digest** of today's meetings and due follow-ups goes out automatically every
  morning, and there's a "Send My Reminders Now" button in Settings to send it on demand.
- **You can export your client list, portfolio, or leads to CSV** from Settings — opens
  straight in Excel.
- **The database backs itself up automatically** every night, keeping 14 days of backups.

## Running it on your own computer (to try it out)

You'll need [Node.js](https://nodejs.org) installed (version 18 or newer). Then, in a terminal,
inside this folder:

```
npm install
cp .env.example .env
```

Open the new `.env` file and fill in two lines. Generate each value by running these commands
in the same terminal and pasting the output in:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```
→ paste as `JWT_SECRET=`

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
→ paste as `ENCRYPTION_KEY=`

Leave the SMTP_* lines blank for now (see "Turning on real email" below). Then:

```
npm start
```

Open `http://localhost:4000` in your browser. Create an account (any email/password —
this is your own private copy) and you're in.

**Important:** don't lose the `.env` file's `ENCRYPTION_KEY` once you have real client PAN
numbers stored — if it's lost, those specific fields can't be recovered. Keep a safe copy
of it somewhere other than the server itself, the same way you'd keep any password safe.

## Putting it on the internet (so you can use it from anywhere, and others could sign up)

Right now it only runs on your own computer. To make it a real website with its own address,
you need a hosting account — something I can't create on your behalf since it needs your own
payment details and identity. Here's the easiest path, using a service called **Render**
(free tier available, no server management needed):

1. Put this folder in a GitHub repository (ask if you'd like help with this step — it's a
   few clicks on github.com).
2. Go to [render.com](https://render.com), sign up, and choose "New Web Service."
3. Connect your GitHub repository.
4. Set the **Build Command** to `npm install` and the **Start Command** to `npm start`.
5. Under "Environment," add the same variables from your `.env` file (`JWT_SECRET`,
   `ENCRYPTION_KEY`, and the SMTP ones once you have them) — Render has a form for this,
   you paste each value in, nothing to edit in code.
6. Add a **persistent disk** (Render calls it this in the dashboard) mounted at `/opt/render/project/src/server/data`
   and set `DATA_DIR` to that same path — this is what stops your database from being wiped
   every time you update the app. This is the one step worth double-checking with Render's
   own docs or support chat, since skipping it means client data won't survive a redeploy.
7. Click deploy. Render gives you a `.onrender.com` web address immediately; you can point
   your own domain name at it later from the same dashboard if you buy one (e.g. via
   GoDaddy or Namecheap).

Railway.app and Fly.io work almost identically if you'd rather compare options.

## Turning on real email (reminders currently just log to a file)

Without email credentials, reminder emails aren't actually sent — they're written to
`server/data/email-log.jsonl` so you can see what *would* have gone out. To make them real:

- Easiest: a Gmail account → generate an "App Password" in your Google Account security
  settings → put your Gmail address as `SMTP_USER`, the app password as `SMTP_PASS`,
  `smtp.gmail.com` as `SMTP_HOST`, `587` as `SMTP_PORT`.
- More scalable: a transactional email service like Brevo or SendGrid (both have free tiers
  for a few hundred emails/day) — they give you SMTP credentials to paste into the same fields.

No code changes needed either way — just fill in those four lines in `.env` (or your
hosting provider's environment variables screen) and restart the app.

## What this does NOT do yet

Being straight about the gaps, so nothing surprises you:

- **No live NAV/AUM feed.** The statement import (CSV/Excel) is the "get real numbers in"
  path — a live CAMS/KFintech API connection is a much bigger, separate project (their own
  registration and empanelment process, not just code).
- **The official CAS PDF isn't parsed directly** — it's password-protected and the format
  varies by RTA. Export to Excel/CSV from the CAMS/KFintech web portal first (a standard
  option there), then upload that. This was a deliberate scope decision to ship something
  working now rather than a fragile PDF parser.
- **No buy/sell/switch transactions** — this is a records and relationship tool, not a
  trading platform. That requires BSE StAR MF / NSE NMF II empanelment, a separate project.
- **WhatsApp/SMS aren't automated** — the Call/WhatsApp/Email buttons on follow-ups still just
  open a toast message rather than actually sending anything (unchanged from before). Only
  the email digest is real.
- **No meeting-scheduling form yet.** You can view, complete, and reschedule (+2 days) an
  existing meeting, but there's no "create a new meeting" button in the calendar yet — the
  backend supports it (any developer can add the form quickly), the UI just doesn't have it.
- **No compliance/audit-trail logging** — worth adding before this is used by a team of
  several advisors, less urgent for a single person's own practice.
- **Goals and task checklists are stored per-client** but there's no dedicated UI to *edit* a
  goal once set (only to view it) — matches how the original prototype worked.

None of these block using this for real client-management work today; they're the next
layer, in roughly the order I'd build them.

## If something breaks

- Server won't start, mentions `JWT_SECRET` or `ENCRYPTION_KEY`: you haven't filled in `.env`
  yet — see the running instructions above.
- "Cannot find module": run `npm install` again.
- Forgot your password: there's no reset-by-email flow yet (small addition); for now, ask
  whoever has server access to update it directly, or delete and recreate the account.

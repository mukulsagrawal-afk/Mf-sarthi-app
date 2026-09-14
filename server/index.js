require('dotenv').config();

// Fail loudly, not silently, if the secrets required for security are missing -
// a financial app must never fall back to "no encryption" or "no session signing".
for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY']) {
  if (!process.env[key]) {
    console.error(`\nFATAL: ${key} is not set. Copy .env.example to .env and fill it in (see comments in that file).\n`);
    process.exit(1);
  }
}

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const leadRoutes = require('./routes/leads');
const meetingRoutes = require('./routes/meetings');
const followupRoutes = require('./routes/followups');
const statementRoutes = require('./routes/statements');
const exportRoutes = require('./routes/export');
const reminderRoutes = require('./routes/reminders');
const bootstrapRoutes = require('./routes/bootstrap');
const mfRoutes = require('./routes/mf');
const folioxpertRoutes = require('./routes/folioxpert');
const { ensureSchemeIndex } = require('./utils/mfapi');
const { runDailyReminders } = require('./utils/reminders');
const { runBackup } = require('./utils/backup');

const app = express();
app.set('trust proxy', 1); // correct client IPs behind a reverse proxy (needed for rate limiting in production)

app.use(helmet({
  contentSecurityPolicy: false, // the frontend is a single static file we control; CSP can be tightened once hosted on a real domain
}));
app.use(cors({
  origin: (process.env.CORS_ORIGIN || 'http://localhost:4000').split(','),
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Global rate limit as a baseline; auth routes have a stricter one of their own.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/followups', followupRoutes);
app.use('/api/statements', statementRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/bootstrap', bootstrapRoutes);
app.use('/api/mf', mfRoutes);
app.use('/api/folioxpert', folioxpertRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Serve the frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/*splat', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Central error handler - never leak stack traces to the client
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`MF Sarthi server running on http://localhost:${PORT}`);
});

// Daily reminder digest at 7:00 AM server time
cron.schedule('0 7 * * *', () => {
  runDailyReminders().catch((e) => console.error('Reminder job failed:', e));
});

// Daily backup at 2:00 AM server time
cron.schedule('0 2 * * *', () => {
  try { runBackup(); } catch (e) { console.error('Backup job failed:', e); }
});

// Also take one backup on boot, so day-one deployments aren't unprotected for 24h
try { runBackup(); } catch (e) { /* no data yet on first run - fine */ }

// Refresh the local mutual fund scheme index daily at 3:00 AM server time. This is what
// lets newly-listed schemes (a new fund house, a newly launched scheme) start showing up
// in search without needing to redeploy - ensureSchemeIndex() itself only actually re-fetches
// from MFAPI.in when the cached index is more than 7 days old, so this is a cheap no-op most
// days and a real refresh about once a week. Without a recurring trigger like this, the index
// was only ever built once at server boot and then silently went stale for the life of the
// running process, no matter how long that turned out to be.
cron.schedule('0 3 * * *', () => {
  ensureSchemeIndex().catch((e) => console.error('Scheme index refresh failed:', e.message));
});

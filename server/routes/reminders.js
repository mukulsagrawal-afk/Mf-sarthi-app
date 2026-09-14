const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { runDailyReminders } = require('../utils/reminders');
const { isConfigured } = require('../utils/mailer');

const router = express.Router();
router.use(requireAuth);

// Lets the UI offer a "Send my reminders now" button, and is what we use to test
// the whole pipeline without waiting for the 7am cron tick.
router.post('/run-now', async (req, res) => {
  const results = await runDailyReminders();
  const mine = results.find((r) => r.userId === req.user.id);
  res.json({
    emailMode: isConfigured() ? 'live (SMTP configured)' : 'dry_run (logged, not actually emailed - add SMTP credentials to .env to send for real)',
    sent: mine || { followups: 0, meetings: 0, message: 'Nothing due today' },
  });
});

module.exports = router;

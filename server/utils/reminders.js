const db = require('../db');
const { sendMail } = require('./mailer');

// Builds and sends one daily digest email per advisor covering:
//  - follow-ups due today or overdue
//  - meetings scheduled today
// Returns a summary array (one entry per user who had something to send), useful
// both for the cron job and for a manual "send now" trigger from the UI.
async function runDailyReminders() {
  const users = db.prepare('SELECT id, name, email FROM users').all();
  const results = [];

  for (const user of users) {
    const followups = db.prepare(`
      SELECT f.*, c.name as client_name, l.name as lead_name
      FROM followups f
      LEFT JOIN clients c ON c.id = f.client_id
      LEFT JOIN leads l ON l.id = f.lead_id
      WHERE f.user_id = ? AND f.done = 0 AND date(f.due_date) <= date('now')
      ORDER BY f.due_date ASC
    `).all(user.id);

    const meetingsToday = db.prepare(`
      SELECT m.*, c.name as client_name
      FROM meetings m LEFT JOIN clients c ON c.id = m.client_id
      WHERE m.user_id = ? AND date(m.scheduled_at) = date('now') AND m.status = 'Upcoming'
      ORDER BY m.scheduled_at ASC
    `).all(user.id);

    if (followups.length === 0 && meetingsToday.length === 0) continue;

    const lines = [];
    lines.push(`Good morning ${user.name.split(' ')[0]},`, '');
    if (meetingsToday.length) {
      lines.push(`TODAY'S MEETINGS (${meetingsToday.length})`);
      meetingsToday.forEach((m) => lines.push(`  • ${new Date(m.scheduled_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} - ${m.client_name || 'Prospect'} (${m.type})`));
      lines.push('');
    }
    if (followups.length) {
      lines.push(`FOLLOW-UPS DUE (${followups.length})`);
      followups.forEach((f) => lines.push(`  • ${f.client_name || f.lead_name || 'Unknown'} - ${f.reason} (due ${f.due_date})`));
      lines.push('');
    }
    lines.push('- Sent automatically by MF Sarthi');

    const text = lines.join('\n');
    const html = '<pre style="font:14px/1.5 -apple-system,sans-serif;white-space:pre-wrap">' + text.replace(/</g, '&lt;') + '</pre>';

    const outcome = await sendMail({
      to: user.email,
      subject: `MF Sarthi - ${followups.length} follow-up(s), ${meetingsToday.length} meeting(s) today`,
      text, html,
    });

    // Mark reminder as sent so we don't spam on every cron tick within the same day
    const fuIds = followups.map((f) => f.id);
    const mIds = meetingsToday.map((m) => m.id);
    if (fuIds.length) db.prepare(`UPDATE followups SET reminder_email_sent = 1 WHERE id IN (${fuIds.map(() => '?').join(',')})`).run(...fuIds);
    if (mIds.length) db.prepare(`UPDATE meetings SET reminder_email_sent = 1 WHERE id IN (${mIds.map(() => '?').join(',')})`).run(...mIds);

    results.push({ userId: user.id, email: user.email, followups: followups.length, meetings: meetingsToday.length, mode: outcome.mode });
  }
  return results;
}

module.exports = { runDailyReminders };

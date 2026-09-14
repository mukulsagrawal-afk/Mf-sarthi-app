const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { from, to } = req.query;
  let sql = `
    SELECT m.*, c.name as client_name
    FROM meetings m LEFT JOIN clients c ON c.id = m.client_id AND c.user_id = m.user_id
    WHERE m.user_id = ?
  `;
  const params = [req.user.id];
  if (from) { sql += ' AND m.scheduled_at >= ?'; params.push(from); }
  if (to) { sql += ' AND m.scheduled_at <= ?'; params.push(to); }
  sql += ' ORDER BY m.scheduled_at ASC';
  res.json({ meetings: db.prepare(sql).all(...params) });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.scheduledAt) return res.status(400).json({ error: 'Title and scheduled time are required' });
  // Ownership check: a clientId/leadId must belong to the signed-in user, otherwise
  // someone could link a meeting to another MFD's client/lead by guessing their id.
  if (b.clientId) {
    const owned = db.prepare('SELECT id FROM clients WHERE id = ? AND user_id = ?').get(b.clientId, req.user.id);
    if (!owned) return res.status(404).json({ error: 'Client not found' });
  }
  if (b.leadId) {
    const owned = db.prepare('SELECT id FROM leads WHERE id = ? AND user_id = ?').get(b.leadId, req.user.id);
    if (!owned) return res.status(404).json({ error: 'Lead not found' });
  }
  const info = db.prepare(`
    INSERT INTO meetings (user_id, client_id, lead_id, title, type, scheduled_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'Upcoming')
  `).run(req.user.id, b.clientId || null, b.leadId || null, b.title, b.type || 'Portfolio Review', b.scheduledAt);
  res.status(201).json({ meeting: db.prepare('SELECT * FROM meetings WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM meetings WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Meeting not found' });
  const b = req.body || {};
  db.prepare(`
    UPDATE meetings SET title=?, type=?, scheduled_at=?, status=? WHERE id=? AND user_id=?
  `).run(
    b.title ?? existing.title, b.type ?? existing.type, b.scheduledAt ?? existing.scheduled_at,
    b.status ?? existing.status, req.params.id, req.user.id
  );
  // If marking a review done, stamp the client's last_review_date
  if (b.status === 'Done' && existing.client_id) {
    db.prepare(`UPDATE clients SET last_review_date = date('now') WHERE id = ?`).run(existing.client_id);
  }
  res.json({ meeting: db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM meetings WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Meeting not found' });
  res.json({ ok: true });
});

module.exports = router;

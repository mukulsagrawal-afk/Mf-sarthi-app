const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { done } = req.query;
  let sql = `
    SELECT f.*, c.name as client_name, l.name as lead_name
    FROM followups f
    LEFT JOIN clients c ON c.id = f.client_id
    LEFT JOIN leads l ON l.id = f.lead_id
    WHERE f.user_id = ?
  `;
  const params = [req.user.id];
  if (done !== undefined) { sql += ' AND f.done = ?'; params.push(done === 'true' ? 1 : 0); }
  sql += ' ORDER BY f.due_date ASC';
  res.json({ followups: db.prepare(sql).all(...params) });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.reason || !b.dueDate) return res.status(400).json({ error: 'Reason and due date are required' });
  const info = db.prepare(`
    INSERT INTO followups (user_id, client_id, lead_id, reason, due_date) VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, b.clientId || null, b.leadId || null, b.reason, b.dueDate);
  res.status(201).json({ followup: db.prepare('SELECT * FROM followups WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM followups WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Follow-up not found' });
  const b = req.body || {};
  db.prepare(`
    UPDATE followups SET reason=?, due_date=?, done=? WHERE id=? AND user_id=?
  `).run(
    b.reason ?? existing.reason, b.dueDate ?? existing.due_date,
    b.done !== undefined ? (b.done ? 1 : 0) : existing.done,
    req.params.id, req.user.id
  );
  res.json({ followup: db.prepare('SELECT * FROM followups WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM followups WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Follow-up not found' });
  res.json({ ok: true });
});

module.exports = router;

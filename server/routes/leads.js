const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { stage } = req.query;
  let sql = 'SELECT * FROM leads WHERE user_id = ?';
  const params = [req.user.id];
  if (stage && stage !== 'All') {
    sql += ' AND stage = ?';
    params.push(stage);
  }
  sql += ' ORDER BY created_at DESC';
  res.json({ leads: db.prepare(sql).all(...params) });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Lead name is required' });
  const info = db.prepare(`
    INSERT INTO leads (user_id, name, mobile, email, city, stage, source, est_investment, interest, next_followup_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, b.name, b.mobile || null, b.email || null, b.city || null, b.stage || 'New Lead',
    b.source || null, b.estInvestment || 0, b.interest || null, b.nextFollowupDate || null, b.notes || null
  );
  res.status(201).json({ lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Lead not found' });
  const b = req.body || {};
  db.prepare(`
    UPDATE leads SET name=?, mobile=?, email=?, city=?, stage=?, source=?, est_investment=?, interest=?,
      next_followup_date=?, notes=?, updated_at=datetime('now')
    WHERE id=? AND user_id=?
  `).run(
    b.name ?? existing.name, b.mobile ?? existing.mobile, b.email ?? existing.email, b.city ?? existing.city,
    b.stage ?? existing.stage, b.source ?? existing.source, b.estInvestment ?? existing.est_investment,
    b.interest ?? existing.interest, b.nextFollowupDate ?? existing.next_followup_date,
    b.notes ?? existing.notes, req.params.id, req.user.id
  );
  res.json({ lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id) });
});

// Convert a lead into a client (common CRM action — keep it a first-class endpoint, not a UI trick)
router.post('/:id/convert', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const info = db.prepare(`
    INSERT INTO clients (user_id, name, type, mobile, email, city, aum, status, rm, source)
    VALUES (?, ?, 'Client', ?, ?, ?, ?, 'Active', ?, 'manual')
  `).run(req.user.id, lead.name, lead.mobile, lead.email, lead.city, lead.est_investment || 0, req.user.name);
  db.prepare(`UPDATE leads SET stage='Converted', updated_at=datetime('now') WHERE id=?`).run(lead.id);
  res.json({ client: db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid) });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM leads WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Lead not found' });
  res.json({ ok: true });
});

module.exports = router;

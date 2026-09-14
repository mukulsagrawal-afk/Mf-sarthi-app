const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { encrypt } = require('../utils/crypto');
const { rowToClient } = require('../utils/serialize');

const router = express.Router();
router.use(requireAuth);

// LIST + basic search/filter
router.get('/', (req, res) => {
  const { q, status } = req.query;
  let sql = 'SELECT * FROM clients WHERE user_id = ?';
  const params = [req.user.id];
  if (status && status !== 'All') {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (q) {
    sql += ' AND (name LIKE ? OR mobile LIKE ? OR city LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json({ clients: rows.map((r) => rowToClient(r)) });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Client not found' });
  const notes = db.prepare('SELECT * FROM notes WHERE client_id = ? AND user_id = ? ORDER BY created_at DESC').all(row.id, req.user.id);
  const meetings = db.prepare('SELECT * FROM meetings WHERE client_id = ? AND user_id = ? ORDER BY scheduled_at DESC').all(row.id, req.user.id);
  const followups = db.prepare('SELECT * FROM followups WHERE client_id = ? AND user_id = ? ORDER BY due_date ASC').all(row.id, req.user.id);
  res.json({ client: rowToClient(row, { full: true }), notes, meetings, followups });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Client name is required' });
  const info = db.prepare(`
    INSERT INTO clients (
      user_id, name, type, mobile, email, city, pan, aum, sip_amount, next_review_date, rm, status, source,
      age, gender, occupation, schemes, risk_profile, vip, kyc_pending, sip_stopped, goals_json, timeline_json, tasks_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, b.name, b.type || 'Client', b.mobile || null, b.email || null, b.city || null,
    b.pan ? encrypt(b.pan) : null, b.aum || 0, b.sipAmount || 0, b.nextReviewDate || null,
    b.rm || req.user.name, b.status || 'Active',
    b.age || null, b.gender || null, b.occupation || null, b.schemes || 0, b.riskProfile || null,
    (b.vip !== undefined ? b.vip : (b.aum || 0) > 15000000) ? 1 : 0, b.kycPending ? 1 : 0, 0,
    JSON.stringify(b.goals || []), JSON.stringify(b.timeline || [{ date: new Date().toISOString(), text: 'Client added to MF Sarthi' }]),
    JSON.stringify(b.tasks || [])
  );
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
  if (b.note) {
    db.prepare('INSERT INTO notes (user_id, client_id, body) VALUES (?, ?, ?)').run(req.user.id, row.id, b.note);
  }
  res.status(201).json({ client: rowToClient(row, { full: true }) });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Client not found' });
  const b = req.body || {};
  db.prepare(`
    UPDATE clients SET
      name = ?, type = ?, mobile = ?, email = ?, city = ?,
      pan = ?, aum = ?, sip_amount = ?, last_review_date = ?, next_review_date = ?, next_followup_date = ?,
      rm = ?, status = ?, age = ?, gender = ?, occupation = ?, schemes = ?, risk_profile = ?,
      vip = ?, kyc_pending = ?, sip_stopped = ?, goals_json = ?, timeline_json = ?, tasks_json = ?,
      updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(
    b.name ?? existing.name, b.type ?? existing.type, b.mobile ?? existing.mobile, b.email ?? existing.email,
    b.city ?? existing.city,
    b.pan !== undefined ? (b.pan ? encrypt(b.pan) : null) : existing.pan,
    b.aum ?? existing.aum, b.sipAmount ?? existing.sip_amount,
    b.lastReviewDate ?? existing.last_review_date, b.nextReviewDate ?? existing.next_review_date, b.nextFollowupDate ?? existing.next_followup_date,
    b.rm ?? existing.rm, b.status ?? existing.status,
    b.age ?? existing.age, b.gender ?? existing.gender, b.occupation ?? existing.occupation,
    b.schemes ?? existing.schemes, b.riskProfile ?? existing.risk_profile,
    b.vip !== undefined ? (b.vip ? 1 : 0) : existing.vip,
    b.kycPending !== undefined ? (b.kycPending ? 1 : 0) : existing.kyc_pending,
    b.sipStopped !== undefined ? (b.sipStopped ? 1 : 0) : existing.sip_stopped,
    b.goals !== undefined ? JSON.stringify(b.goals) : existing.goals_json,
    b.timeline !== undefined ? JSON.stringify(b.timeline) : existing.timeline_json,
    b.tasks !== undefined ? JSON.stringify(b.tasks) : existing.tasks_json,
    req.params.id, req.user.id
  );
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  res.json({ client: rowToClient(row, { full: true }) });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM clients WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found' });
  res.json({ ok: true });
});

// Notes on a client
router.post('/:id/notes', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note text is required' });
  const info = db.prepare('INSERT INTO notes (user_id, client_id, body) VALUES (?, ?, ?)').run(req.user.id, req.params.id, body);
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ note });
});

module.exports = router;

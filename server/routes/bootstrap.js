const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { rowToClient } = require('../utils/serialize');

const router = express.Router();
router.use(requireAuth);

// One call to load everything the app needs to render on first paint -
// avoids the frontend making 5 round trips before it can show anything.
router.get('/', (req, res) => {
  const uid = req.user.id;
  const clients = db.prepare('SELECT * FROM clients WHERE user_id = ? ORDER BY created_at DESC').all(uid);
  const leads = db.prepare('SELECT * FROM leads WHERE user_id = ? ORDER BY created_at DESC').all(uid);
  const meetings = db.prepare(`
    SELECT m.*, c.name as client_name, l.name as lead_name
    FROM meetings m
    LEFT JOIN clients c ON c.id = m.client_id AND c.user_id = m.user_id
    LEFT JOIN leads l ON l.id = m.lead_id AND l.user_id = m.user_id
    WHERE m.user_id = ? ORDER BY m.scheduled_at ASC
  `).all(uid);
  const followups = db.prepare(`
    SELECT f.*, c.name as client_name, l.name as lead_name
    FROM followups f
    LEFT JOIN clients c ON c.id = f.client_id AND c.user_id = f.user_id
    LEFT JOIN leads l ON l.id = f.lead_id AND l.user_id = f.user_id
    WHERE f.user_id = ? ORDER BY f.due_date ASC
  `).all(uid);
  const notes = db.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at ASC').all(uid);

  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
    clients: clients.map((c) => rowToClient(c, { full: true })),
    leads, meetings, followups, notes,
  });
});

module.exports = router;

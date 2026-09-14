const express = require('express');
const { stringify } = require('csv-stringify/sync');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { decrypt, maskPan } = require('../utils/crypto');

const router = express.Router();
router.use(requireAuth);

// Full client list - the everyday "give me a CSV of my book" export.
router.get('/clients.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC').all(req.user.id);
  const data = rows.map((r) => ({
    Name: r.name,
    Type: r.type,
    Mobile: r.mobile || '',
    Email: r.email || '',
    City: r.city || '',
    PAN: maskPan(decrypt(r.pan)),
    'AUM (₹)': r.aum,
    'Monthly SIP (₹)': r.sip_amount,
    'Last Review': r.last_review_date || '',
    'Next Follow-up': r.next_followup_date || '',
    RM: r.rm || '',
    Status: r.status,
  }));
  const csv = stringify(data, { header: true });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mf-sarthi-clients-${Date.now()}.csv"`);
  res.send(csv);
});

// Portfolio-level summary - one row per client with AUM/SIP, useful for a management view.
router.get('/portfolio.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM clients WHERE user_id = ? ORDER BY aum DESC').all(req.user.id);
  const totalAUM = rows.reduce((s, r) => s + (r.aum || 0), 0);
  const data = rows.map((r) => ({
    Client: r.name,
    'AUM (₹)': r.aum,
    '% of Book': totalAUM ? ((r.aum / totalAUM) * 100).toFixed(2) + '%' : '0%',
    'Monthly SIP (₹)': r.sip_amount,
    Status: r.status,
    'Last Review': r.last_review_date || 'Never',
  }));
  const csv = stringify(data, { header: true });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mf-sarthi-portfolio-${Date.now()}.csv"`);
  res.send(csv);
});

// Leads export
router.get('/leads.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const data = rows.map((r) => ({
    Name: r.name, Mobile: r.mobile || '', Email: r.email || '', City: r.city || '',
    Stage: r.stage, Notes: r.notes || '', 'Created At': r.created_at,
  }));
  const csv = stringify(data, { header: true });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mf-sarthi-leads-${Date.now()}.csv"`);
  res.send(csv);
});

module.exports = router;

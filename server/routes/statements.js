const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/crypto');
const { parseStatementFile } = require('../utils/statementParser');

const router = express.Router();
router.use(requireAuth);

// Memory storage only — we parse the file and discard the raw bytes immediately.
// A monthly statement contains AUM/PAN for many clients at once, so we deliberately
// don't retain the original file on disk (smaller blast radius if the server is ever
// compromised). Only an anonymous row-count summary is kept, in statement_imports.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB is generous for a CSV/XLSX statement
});

router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let parsed;
  try {
    parsed = await parseStatementFile(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const existingClients = db.prepare('SELECT * FROM clients WHERE user_id = ?').all(req.user.id);
  // Build lookup maps by decrypted PAN and by mobile for matching
  const byPan = new Map();
  const byMobile = new Map();
  for (const c of existingClients) {
    const pan = decrypt(c.pan);
    if (pan) byPan.set(pan.toUpperCase(), c);
    if (c.mobile) byMobile.set(String(c.mobile).replace(/\D/g, ''), c);
  }

  let matched = 0, created = 0, failed = 0;
  const updateStmt = db.prepare(`
    UPDATE clients SET aum = COALESCE(?, aum), sip_amount = COALESCE(?, sip_amount), updated_at = datetime('now')
    WHERE id = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO clients (user_id, name, type, mobile, pan, aum, sip_amount, rm, status, source)
    VALUES (?, ?, 'Client', ?, ?, ?, ?, ?, 'Active', 'statement_import')
  `);

  const txn = db.transaction((rows) => {
    for (const row of rows) {
      try {
        let match = null;
        if (row.pan && byPan.has(row.pan)) match = byPan.get(row.pan);
        else if (row.mobile) match = byMobile.get(row.mobile.replace(/\D/g, ''));

        if (match) {
          updateStmt.run(row.aum, row.sip, match.id);
          matched++;
        } else {
          insertStmt.run(
            req.user.id, row.name, row.mobile || null,
            row.pan ? encrypt(row.pan) : null, row.aum || 0, row.sip || 0, req.user.name
          );
          created++;
        }
      } catch (e) {
        failed++;
      }
    }
  });
  txn(parsed.rows);

  db.prepare(`
    INSERT INTO statement_imports (user_id, filename, rows_total, rows_matched, rows_created, rows_failed)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.id, req.file.originalname, parsed.rows.length, matched, created, failed);

  res.json({
    summary: { total: parsed.rows.length, matched, created, failed },
  });
});

router.get('/history', (req, res) => {
  const rows = db.prepare('SELECT * FROM statement_imports WHERE user_id = ? ORDER BY imported_at DESC').all(req.user.id);
  res.json({ imports: rows });
});

module.exports = router;

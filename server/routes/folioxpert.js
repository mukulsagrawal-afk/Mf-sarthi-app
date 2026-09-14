// FolioXpert AI - the personalized portfolio review report. Thin route, all the real work
// is in utils/folioEngine.js.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { buildReport } = require('../utils/folioEngine');

const router = express.Router();
router.use(requireAuth);

router.post('/report', async (req, res) => {
  const body = req.body || {};
  const client = body.client || {};
  const goals = Array.isArray(body.goals) ? body.goals.slice(0, 10) : [];
  const holdings = Array.isArray(body.holdings) ? body.holdings.slice(0, 12) : [];
  const proposedReplacements = (body.proposedReplacements && typeof body.proposedReplacements === 'object') ? body.proposedReplacements : {};

  if (!client.name) return res.status(400).json({ error: 'Client name is required' });
  if (!holdings.length) return res.status(400).json({ error: 'At least one holding is required' });
  for (const h of holdings) {
    const n = Number(h.schemeCode);
    if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: `Invalid scheme code: ${h.schemeCode}` });
  }

  try {
    const report = await buildReport({ client, goals, holdings, proposedReplacements });
    res.json(report);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not build the report.' });
  }
});

module.exports = router;

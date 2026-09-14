// Scheme search remains a shared API for FolioXpert's manual holding picker.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { searchSchemes, ensureSchemeIndex, getSchemeData } = require('../utils/mfapi');
const { computeMetrics } = require('../utils/metrics');
const router = express.Router();
router.use(requireAuth);
ensureSchemeIndex().catch(e => console.error('Scheme index build failed:', e.message));
router.get('/search', async (req, res) => {
  try { res.json({ results: await searchSchemes(req.query.q || '', 25) }); }
  catch (_) { res.status(502).json({ error: 'Could not reach the mutual fund data provider. Please try again.' }); }
});
router.get('/preview/:code', async (req, res) => {
  try {
    const { meta, data, stale } = await getSchemeData(req.params.code);
    const m = computeMetrics(data);
    res.json({ schemeCode:Number(req.params.code), schemeName:meta.scheme_name, category:meta.scheme_category,
      historyYears:m.historyYears, dataPoints:m.dataPoints, asOfDate:m.asOfDate,
      return1YAvailable:!!m.return1Y, rolling1YAvailable:!!m.rolling1Y, rolling3YAvailable:!!m.rolling3Y, stale:!!stale });
  } catch (e) { res.status(502).json({ error:'Could not verify NAV history for this scheme. Try again.' }); }
});
module.exports = router;

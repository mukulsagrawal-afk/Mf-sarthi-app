// Portfolio Analyzer - search/select mutual fund schemes (manually, or auto-detected
// from an uploaded CAS/CAMS/KARVY PDF), pull real NAV history from MFAPI.in, compute
// return/risk metrics, and benchmark against a curated set of category peers.

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { getSchemeData, searchSchemes, ensureSchemeIndex } = require('../utils/mfapi');
const { computeMetrics } = require('../utils/metrics');
const peerMap = require('../utils/peerMap');
const { extractCandidatesFromPdf } = require('../utils/casExtract');

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Kick off building the local scheme index in the background the first time this
// router is used (non-blocking - search/analyze fall back to MFAPI's own search until
// it's ready, see mfapi.js).
ensureSchemeIndex().catch((e) => console.error('Scheme index build failed:', e.message));

router.get('/search', async (req, res) => {
  const q = req.query.q || '';
  try {
    const results = await searchSchemes(q, 25);
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach the mutual fund data provider (MFAPI.in). Please try again in a moment.' });
  }
});

async function analyzeOne(schemeCode) {
  const { meta, data, fromCache, stale } = await getSchemeData(schemeCode);
  const metrics = computeMetrics(data);
  const category = peerMap.normalizeCategory(meta.scheme_category);
  const peers = category ? peerMap[category].filter((p) => p.schemeCode !== Number(schemeCode)) : [];

  let peerComparison = null;
  if (peers.length) {
    const peerResults = await Promise.all(peers.map(async (p) => {
      try {
        const pd = await getSchemeData(p.schemeCode);
        return { schemeCode: p.schemeCode, schemeName: pd.meta.scheme_name, metrics: computeMetrics(pd.data) };
      } catch (e) {
        return null;
      }
    }));
    const validPeers = peerResults.filter(Boolean);
    const droppedCount = peerResults.length - validPeers.length;
    if (validPeers.length) {
      const withReturns = validPeers
        .filter((p) => p.metrics.return1Y)
        .map((p) => p.metrics.return1Y.cagrPct);
      const categoryAvg1Y = withReturns.length ? round2(withReturns.reduce((a, b) => a + b, 0) / withReturns.length) : null;
      const ranked = [{ schemeCode: Number(schemeCode), schemeName: meta.scheme_name, return1Y: metrics.return1Y ? metrics.return1Y.cagrPct : null }, ...validPeers.map((p) => ({ schemeCode: p.schemeCode, schemeName: p.schemeName, return1Y: p.metrics.return1Y ? p.metrics.return1Y.cagrPct : null }))]
        .filter((r) => r.return1Y !== null)
        .sort((a, b) => b.return1Y - a.return1Y);
      const rank = ranked.findIndex((r) => r.schemeCode === Number(schemeCode)) + 1;
      peerComparison = {
        category, categoryAvg1Y, rank: rank || null, outOf: ranked.length,
        peers: validPeers.map((p) => ({ schemeCode: p.schemeCode, schemeName: p.schemeName, metrics: p.metrics })),
        droppedPeers: droppedCount || undefined, // surfaced only when non-zero, so a full comparison stays quiet
      };
    }
  }

  return {
    schemeCode: Number(schemeCode),
    schemeName: meta.scheme_name,
    fundHouse: meta.fund_house,
    category: meta.scheme_category,
    metrics,
    peerComparison,
    dataFreshness: stale ? 'stale_fallback' : fromCache ? 'cached' : 'live',
  };
}
function round2(n) { return Math.round(n * 100) / 100; }

router.get('/:code', async (req, res) => {
  try {
    const result = await analyzeOne(req.params.code);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: `Could not fetch data for scheme ${req.params.code}: ${e.message}` });
  }
});

// Analyze up to 8 hand-picked schemes at once - the "manual dropdown" path.
router.post('/analyze', async (req, res) => {
  const codes = Array.isArray(req.body?.codes) ? req.body.codes.filter(Boolean).slice(0, 8) : [];
  if (!codes.length) return res.status(400).json({ error: 'Select at least one scheme to analyze' });

  const results = await Promise.all(codes.map(async (code) => {
    try { return await analyzeOne(code); }
    catch (e) { return { schemeCode: Number(code) || null, requestedCode: code, error: e.message }; }
  }));
  res.json({ results });
});

// Upload a CAS/CAMS/KARVY PDF and get back best-effort candidate holdings for the user
// to confirm - this does NOT run the analysis itself, by design (see casExtract.js).
router.post('/extract-cas', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await extractCandidatesFromPdf(req.file.buffer, req.body.password || undefined);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;

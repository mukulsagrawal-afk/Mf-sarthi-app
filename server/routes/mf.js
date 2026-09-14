// Scheme search remains a shared API for FolioXpert's manual holding picker.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { searchSchemes, ensureSchemeIndex } = require('../utils/mfapi');
const router = express.Router();
router.use(requireAuth);
ensureSchemeIndex().catch(e => console.error('Scheme index build failed:', e.message));
router.get('/search', async (req, res) => {
  try { res.json({ results: await searchSchemes(req.query.q || '', 25) }); }
  catch (_) { res.status(502).json({ error: 'Could not reach the mutual fund data provider. Please try again.' }); }
});
module.exports = router;

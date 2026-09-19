const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const { importPortfolioBuffer, getSchemeHoldings, lookThrough, refreshAllSources, coverageStatus, endOfPreviousMonth } = require('../utils/portfolioService');

const router = express.Router();
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:45*1024*1024, files:1 } });
router.use(requireAuth);
function requireOwner(req,res,next) {
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  if (!user || user.role !== 'owner') return res.status(403).json({error:'Only the practice owner can refresh or import global disclosure data.'});
  next();
}

router.get('/status', (_req,res) => res.json(coverageStatus()));
router.get('/scheme/:code', (req,res) => {
  const data = getSchemeHoldings(req.params.code);
  if (!data) return res.status(404).json({ error:'No validated portfolio disclosure is mapped to this scheme yet.', canUpload:true });
  res.json(data);
});
router.post('/look-through', (req,res) => {
  try { res.json(lookThrough(Array.isArray(req.body?.funds) ? req.body.funds : [])); }
  catch (e) { res.status(400).json({ error:e.message }); }
});
router.post('/upload', requireOwner, upload.single('file'), (req,res) => {
  try {
    if (!req.file) return res.status(400).json({error:'Choose an official AMC Excel disclosure'});
    res.json(importPortfolioBuffer({ buffer:req.file.buffer, filename:req.file.originalname, mfId:req.body.mfId || null,
      disclosureDate:req.body.disclosureDate || endOfPreviousMonth(), sourceUrl:req.body.sourceUrl || null }));
  } catch (e) { res.status(400).json({error:e.message}); }
});
router.post('/refresh', requireOwner, (req,res) => {
  const current = coverageStatus().refresh;
  if (current.running) return res.status(202).json({started:false,refresh:current});
  refreshAllSources(req.body?.disclosureDate || endOfPreviousMonth()).catch(e => console.error('Portfolio refresh failed:',e));
  res.status(202).json({started:true,refresh:coverageStatus().refresh});
});

module.exports = router;

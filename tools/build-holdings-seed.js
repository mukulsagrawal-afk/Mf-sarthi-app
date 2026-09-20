const path = require('path');

const root = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(root, 'server', 'seed-work-verified');
process.env.HOLDINGS_DATA_DIR = process.env.HOLDINGS_DATA_DIR || process.env.DATA_DIR;

const { ensureSchemeIndex } = require('../server/utils/mfapi');
const { refreshAllSources, coverageStatus, refreshState } = require('../server/utils/portfolioService');
const holdingsDb = require('../server/holdings-db');

async function main() {
  const disclosureDate = process.argv[2] || '2026-08-31';
  console.log(`Building holdings snapshot for ${disclosureDate}`);
  await ensureSchemeIndex();
  const timer = setInterval(() => console.log(JSON.stringify(refreshState)), 5000);
  try { await refreshAllSources(disclosureDate, { skipExisting:true }); }
  finally { clearInterval(timer); }
  holdingsDb.prepare(`INSERT INTO metadata (key,value,updated_at) VALUES ('snapshot_date',?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`).run(disclosureDate);
  holdingsDb.prepare(`INSERT INTO metadata (key,value,updated_at) VALUES ('source','Official AMC monthly portfolio disclosures',datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`).run();
  const status = coverageStatus();
  console.log(JSON.stringify({summary:status.summary,sources:status.sources.map(x=>({mfId:x.mfId,mfName:x.mfName,schemes:x.schemes,date:x.latestDisclosureDate,error:x.lastError}))},null,2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });

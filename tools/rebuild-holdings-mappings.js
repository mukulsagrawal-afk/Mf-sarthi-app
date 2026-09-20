const path = require('path');

const root = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(root, 'server', 'seed-work-verified');
process.env.HOLDINGS_DATA_DIR = process.env.HOLDINGS_DATA_DIR || process.env.DATA_DIR;

const holdingsDb = require('../server/holdings-db');
const { normalizeSchemeName } = require('../server/utils/portfolioParser');
const { mapPortfolioScheme } = require('../server/utils/portfolioService');

const schemes = holdingsDb.prepare('SELECT id,canonical_name FROM portfolio_schemes ORDER BY id').all();
let mapped = 0;
holdingsDb.transaction(() => {
  holdingsDb.prepare('DELETE FROM scheme_map').run();
  const update = holdingsDb.prepare('UPDATE portfolio_schemes SET normalized_name=? WHERE id=?');
  for (const scheme of schemes) {
    const normalized = normalizeSchemeName(scheme.canonical_name);
    update.run(normalized,scheme.id);
    mapped += mapPortfolioScheme(scheme.id,scheme.canonical_name,normalized);
  }
})();
console.log(JSON.stringify({portfolioSchemes:schemes.length,mappedPlans:mapped}));

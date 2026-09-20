const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(root, 'server', 'seed-work-verified');
process.env.HOLDINGS_DATA_DIR = process.env.HOLDINGS_DATA_DIR || process.env.DATA_DIR;

const holdingsDb = require('../server/holdings-db');
const { normalizeSchemeName } = require('../server/utils/portfolioParser');
const { mapPortfolioScheme } = require('../server/utils/portfolioService');

const BASE = 'https://wealthkit.co.in';
const SNAPSHOT = '2026-08-31';

function decode(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

async function fetchText(url, tries = 3) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await fetch(url, { signal:AbortSignal.timeout(20000), headers:{'User-Agent':'MF-Sarthi-Holdings-Seed/1.0'} });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      last = error;
      if (attempt < tries) await new Promise(resolve => setTimeout(resolve, attempt * 750));
    }
  }
  throw last;
}

function links(html, pattern) {
  const result = new Set();
  for (const match of String(html).matchAll(/href=["']([^"']+)["']/g)) if (pattern.test(match[1])) result.add(new URL(match[1], BASE).href);
  return [...result];
}

function parseFund(html, url) {
  const name = decode(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  const badges = [...html.matchAll(/<span\b[^>]*class=["'][^"']*badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map(x => decode(x[1]));
  const amcName = badges.find(x => /mutual fund/i.test(x)) || '';
  const category = badges.find(x => x !== amcName) || '';
  const dateText = decode(html.match(/Portfolio as of\s*<strong>([^<]+)<\/strong>/i)?.[1]);
  if (dateText !== '31 August 2026') throw new Error(`Unexpected snapshot date: ${dateText || 'missing'}`);
  const table = html.match(/Full Portfolio \([^)]*holdings\)[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!name || !amcName || !table) throw new Error('Fund identity or holdings table was missing');
  const holdings = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x => decode(x[1]));
    if (cells.length < 4) continue;
    const weight = Number(cells[3].replace('%',''));
    if (!cells[1] || !Number.isFinite(weight)) continue;
    const clue = cells[1].toLowerCase();
    let assetType = cells[2] && cells[2] !== '—' ? 'Equity' : 'Other';
    if (/bond|debenture|treasury|tbill|commercial paper|certificate of deposit|government securit|g-sec/.test(clue)) assetType = 'Debt';
    holdings.push({ instrumentName:cells[1], sector:cells[2] === '—' ? null : cells[2], assetType, pctNav:weight });
  }
  if (!holdings.length) throw new Error('No portfolio rows were parsed');
  return { name, amcName, category, url, holdings };
}

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\b(the|asset management company|limited|ltd)\b/g,' ').replace(/\s+/g,' ').trim();
}

function resolveMfId(amcName, sources) {
  const wanted = normalizedText(amcName);
  const exact = sources.find(x => normalizedText(x.mf_name) === wanted || normalizedText(x.amc_name) === wanted);
  if (exact) return exact.mf_id;
  const shorter = wanted.replace(/\bmutual fund\b/g,'').trim();
  return sources.find(x => normalizedText(x.mf_name).replace(/\bmutual fund\b/g,'').trim() === shorter)?.mf_id || null;
}

const insertImport = holdingsDb.prepare(`INSERT INTO portfolio_imports
  (mf_id,source_url,source_filename,source_sha256,disclosure_date,parser_version,status,scheme_count,holding_count,warning_json,stored_path)
  VALUES (?,?,?,?,?,'wealthkit-html-v1','valid',1,?,?,NULL)`);
const upsertScheme = holdingsDb.prepare(`INSERT INTO portfolio_schemes (mf_id,canonical_name,normalized_name) VALUES (?,?,?)
  ON CONFLICT(mf_id,normalized_name) DO UPDATE SET canonical_name=excluded.canonical_name RETURNING id`);
const insertHolding = holdingsDb.prepare(`INSERT INTO holdings
  (portfolio_scheme_id,import_id,disclosure_date,row_number,instrument_name,asset_type,sector,pct_nav)
  VALUES (?,?,?,?,?,?,?,?)`);
const existingAtDate = holdingsDb.prepare(`SELECT 1 FROM portfolio_schemes ps JOIN holdings h ON h.portfolio_scheme_id=ps.id
  WHERE ps.mf_id=? AND ps.normalized_name=? AND h.disclosure_date=? LIMIT 1`);

function importFund(fund, html, sources) {
  const mfId = resolveMfId(fund.amcName, sources);
  if (!mfId) throw new Error(`AMC was not mapped: ${fund.amcName}`);
  const normalized = normalizeSchemeName(fund.name);
  if (existingAtDate.get(mfId, normalized, SNAPSHOT)) return { skipped:true, holdings:0, mapped:0 };
  const sha = crypto.createHash('sha256').update(`wealthkit:${fund.url}:${html}`).digest('hex');
  if (holdingsDb.prepare('SELECT 1 FROM portfolio_imports WHERE source_sha256=?').get(sha)) return { skipped:true, holdings:0, mapped:0 };
  return holdingsDb.transaction(() => {
    const warning = JSON.stringify(['Normalized secondary copy of the AMC monthly disclosure; source attribution is retained.']);
    const imported = insertImport.run(mfId, fund.url, `${new URL(fund.url).pathname.split('/').pop()}.html`, sha, SNAPSHOT, fund.holdings.length, warning);
    const importId = Number(imported.lastInsertRowid);
    const schemeId = upsertScheme.get(mfId, fund.name, normalized).id;
    fund.holdings.forEach((holding, index) => insertHolding.run(schemeId, importId, SNAPSHOT, index + 1, holding.instrumentName, holding.assetType, holding.sector, holding.pctNav));
    const mapped = mapPortfolioScheme(schemeId, fund.name, normalized);
    holdingsDb.prepare("UPDATE amc_sources SET last_success_at=datetime('now'),last_error=NULL WHERE mf_id=?").run(mfId);
    return { skipped:false, holdings:fund.holdings.length, mapped };
  })();
}

async function pool(items, workers, task) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index], index);
    }
  }
  await Promise.all(Array.from({length:Math.min(workers,items.length)}, worker));
}

async function main() {
  console.log('Discovering August 2026 normalized holdings pages');
  const index = await fetchText(`${BASE}/funds`);
  const amcUrls = links(index, /^\/amc\/[a-z0-9-]+\/?$/i);
  const fundUrls = new Set();
  await pool(amcUrls, 6, async url => links(await fetchText(url), /^\/funds\/[a-z0-9-]+\/?$/i).forEach(x => fundUrls.add(x)));
  console.log(`Found ${amcUrls.length} fund houses and ${fundUrls.size} scheme portfolios`);
  const sources = holdingsDb.prepare('SELECT * FROM amc_sources').all();
  const stats = { imported:0, skipped:0, failed:0, holdings:0, mappedPlans:0 };
  await pool([...fundUrls], 5, async (url, indexNumber) => {
    try {
      const html = await fetchText(url);
      const result = importFund(parseFund(html,url),html,sources);
      if (result.skipped) stats.skipped++; else { stats.imported++; stats.holdings += result.holdings; stats.mappedPlans += result.mapped; }
    } catch (error) {
      stats.failed++;
      console.error(`Failed ${url}: ${error.message}`);
    }
    if ((indexNumber + 1) % 25 === 0) console.log(JSON.stringify({ checked:indexNumber + 1, total:fundUrls.size, ...stats }));
  });
  holdingsDb.prepare(`INSERT INTO metadata (key,value,updated_at) VALUES ('secondary_snapshot_source','WealthKit normalized AMC disclosures dated 2026-08-31',datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`).run();
  console.log(JSON.stringify(stats,null,2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });

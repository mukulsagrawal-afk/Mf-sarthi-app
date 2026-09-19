const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const db = require('../db');
const seedSources = require('../config/amfi-sources.json');
const { parseWorkbook, normalizeSchemeName, PARSER_VERSION } = require('./portfolioParser');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MAX_BYTES = Math.max(5, Number(process.env.PORTFOLIO_SOURCE_MAX_MB || 40)) * 1024 * 1024;
const refreshState = { running: false, startedAt: null, finishedAt: null, checked: 0, imported: 0, failed: 0, message: '' };

function seedAmcSources() {
  const upsert = db.prepare(`INSERT INTO mf_amc_sources (mf_id,mf_name,amc_name,monthly_url) VALUES (?,?,?,?)
    ON CONFLICT(mf_id) DO UPDATE SET mf_name=excluded.mf_name,amc_name=excluded.amc_name,
    monthly_url=CASE WHEN excluded.monthly_url<>'' THEN excluded.monthly_url ELSE mf_amc_sources.monthly_url END,updated_at=datetime('now')`);
  db.transaction(() => seedSources.forEach(s => upsert.run(s.mfId, s.mfName, s.amcName || null, s.monthlyUrl || '')))();
}

function parseAmfiRegistryHtml(html) {
  const source = String(html || '');
  const marker = '\\"members\\":';
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) throw new Error('AMFI source registry was not present in the page');
  const start = source.indexOf('[', markerAt + marker.length);
  let depth = 0, end = -1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']' && --depth === 0) { end = i + 1; break; }
  }
  if (start < 0 || end < 0) throw new Error('AMFI source registry was incomplete');
  const rows = JSON.parse(source.slice(start, end).split('\\"').join('"'));
  return rows.map(x => ({ mfId:Number(x.mf_id), mfName:x.mf_name, amcName:x.amc_name || null,
    monthlyUrl:x.amc_monthly_portfolio_disclosure || '' })).filter(x => Number.isInteger(x.mfId) && x.mfName);
}

async function syncAmfiRegistry() {
  const page = await fetchBuffer('https://www.amfiindia.com/online-center/portfolio-disclosure');
  const current = parseAmfiRegistryHtml(page.buffer.toString('utf8'));
  if (current.length < 40) throw new Error('AMFI returned an unexpectedly short AMC registry');
  const upsert = db.prepare(`INSERT INTO mf_amc_sources (mf_id,mf_name,amc_name,monthly_url) VALUES (?,?,?,?)
    ON CONFLICT(mf_id) DO UPDATE SET mf_name=excluded.mf_name,amc_name=excluded.amc_name,
    monthly_url=CASE WHEN excluded.monthly_url<>'' THEN excluded.monthly_url ELSE mf_amc_sources.monthly_url END,updated_at=datetime('now')`);
  db.transaction(() => current.forEach(s => upsert.run(s.mfId,s.mfName,s.amcName,s.monthlyUrl)))();
  return current.length;
}

function endOfPreviousMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

function dateOnly(value) {
  const s = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) throw new Error('Disclosure date must be YYYY-MM-DD');
  return s;
}

function tokenScore(a, b) {
  const aa = new Set(normalizeSchemeName(a).split(' ').filter(Boolean));
  const bb = new Set(normalizeSchemeName(b).split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  const intersection = [...aa].filter(x => bb.has(x)).length;
  return intersection / Math.max(aa.size, bb.size);
}

function mapPortfolioScheme(portfolioSchemeId, canonicalName, normalizedName) {
  const index = db.prepare('SELECT scheme_code, scheme_name FROM mf_scheme_index').all();
  const insert = db.prepare(`INSERT INTO mf_portfolio_scheme_map (scheme_code,portfolio_scheme_id,match_method,confidence)
    VALUES (?,?,?,?) ON CONFLICT(scheme_code) DO UPDATE SET portfolio_scheme_id=excluded.portfolio_scheme_id,
    match_method=excluded.match_method,confidence=excluded.confidence,mapped_at=datetime('now')`);
  let mapped = 0;
  for (const candidate of index) {
    const normalizedCandidate = normalizeSchemeName(candidate.scheme_name);
    const exact = normalizedCandidate === normalizedName;
    const score = exact ? 1 : tokenScore(normalizedName, normalizedCandidate);
    if (exact || score >= 0.92) { insert.run(candidate.scheme_code, portfolioSchemeId, exact ? 'normalized-exact' : 'token-match', score); mapped++; }
  }
  return mapped;
}

function importPortfolioBuffer({ buffer, filename, mfId = null, disclosureDate, sourceUrl = null }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('The uploaded disclosure is empty');
  if (buffer.length > MAX_BYTES) throw new Error(`Disclosure exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit`);
  if (!/\.(xlsx?|xlsm)$/i.test(filename)) throw new Error('Use the original AMC Excel file (.xls, .xlsx or .xlsm)');
  const asOf = dateOnly(disclosureDate);
  if (sourceUrl) sourceUrl = assertPublicUrl(sourceUrl).href;
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const duplicate = db.prepare('SELECT * FROM mf_portfolio_imports WHERE source_sha256=?').get(sha);
  if (duplicate) {
    if (mfId != null) db.prepare("UPDATE mf_amc_sources SET last_success_at=datetime('now'),last_error=NULL WHERE mf_id=?").run(Number(mfId));
    return { duplicate: true, importId: duplicate.id, schemeCount: duplicate.scheme_count, holdingCount: duplicate.holding_count };
  }
  if (mfId != null && !db.prepare('SELECT 1 FROM mf_amc_sources WHERE mf_id=?').get(Number(mfId))) throw new Error('Unknown AMC source');
  const parsed = parseWorkbook(buffer, filename);
  const sourceDir = path.join(DATA_DIR, 'portfolio-sources', asOf.slice(0, 7));
  fs.mkdirSync(sourceDir, { recursive: true });
  const safeName = `${sha.slice(0, 12)}-${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const storedPath = path.join(sourceDir, safeName);
  const result = db.transaction(() => {
    const imported = db.prepare(`INSERT INTO mf_portfolio_imports
      (mf_id,source_url,source_filename,source_sha256,disclosure_date,parser_version,status,scheme_count,holding_count,warning_json,stored_path)
      VALUES (?,?,?,?,?,?, 'valid',0,0,?,?)`).run(mfId == null ? null : Number(mfId), sourceUrl, filename, sha, asOf, PARSER_VERSION, JSON.stringify(parsed.warnings), storedPath);
    const importId = Number(imported.lastInsertRowid);
    const upsertScheme = db.prepare(`INSERT INTO mf_portfolio_schemes (mf_id,canonical_name,normalized_name) VALUES (?,?,?)
      ON CONFLICT(mf_id,normalized_name) DO UPDATE SET canonical_name=excluded.canonical_name RETURNING id`);
    const insertHolding = db.prepare(`INSERT INTO mf_portfolio_holdings
      (portfolio_scheme_id,import_id,disclosure_date,row_number,instrument_name,isin,asset_type,sector,issuer,rating,maturity_date,quantity,market_value,pct_nav)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let holdings = 0, mapped = 0;
    for (const scheme of parsed.schemes) {
      const schemeId = upsertScheme.get(mfId == null ? null : Number(mfId), scheme.name, scheme.normalizedName).id;
      for (const h of scheme.holdings) {
        insertHolding.run(schemeId, importId, asOf, h.rowNumber, h.instrumentName, h.isin, h.assetType, h.sector, h.issuer || null, h.rating, h.maturityDate, h.quantity, h.marketValue, h.pctNav);
        holdings++;
      }
      mapped += mapPortfolioScheme(schemeId, scheme.name, scheme.normalizedName);
    }
    db.prepare('UPDATE mf_portfolio_imports SET scheme_count=?,holding_count=? WHERE id=?').run(parsed.schemes.length, holdings, importId);
    if (mfId != null) db.prepare("UPDATE mf_amc_sources SET last_success_at=datetime('now'),last_error=NULL WHERE mf_id=?").run(Number(mfId));
    return { importId, duplicate: false, schemeCount: parsed.schemes.length, holdingCount: holdings, mappedPlans: mapped, warnings: parsed.warnings };
  })();
  try { fs.writeFileSync(storedPath, buffer, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') console.warn('Could not retain source disclosure:', e.message); }
  return result;
}

function resolvePortfolioScheme(schemeCode) {
  const code = Number(schemeCode);
  if (!Number.isInteger(code) || code <= 0) return null;
  let row = db.prepare(`SELECT ps.*,si.scheme_name,pm.confidence,pm.match_method FROM mf_portfolio_scheme_map pm
    JOIN mf_portfolio_schemes ps ON ps.id=pm.portfolio_scheme_id JOIN mf_scheme_index si ON si.scheme_code=pm.scheme_code WHERE pm.scheme_code=?`).get(code);
  if (row) return row;
  const nav = db.prepare('SELECT scheme_name FROM mf_scheme_index WHERE scheme_code=?').get(code);
  if (!nav) return null;
  const normalized = normalizeSchemeName(nav.scheme_name);
  row = db.prepare('SELECT *, ? AS scheme_name, 1 AS confidence, ? AS match_method FROM mf_portfolio_schemes WHERE normalized_name=? ORDER BY id DESC LIMIT 1').get(nav.scheme_name, 'on-demand-exact', normalized);
  if (row) db.prepare(`INSERT OR REPLACE INTO mf_portfolio_scheme_map (scheme_code,portfolio_scheme_id,match_method,confidence,mapped_at) VALUES (?,?,?,1,datetime('now'))`).run(code, row.id, 'on-demand-exact');
  return row;
}

function getSchemeHoldings(schemeCode) {
  const scheme = resolvePortfolioScheme(schemeCode);
  if (!scheme) return null;
  const latest = db.prepare(`SELECT disclosure_date,import_id FROM mf_portfolio_holdings WHERE portfolio_scheme_id=? ORDER BY disclosure_date DESC,import_id DESC LIMIT 1`).get(scheme.id);
  if (!latest) return null;
  const holdings = db.prepare(`SELECT instrument_name AS instrumentName,isin,asset_type AS assetType,sector,rating,maturity_date AS maturityDate,
    quantity,market_value AS marketValue,pct_nav AS pctNav FROM mf_portfolio_holdings WHERE portfolio_scheme_id=? AND disclosure_date=? AND import_id=? ORDER BY COALESCE(pct_nav,0) DESC`).all(scheme.id, latest.disclosure_date, latest.import_id);
  const source = db.prepare(`SELECT source_url AS sourceUrl,source_filename AS sourceFilename,imported_at AS importedAt,warning_json AS warningJson FROM mf_portfolio_imports WHERE id=?`).get(latest.import_id);
  return { schemeCode:Number(schemeCode), schemeName:scheme.scheme_name, portfolioName:scheme.canonical_name, disclosureDate:latest.disclosure_date,
    confidence:scheme.confidence, matchMethod:scheme.match_method, holdings, source:{...source,warnings:JSON.parse(source.warningJson||'[]'),warningJson:undefined} };
}

function lookThrough(funds) {
  const exposure = new Map(), missing = [], used = [];
  const totalValue = funds.reduce((s, f) => s + Math.max(0, Number(f.currentValue) || 0), 0);
  if (!totalValue) throw new Error('Add at least one holding with a current value');
  for (const fund of funds.slice(0, 20)) {
    const value = Math.max(0, Number(fund.currentValue) || 0);
    if (!value) continue;
    const portfolio = getSchemeHoldings(fund.schemeCode);
    if (!portfolio) { missing.push({ schemeCode:Number(fund.schemeCode), currentValue:value }); continue; }
    used.push({ schemeCode:Number(fund.schemeCode), currentValue:value, schemeName:portfolio.schemeName, disclosureDate:portfolio.disclosureDate });
    for (const h of portfolio.holdings) {
      if (!Number.isFinite(Number(h.pctNav))) continue;
      const key = h.isin || `NAME:${h.instrumentName.toLowerCase()}`;
      const amount = value * Number(h.pctNav) / 100;
      const existing = exposure.get(key) || { instrumentName:h.instrumentName, isin:h.isin, sector:h.sector, assetType:h.assetType, amount:0 };
      existing.amount += amount; exposure.set(key, existing);
    }
  }
  return { totalValue, coveredValue:used.reduce((s,x)=>s+x.currentValue,0), used, missing,
    exposures:[...exposure.values()].map(x=>({...x,pctPortfolio:x.amount/totalValue*100})).sort((a,b)=>b.amount-a.amount) };
}

function isPrivateAddress(value) {
  const address = String(value || '').toLowerCase().replace(/^::ffff:/,'');
  if (!net.isIP(address)) return false;
  if (address === '::1' || address === '0.0.0.0' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127));
}

function assertPublicUrl(raw) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.hostname.toLowerCase() === 'localhost' || isPrivateAddress(url.hostname)) throw new Error('Unsafe source URL');
  return url;
}

async function fetchBuffer(rawUrl) {
  const url = assertPublicUrl(rawUrl);
  if (!net.isIP(url.hostname)) {
    const addresses = await dns.lookup(url.hostname, { all:true });
    if (addresses.some(a => isPrivateAddress(a.address))) throw new Error('Unsafe source host');
  }
  const res = await fetch(url, { redirect:'follow', signal:AbortSignal.timeout(30000), headers:{'User-Agent':'MF-Sarthi-Portfolio-Importer/1.0'} });
  if (!res.ok) throw new Error(`Source returned HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0); if (declared > MAX_BYTES) throw new Error('Source file is too large');
  const data = Buffer.from(await res.arrayBuffer()); if (data.length > MAX_BYTES) throw new Error('Source file is too large');
  return { buffer:data, contentType:res.headers.get('content-type')||'', finalUrl:res.url };
}

function discoverExcelLinks(html, pageUrl) {
  const found = new Set();
  const re = /(?:href|data-url|data-href)\s*=\s*["']([^"']+)["']|https?:\/\/[^\s"'<>]+/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = (match[1] || match[0]).replace(/&amp;/g,'&');
    try { const u = new URL(raw, pageUrl); if (/\.(xlsx?|xlsm)(?:$|[?#])/i.test(u.href)) found.add(u.href); } catch (_) {}
  }
  return [...found];
}

function linkScore(url, targetDate) {
  const month = new Date(`${targetDate}T00:00:00Z`).toLocaleString('en-US',{month:'long',timeZone:'UTC'}).toLowerCase();
  const short = month.slice(0,3), ym = targetDate.slice(0,7).replace('-',''), yy = targetDate.slice(2,7).replace('-','');
  const s = decodeURIComponent(url).toLowerCase();
  return (/portfolio/.test(s)?5:0) + (s.includes(month)?5:0) + (s.includes(short)?2:0) + (s.includes(ym)||s.includes(yy)?4:0);
}

async function refreshOneSource(source, targetDate) {
  db.prepare("UPDATE mf_amc_sources SET last_checked_at=datetime('now') WHERE mf_id=?").run(source.mf_id);
  if (!source.monthly_url) throw new Error('AMFI has not listed a monthly disclosure URL');
  const page = await fetchBuffer(source.monthly_url);
  let links = [];
  if (/\.(xlsx?|xlsm)(?:$|[?#])/i.test(page.finalUrl) || /spreadsheet|excel/i.test(page.contentType)) links = [page.finalUrl];
  else links = discoverExcelLinks(page.buffer.toString('utf8'), page.finalUrl).sort((a,b)=>linkScore(b,targetDate)-linkScore(a,targetDate));
  if (!links.length) throw new Error('No Excel disclosure link was discoverable; upload the official file manually');
  const best = linkScore(links[0], targetDate); links = links.filter(u => linkScore(u,targetDate) >= Math.max(1,best-2)).slice(0,60);
  let imported = 0, lastError = null;
  for (const link of links) {
    try {
      const file = await fetchBuffer(link);
      let filename = path.basename(new URL(file.finalUrl).pathname) || 'portfolio.xlsx';
      if (!/\.(xlsx?|xlsm)$/i.test(filename)) filename += /excel|spreadsheet/i.test(file.contentType) ? '.xlsx' : '.xlsx';
      const result = importPortfolioBuffer({ buffer:file.buffer, filename, mfId:source.mf_id, disclosureDate:targetDate, sourceUrl:file.finalUrl });
      if (!result.duplicate) imported++;
    } catch (e) { lastError = e; }
  }
  if (!imported && lastError) throw lastError;
  return imported;
}

async function refreshAllSources(targetDate = endOfPreviousMonth()) {
  if (refreshState.running) return refreshState;
  Object.assign(refreshState,{running:true,startedAt:new Date().toISOString(),finishedAt:null,checked:0,imported:0,failed:0,message:'Refreshing official AMC disclosures'});
  try { await syncAmfiRegistry(); } catch (e) { console.warn('AMFI registry refresh failed; using the last saved registry:',e.message); }
  const sources = db.prepare('SELECT * FROM mf_amc_sources WHERE enabled=1 ORDER BY mf_name').all();
  for (const source of sources) {
    try { refreshState.imported += await refreshOneSource(source,targetDate); }
    catch (e) { refreshState.failed++; db.prepare("UPDATE mf_amc_sources SET last_error=? WHERE mf_id=?").run(String(e.message).slice(0,500),source.mf_id); }
    refreshState.checked++;
  }
  Object.assign(refreshState,{running:false,finishedAt:new Date().toISOString(),message:`Checked ${refreshState.checked} AMCs; imported ${refreshState.imported} new file(s)`});
  return refreshState;
}

function coverageStatus() {
  const sources = db.prepare(`SELECT s.mf_id AS mfId,s.mf_name AS mfName,s.monthly_url AS monthlyUrl,s.last_checked_at AS lastCheckedAt,
    s.last_success_at AS lastSuccessAt,s.last_error AS lastError,COUNT(DISTINCT ps.id) AS schemes,
    MAX(i.disclosure_date) AS latestDisclosureDate FROM mf_amc_sources s LEFT JOIN mf_portfolio_schemes ps ON ps.mf_id=s.mf_id
    LEFT JOIN mf_portfolio_imports i ON i.mf_id=s.mf_id AND i.status='valid' GROUP BY s.mf_id ORDER BY s.mf_name`).all();
  const summary = db.prepare(`SELECT COUNT(DISTINCT ps.id) AS portfolioSchemes,COUNT(DISTINCT pm.scheme_code) AS mappedPlans,
    COUNT(DISTINCT h.id) AS holdings,MAX(h.disclosure_date) AS latestDisclosureDate FROM mf_portfolio_schemes ps
    LEFT JOIN mf_portfolio_scheme_map pm ON pm.portfolio_scheme_id=ps.id LEFT JOIN mf_portfolio_holdings h ON h.portfolio_scheme_id=ps.id`).get();
  return { summary, sources, refresh:{...refreshState}, expectedDisclosureDate:endOfPreviousMonth() };
}

seedAmcSources();
module.exports = { importPortfolioBuffer, getSchemeHoldings, lookThrough, refreshAllSources, coverageStatus, refreshState, endOfPreviousMonth, discoverExcelLinks, assertPublicUrl, isPrivateAddress, seedAmcSources, parseAmfiRegistryHtml, syncAmfiRegistry };

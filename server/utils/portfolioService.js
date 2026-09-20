const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const db = require('../db');
const holdingsDb = require('../holdings-db');
const seedSources = require('../config/amfi-sources.json');
const { parseWorkbook, normalizeSchemeName, PARSER_VERSION } = require('./portfolioParser');
const { syncAmfiSchemeUniverse } = require('./amfiUniverse');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MAX_BYTES = Math.max(5, Number(process.env.PORTFOLIO_SOURCE_MAX_MB || 40)) * 1024 * 1024;
const refreshState = { running: false, startedAt: null, finishedAt: null, checked: 0, imported: 0, failed: 0, message: '' };

function seedAmcSources() {
  const upsert = holdingsDb.prepare(`INSERT INTO amc_sources (mf_id,mf_name,amc_name,monthly_url) VALUES (?,?,?,?)
    ON CONFLICT(mf_id) DO UPDATE SET mf_name=excluded.mf_name,amc_name=excluded.amc_name,
    monthly_url=CASE WHEN excluded.monthly_url<>'' THEN excluded.monthly_url ELSE amc_sources.monthly_url END,updated_at=datetime('now')`);
  holdingsDb.transaction(() => seedSources.forEach(s => upsert.run(s.mfId, s.mfName, s.amcName || null, s.monthlyUrl || '')))();
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
  const upsert = holdingsDb.prepare(`INSERT INTO amc_sources (mf_id,mf_name,amc_name,monthly_url) VALUES (?,?,?,?)
    ON CONFLICT(mf_id) DO UPDATE SET mf_name=excluded.mf_name,amc_name=excluded.amc_name,
    monthly_url=CASE WHEN excluded.monthly_url<>'' THEN excluded.monthly_url ELSE amc_sources.monthly_url END,updated_at=datetime('now')`);
  holdingsDb.transaction(() => current.forEach(s => upsert.run(s.mfId,s.mfName,s.amcName,s.monthlyUrl)))();
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

let mappingIndexCache = null;
function compactName(value){return String(value||'').replace(/[^a-z0-9]/g,'');}
function isSubsequence(shorter,longer){let i=0;for(const ch of longer)if(ch===shorter[i])i++;return i===shorter.length;}
function disclosureBaseName(value){
  return String(value||'')
    .replace(/^\s*MONTHLY PORTFOLIO STATEMENT OF\s+/i,'')
    .replace(/\s+AS ON\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}[\s\S]*$/i,'')
    .replace(/^\s*[A-Z]{2,8}\d{2,5}\s*[-:]?\s*/i,'')
    .split(/\s*\((?:an?|a)\s+(?:open|close)[\s\S]*$/i)[0]
    .replace(/\s+Index\s*$/i,'').trim();
}
function mapPortfolioScheme(portfolioSchemeId, canonicalName, normalizedName) {
  if (!mappingIndexCache) {
    const exact = new Map();
    const official = holdingsDb.prepare('SELECT scheme_code, scheme_name FROM scheme_universe WHERE active=1').all();
    const candidates = [...official,...db.prepare('SELECT scheme_code, scheme_name FROM mf_scheme_index').all()];
    const seenCodes = new Set();
    for (const candidate of candidates) {
      if (seenCodes.has(candidate.scheme_code)) continue;
      seenCodes.add(candidate.scheme_code);
      const key = normalizeSchemeName(candidate.scheme_name);
      if (!exact.has(key)) exact.set(key, []);
      exact.get(key).push(candidate);
    }
    mappingIndexCache={exact,families:[...exact.keys()].map(key=>({key,compact:compactName(key)}))};
  }
  const baseNormalized=normalizeSchemeName(disclosureBaseName(canonicalName));
  let candidates = mappingIndexCache.exact.get(normalizedName) || mappingIndexCache.exact.get(baseNormalized) || [], method=baseNormalized!==normalizedName?'official-disclosure-title':'normalized-exact', confidence=1;
  if(!candidates.length && !/\s/.test(String(canonicalName||'').trim())){
    const compact=compactName(normalizedName);
    if(compact.length>=6){
      const possible=mappingIndexCache.families.map(f=>{
        const matches=(compact.length<=f.compact.length?isSubsequence(compact,f.compact):isSubsequence(f.compact,compact));
        return matches&&compact.slice(0,4)===f.compact.slice(0,4)?{...f,score:Math.min(compact.length,f.compact.length)/Math.max(compact.length,f.compact.length)}:null;
      }).filter(Boolean).sort((a,b)=>b.score-a.score||a.compact.length-b.compact.length);
      if(possible[0]&&possible[0].score>=.45&&(!possible[1]||possible[0].score-possible[1].score>=.03)){
        candidates=mappingIndexCache.exact.get(possible[0].key)||[];method='official-code-abbreviation';confidence=Number(possible[0].score.toFixed(3));
      }
    }
  }
  const insert = holdingsDb.prepare(`INSERT INTO scheme_map (scheme_code,scheme_name,portfolio_scheme_id,match_method,confidence)
    VALUES (?,?,?,?,?) ON CONFLICT(scheme_code) DO UPDATE SET scheme_name=excluded.scheme_name,portfolio_scheme_id=excluded.portfolio_scheme_id,
    match_method=excluded.match_method,confidence=excluded.confidence,mapped_at=datetime('now')`);
  let mapped = 0;
  for (const candidate of candidates) {
    insert.run(candidate.scheme_code, candidate.scheme_name, portfolioSchemeId, method, confidence);
    mapped++;
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
  const duplicate = holdingsDb.prepare('SELECT * FROM portfolio_imports WHERE source_sha256=?').get(sha);
  if (duplicate) {
    if (mfId != null) holdingsDb.prepare("UPDATE amc_sources SET last_success_at=datetime('now'),last_error=NULL WHERE mf_id=?").run(Number(mfId));
    return { duplicate: true, importId: duplicate.id, schemeCount: duplicate.scheme_count, holdingCount: duplicate.holding_count };
  }
  if (mfId != null && !holdingsDb.prepare('SELECT 1 FROM amc_sources WHERE mf_id=?').get(Number(mfId))) throw new Error('Unknown AMC source');
  const parsed = parseWorkbook(buffer, filename);
  const sourceDir = path.join(DATA_DIR, 'portfolio-sources', asOf.slice(0, 7));
  fs.mkdirSync(sourceDir, { recursive: true });
  const safeName = `${sha.slice(0, 12)}-${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const storedPath = path.join(sourceDir, safeName);
  const result = holdingsDb.transaction(() => {
    const imported = holdingsDb.prepare(`INSERT INTO portfolio_imports
      (mf_id,source_url,source_filename,source_sha256,disclosure_date,parser_version,status,scheme_count,holding_count,warning_json,stored_path)
      VALUES (?,?,?,?,?,?, 'valid',0,0,?,?)`).run(mfId == null ? null : Number(mfId), sourceUrl, filename, sha, asOf, PARSER_VERSION, JSON.stringify(parsed.warnings), storedPath);
    const importId = Number(imported.lastInsertRowid);
    const upsertScheme = holdingsDb.prepare(`INSERT INTO portfolio_schemes (mf_id,canonical_name,normalized_name) VALUES (?,?,?)
      ON CONFLICT(mf_id,normalized_name) DO UPDATE SET canonical_name=excluded.canonical_name RETURNING id`);
    const insertHolding = holdingsDb.prepare(`INSERT INTO holdings
      (portfolio_scheme_id,import_id,disclosure_date,row_number,instrument_name,isin,asset_type,sector,issuer,rating,maturity_date,quantity,market_value,pct_nav)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let holdings = 0, mapped = 0;
    for (const scheme of parsed.schemes) {
      const schemeId = upsertScheme.get(mfId == null ? null : Number(mfId), scheme.name, scheme.normalizedName).id;
      let rowOrdinal = 0;
      for (const h of scheme.holdings) {
        insertHolding.run(schemeId, importId, asOf, ++rowOrdinal, h.instrumentName, h.isin, h.assetType, h.sector, h.issuer || null, h.rating, h.maturityDate, h.quantity, h.marketValue, h.pctNav);
        holdings++;
      }
      mapped += mapPortfolioScheme(schemeId, scheme.name, scheme.normalizedName);
    }
    holdingsDb.prepare('UPDATE portfolio_imports SET scheme_count=?,holding_count=? WHERE id=?').run(parsed.schemes.length, holdings, importId);
    if (mfId != null) holdingsDb.prepare("UPDATE amc_sources SET last_success_at=datetime('now'),last_error=NULL WHERE mf_id=?").run(Number(mfId));
    return { importId, duplicate: false, schemeCount: parsed.schemes.length, holdingCount: holdings, mappedPlans: mapped, warnings: parsed.warnings };
  })();
  try { fs.writeFileSync(storedPath, buffer, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') console.warn('Could not retain source disclosure:', e.message); }
  return result;
}

function resolvePortfolioScheme(schemeCode) {
  const code = Number(schemeCode);
  if (!Number.isInteger(code) || code <= 0) return null;
  let row = holdingsDb.prepare(`SELECT ps.*,pm.scheme_name,pm.confidence,pm.match_method FROM scheme_map pm
    JOIN portfolio_schemes ps ON ps.id=pm.portfolio_scheme_id WHERE pm.scheme_code=?`).get(code);
  if (row) return row;
  const nav = db.prepare('SELECT scheme_name FROM mf_scheme_index WHERE scheme_code=?').get(code);
  if (!nav) return null;
  const normalized = normalizeSchemeName(nav.scheme_name);
  row = holdingsDb.prepare('SELECT *, ? AS scheme_name, 1 AS confidence, ? AS match_method FROM portfolio_schemes WHERE normalized_name=? ORDER BY id DESC LIMIT 1').get(nav.scheme_name, 'on-demand-exact', normalized);
  if (row) holdingsDb.prepare(`INSERT OR REPLACE INTO scheme_map (scheme_code,scheme_name,portfolio_scheme_id,match_method,confidence,mapped_at) VALUES (?,?,?,?,1,datetime('now'))`).run(code, nav.scheme_name, row.id, 'on-demand-exact');
  return row;
}

function getSchemeHoldings(schemeCode) {
  const scheme = resolvePortfolioScheme(schemeCode);
  if (!scheme) return null;
  const latest = holdingsDb.prepare(`SELECT disclosure_date,import_id FROM holdings WHERE portfolio_scheme_id=? ORDER BY disclosure_date DESC,import_id DESC LIMIT 1`).get(scheme.id);
  if (!latest) return null;
  const holdings = holdingsDb.prepare(`SELECT instrument_name AS instrumentName,isin,asset_type AS assetType,sector,rating,maturity_date AS maturityDate,
    quantity,market_value AS marketValue,pct_nav AS pctNav FROM holdings WHERE portfolio_scheme_id=? AND disclosure_date=? AND import_id=? ORDER BY COALESCE(pct_nav,0) DESC`).all(scheme.id, latest.disclosure_date, latest.import_id);
  const source = holdingsDb.prepare(`SELECT source_url AS sourceUrl,source_filename AS sourceFilename,imported_at AS importedAt,warning_json AS warningJson FROM portfolio_imports WHERE id=?`).get(latest.import_id);
  return { schemeCode:Number(schemeCode), schemeName:scheme.scheme_name, portfolioName:scheme.canonical_name, disclosureDate:latest.disclosure_date,
    confidence:scheme.confidence, matchMethod:scheme.match_method, holdings, source:{...source,warnings:JSON.parse(source.warningJson||'[]'),warningJson:undefined} };
}

function searchMappedSchemes(query, limit = 40) {
  const q = String(query || '').trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean).slice(0,6);
  const where = terms.map(() => '(u.scheme_name LIKE ? OR u.amc_name LIKE ? OR u.category LIKE ?)').join(' AND ');
  const bindings = terms.flatMap(term => [`%${term}%`,`%${term}%`,`%${term}%`]);
  const rows = holdingsDb.prepare(`SELECT u.scheme_code AS schemeCode,u.scheme_name AS schemeName,u.amc_name AS amcName,
    u.category,u.plan,u.option,u.nav,u.nav_date AS navDate,ps.canonical_name AS portfolioName,
    MAX(h.disclosure_date) AS disclosureDate,CASE WHEN COUNT(h.id)>0 THEN 1 ELSE 0 END AS hasHoldings
    FROM scheme_universe u LEFT JOIN scheme_map pm ON pm.scheme_code=u.scheme_code
    LEFT JOIN portfolio_schemes ps ON ps.id=pm.portfolio_scheme_id
    LEFT JOIN holdings h ON h.portfolio_scheme_id=ps.id
    WHERE u.active=1 AND ${where} GROUP BY u.scheme_code
    ORDER BY hasHoldings DESC,CASE WHEN u.scheme_name LIKE ? THEN 0 ELSE 1 END,LENGTH(u.scheme_name),u.scheme_name LIMIT ?`)
    .all(...bindings,`${q}%`,Math.min(100,Math.max(10,Number(limit)||40)));
  return rows.map(row => ({...row,hasHoldings:Boolean(row.hasHoldings),status:row.hasHoldings?'available':'awaiting_official_disclosure',
    planType:/direct/i.test(row.plan||row.schemeName)?'Direct':/regular/i.test(row.plan||row.schemeName)?'Regular':'Other'}));
}

function getSchemeRecord(schemeCode) {
  return holdingsDb.prepare(`SELECT scheme_code AS schemeCode,scheme_name AS schemeName,amc_name AS amcName,category,plan,option,
    nav,nav_date AS navDate,source_url AS sourceUrl FROM scheme_universe WHERE scheme_code=? AND active=1`).get(Number(schemeCode)) || null;
}

function listAmcs() {
  return holdingsDb.prepare(`SELECT u.amc_name AS amcName,COUNT(*) AS schemeVariants,
    COUNT(DISTINCT CASE WHEN h.id IS NOT NULL THEN u.scheme_code END) AS variantsWithHoldings
    FROM scheme_universe u LEFT JOIN scheme_map pm ON pm.scheme_code=u.scheme_code
    LEFT JOIN holdings h ON h.portfolio_scheme_id=pm.portfolio_scheme_id WHERE u.active=1
    GROUP BY u.amc_name ORDER BY u.amc_name`).all().map(row => ({...row,pendingVariants:row.schemeVariants-row.variantsWithHoldings}));
}

function portfolioOverlap(funds) {
  const selected = (Array.isArray(funds) ? funds : []).slice(0,12).map(fund => {
    const portfolio = getSchemeHoldings(fund.schemeCode);
    if (!portfolio) return null;
    const weights = new Map();
    for (const holding of portfolio.holdings) {
      const weight = Number(holding.pctNav);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      const key = holding.isin || `NAME:${String(holding.instrumentName).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}`;
      const existing = weights.get(key);
      if (!existing || weight > existing.weight) weights.set(key,{ key,instrumentName:holding.instrumentName,isin:holding.isin || null,sector:holding.sector || holding.assetType || null,weight });
    }
    return { schemeCode:Number(fund.schemeCode),schemeName:portfolio.schemeName,disclosureDate:portfolio.disclosureDate,weights };
  }).filter(Boolean);
  const pairs = [];
  for (let i=0;i<selected.length;i++) for (let j=i+1;j<selected.length;j++) {
    const left=selected[i],right=selected[j],shared=[];
    for (const [key,a] of left.weights) {
      const b=right.weights.get(key); if(!b) continue;
      shared.push({instrumentName:a.instrumentName,isin:a.isin,sector:a.sector,leftWeightPct:a.weight,rightWeightPct:b.weight,overlapWeightPct:Math.min(a.weight,b.weight)});
    }
    shared.sort((a,b)=>b.overlapWeightPct-a.overlapWeightPct);
    const overlapPct=Number(shared.reduce((sum,item)=>sum+item.overlapWeightPct,0).toFixed(2));
    pairs.push({leftSchemeCode:left.schemeCode,leftSchemeName:left.schemeName,rightSchemeCode:right.schemeCode,rightSchemeName:right.schemeName,
      overlapPct,sharedHoldings:shared.length,topShared:shared.slice(0,10),asOfDates:[left.disclosureDate,right.disclosureDate]});
  }
  pairs.sort((a,b)=>b.overlapPct-a.overlapPct);
  const average=pairs.length?Number((pairs.reduce((sum,pair)=>sum+pair.overlapPct,0)/pairs.length).toFixed(2)):0;
  const level = !pairs.length ? 'unavailable' : average >= 50 ? 'high' : average >= 25 ? 'moderate' : 'low';
  return {coveredFunds:selected.map(({weights,...fund})=>fund),missingFunds:(Array.isArray(funds)?funds:[]).filter(f=>!selected.some(s=>s.schemeCode===Number(f.schemeCode))).map(f=>Number(f.schemeCode)),
    pairCount:pairs.length,averageOverlapPct:average,highestOverlap:pairs[0]||null,level,pairs};
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
  const coveredValue=used.reduce((s,x)=>s+x.currentValue,0);
  const exposures=[...exposure.values()].map(x=>({...x,pctPortfolio:x.amount/totalValue*100})).sort((a,b)=>b.amount-a.amount);
  const sectors=new Map();
  exposures.forEach(item=>{const key=item.sector||item.assetType||'Unclassified';sectors.set(key,(sectors.get(key)||0)+item.amount);});
  const sectorAllocation=[...sectors].map(([name,amount])=>({name,amount,pctPortfolio:amount/totalValue*100})).sort((a,b)=>b.amount-a.amount);
  return { totalValue, coveredValue, coveragePct:coveredValue/totalValue*100, used, missing, exposures, sectorAllocation,
    concentration:{topHoldingPct:exposures[0]?.pctPortfolio||0,top5Pct:exposures.slice(0,5).reduce((sum,x)=>sum+x.pctPortfolio,0),largestSector:sectorAllocation[0]||null} };
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
  const timeoutMs = Math.max(5000, Number(process.env.PORTFOLIO_FETCH_TIMEOUT_MS || 15000));
  const res = await fetch(url, { redirect:'follow', signal:AbortSignal.timeout(timeoutMs), headers:{'User-Agent':'MF-Sarthi-Portfolio-Importer/1.0'} });
  if (!res.ok) throw new Error(`Source returned HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0); if (declared > MAX_BYTES) throw new Error('Source file is too large');
  const data = Buffer.from(await res.arrayBuffer()); if (data.length > MAX_BYTES) throw new Error('Source file is too large');
  return { buffer:data, contentType:res.headers.get('content-type')||'', finalUrl:res.url };
}

function discoverExcelLinks(html, pageUrl) {
  const found = new Set();
  html = String(html || '').replace(/\\\//g, '/').replace(/&quot;/g, '"');
  const re = /(?:href|data-url|data-href)\s*=\s*["']([^"']+)["']|https?:\/\/[^\s"'<>]+/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = (match[1] || match[0]).replace(/&amp;/g,'&');
    try { const u = new URL(raw, pageUrl); if (/\.(xlsx?|xlsm)(?:$|[?#])/i.test(u.href)) found.add(u.href); } catch (_) {}
  }
  return [...found];
}

function registrableHost(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  return parts.slice(-2).join('.');
}

function discoverDisclosurePages(html, pageUrl, targetDate) {
  const found = new Set();
  const base = new URL(pageUrl);
  const targetHost = registrableHost(base.hostname);
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(String(html || '')))) {
    const label = match[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    try {
      const url = new URL(match[1].replace(/&amp;/g, '&'), pageUrl);
      if (!/^https?:$/.test(url.protocol) || registrableHost(url.hostname) !== targetHost) continue;
      const clue = `${url.pathname} ${url.search} ${label}`.toLowerCase();
      if (/portfolio|disclosure|monthly|fortnight|scheme|download|excel/.test(clue) || linkScore(url.href,targetDate) > 2) found.add(url.href);
    } catch (_) {}
  }
  return [...found];
}

async function crawlDisclosureLinks(entryUrl, targetDate) {
  const queue = [entryUrl], visited = new Set(), excel = new Set();
  while (queue.length && visited.size < 12) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const page = await fetchBuffer(url);
    if (/\.(xlsx?|xlsm)(?:$|[?#])/i.test(page.finalUrl) || /spreadsheet|excel/i.test(page.contentType)) {
      excel.add(page.finalUrl);
      continue;
    }
    if (!/html|json|javascript|text\//i.test(page.contentType) && page.contentType) continue;
    const body = page.buffer.toString('utf8');
    discoverExcelLinks(body, page.finalUrl).forEach(link => excel.add(link));
    // Bandhan's WordPress disclosure posts attach the workbook through this public
    // download route instead of placing an .xlsx anchor in the article HTML.
    if (/cmsnew\.bandhanmutual\.com$/i.test(new URL(page.finalUrl).hostname)) {
      const postId = body.match(/\bpostid-(\d+)\b/i)?.[1];
      if (postId) queue.push(`https://cmsnew.bandhanmutual.com/wp-json/custom/v1/download_excel/${postId}`);
    }
    for (const next of discoverDisclosurePages(body, page.finalUrl, targetDate)) {
      if (!visited.has(next) && queue.length < 40) queue.push(next);
    }
  }
  return [...excel].sort((a,b)=>linkScore(b,targetDate)-linkScore(a,targetDate));
}

async function officialApiLinks(source, targetDate) {
  const date = new Date(`${targetDate}T00:00:00Z`);
  if (/nipponindiaim\.com/i.test(source.monthly_url || '')) {
    const month=date.toLocaleString('en-US',{month:'short',timeZone:'UTC'});
    return [`https://mf.nipponindiaim.com/InvestorServices/FactsheetsDocuments/NIMF-MONTHLY-PORTFOLIO-${String(date.getUTCDate()).padStart(2,'0')}-${month}-${String(date.getUTCFullYear()).slice(-2)}.xls`];
  }
  if (!/sbimf\.com/i.test(source.monthly_url || '')) return [];
  const response = await fetch('https://www.sbimf.com/ajaxcall/CMS/GetSchemePortfolioSheets', {
    method:'POST', signal:AbortSignal.timeout(20000),
    headers:{'content-type':'application/json;charset=utf-8','user-agent':'MF-Sarthi-Portfolio-Importer/1.0'},
    body:JSON.stringify({FundId:0,PSYear:String(date.getUTCFullYear()),PSMonth:date.toLocaleString('en-US',{month:'long',timeZone:'UTC'}),PSFrequency:'Monthly'})
  });
  if (!response.ok) throw new Error(`SBI official portfolio service returned HTTP ${response.status}`);
  const links = discoverExcelLinks(await response.text(), 'https://www.sbimf.com/portfolios');
  const consolidated = links.find(link => /all-schemes/i.test(link));
  return consolidated ? [consolidated] : links;
}

function linkScore(url, targetDate) {
  const month = new Date(`${targetDate}T00:00:00Z`).toLocaleString('en-US',{month:'long',timeZone:'UTC'}).toLowerCase();
  const short = month.slice(0,3), year = targetDate.slice(0,4), ym = targetDate.slice(0,7).replace('-',''), yy = targetDate.slice(2,7).replace('-','');
  const s = decodeURIComponent(url).toLowerCase();
  return (/portfolio/.test(s)?5:0) + (s.includes(month)?5:0) + (s.includes(short)?2:0) + (s.includes(year)?4:0) + (s.includes(ym)||s.includes(yy)?4:0);
}

function linkMatchesTargetMonth(url, targetDate) {
  const decoded = decodeURIComponent(String(url || '')).toLowerCase().replace(/[_.\/]+/g,'-');
  const [year,month,day] = targetDate.split('-');
  const monthName = new Date(`${targetDate}T00:00:00Z`).toLocaleString('en-US',{month:'long',timeZone:'UTC'}).toLowerCase();
  const short = monthName.slice(0,3);
  const compact = decoded.replace(/[^a-z0-9]/g,'');
  const hasYear = decoded.includes(year);
  const hasMonth = decoded.includes(monthName) || decoded.includes(short) || compact.includes(`${year}${month}`) ||
    compact.includes(`${day}${month}${year}`) || compact.includes(`${month}${day}${year}`);
  return hasYear && hasMonth;
}

async function refreshOneSource(source, targetDate) {
  holdingsDb.prepare("UPDATE amc_sources SET last_checked_at=datetime('now') WHERE mf_id=?").run(source.mf_id);
  if (!source.monthly_url) throw new Error('AMFI has not listed a monthly disclosure URL');
  const entryUrls = [source.monthly_url];
  if (/bandhanmutual\.com/i.test(source.monthly_url)) entryUrls.push('https://cmsnew.bandhanmutual.com/category/scheme-portfolios/');
  let discoveryError = null;
  let links = [];
  try { links.push(...await officialApiLinks(source,targetDate)); } catch (e) { discoveryError = e; }
  for (const entry of entryUrls) {
    try { links.push(...await crawlDisclosureLinks(entry,targetDate)); }
    catch (e) { discoveryError = e; }
  }
  links = [...new Set(links)].sort((a,b)=>linkScore(b,targetDate)-linkScore(a,targetDate));
  if (!links.length && discoveryError) throw discoveryError;
  if (!links.length) throw new Error('No Excel disclosure link was discoverable; upload the official file manually');
  links = links.filter(u => linkMatchesTargetMonth(u,targetDate)).slice(0,250);
  if (!links.length) throw new Error(`No disclosure file explicitly matched ${targetDate}; older files were ignored`);
  let imported = 0, lastError = null, nextLink = 0;
  async function importNext() {
    while (nextLink < links.length) {
      const link = links[nextLink++];
      try {
        const file = await fetchBuffer(link);
        let filename = path.basename(new URL(file.finalUrl).pathname) || 'portfolio.xlsx';
        if (!/\.(xlsx?|xlsm)$/i.test(filename)) filename += '.xlsx';
        const result = importPortfolioBuffer({ buffer:file.buffer, filename, mfId:source.mf_id, disclosureDate:targetDate, sourceUrl:file.finalUrl });
        if (!result.duplicate) imported++;
      } catch (e) { lastError = e; }
    }
  }
  const concurrency = Math.max(1, Math.min(8, Number(process.env.PORTFOLIO_DOWNLOAD_CONCURRENCY || 6)));
  await Promise.all(Array.from({ length:Math.min(concurrency,links.length) }, importNext));
  if (!imported && lastError) throw lastError;
  return imported;
}

async function refreshAllSources(targetDate = endOfPreviousMonth(), options = {}) {
  if (refreshState.running) return refreshState;
  Object.assign(refreshState,{running:true,startedAt:new Date().toISOString(),finishedAt:null,checked:0,imported:0,failed:0,message:'Refreshing official AMC disclosures'});
  try { await syncAmfiSchemeUniverse(); mappingIndexCache=null; } catch (e) { console.warn('AMFI scheme-list refresh failed; using the last saved universe:',e.message); }
  try { await syncAmfiRegistry(); } catch (e) { console.warn('AMFI registry refresh failed; using the last saved registry:',e.message); }
  let sources = holdingsDb.prepare('SELECT * FROM amc_sources WHERE enabled=1 ORDER BY mf_name').all();
  if (options.skipExisting) {
    const alreadyImported = holdingsDb.prepare('SELECT 1 FROM portfolio_imports WHERE mf_id=? AND disclosure_date=? LIMIT 1');
    sources = sources.filter(source => !alreadyImported.get(source.mf_id,targetDate));
  }
  for (let i=0; i<sources.length; i+=4) {
    const batch = sources.slice(i,i+4);
    await Promise.all(batch.map(async source => {
      refreshState.currentSource = source.mf_name;
      refreshState.message = `Checking official disclosures (${refreshState.checked} of ${sources.length} complete)`;
      try { const imported = await refreshOneSource(source,targetDate); refreshState.imported += imported; }
      catch (e) { refreshState.failed++; holdingsDb.prepare("UPDATE amc_sources SET last_error=? WHERE mf_id=?").run(String(e.message).slice(0,500),source.mf_id); }
      refreshState.checked++;
    }));
  }
  Object.assign(refreshState,{running:false,currentSource:null,finishedAt:new Date().toISOString(),message:`Checked ${refreshState.checked} AMCs; imported ${refreshState.imported} new file(s)`});
  return refreshState;
}

function coverageStatus() {
  const sources = holdingsDb.prepare(`SELECT s.mf_id AS mfId,s.mf_name AS mfName,s.monthly_url AS monthlyUrl,s.last_checked_at AS lastCheckedAt,
    s.last_success_at AS lastSuccessAt,s.last_error AS lastError,COUNT(DISTINCT ps.id) AS schemes,
    MAX(i.disclosure_date) AS latestDisclosureDate FROM amc_sources s LEFT JOIN portfolio_schemes ps ON ps.mf_id=s.mf_id
    LEFT JOIN portfolio_imports i ON i.mf_id=s.mf_id AND i.status='valid' GROUP BY s.mf_id ORDER BY s.mf_name`).all();
  const summary = holdingsDb.prepare(`SELECT
    (SELECT COUNT(DISTINCT amc_name) FROM scheme_universe WHERE active=1) AS officialAmcs,
    (SELECT COUNT(*) FROM scheme_universe WHERE active=1) AS officialSchemeVariants,
    COUNT(DISTINCT ps.id) AS portfolioSchemes,COUNT(DISTINCT pm.scheme_code) AS variantsWithHoldings,
    COUNT(DISTINCT h.id) AS holdings,MAX(h.disclosure_date) AS latestDisclosureDate FROM portfolio_schemes ps
    LEFT JOIN scheme_map pm ON pm.portfolio_scheme_id=ps.id LEFT JOIN holdings h ON h.portfolio_scheme_id=ps.id`).get();
  summary.mappedPlans=summary.variantsWithHoldings;
  summary.pendingVariants=Math.max(0,summary.officialSchemeVariants-summary.variantsWithHoldings);
  return { summary, sources, refresh:{...refreshState}, expectedDisclosureDate:endOfPreviousMonth() };
}

seedAmcSources();
module.exports = { importPortfolioBuffer, mapPortfolioScheme, getSchemeHoldings, getSchemeRecord, searchMappedSchemes, listAmcs, portfolioOverlap, lookThrough, refreshAllSources, refreshOneSource, coverageStatus, refreshState, endOfPreviousMonth, discoverExcelLinks, discoverDisclosurePages, crawlDisclosureLinks, linkMatchesTargetMonth, assertPublicUrl, isPrivateAddress, seedAmcSources, parseAmfiRegistryHtml, syncAmfiRegistry };

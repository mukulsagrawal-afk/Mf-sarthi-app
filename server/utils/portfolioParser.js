const XLSX = require('xlsx');

const PARSER_VERSION = '1.0.0';
const ISIN_RE = /^IN[A-Z0-9]{10}$/i;

function text(value) {
  if (value == null) return '';
  if (typeof value === 'object' && value.text) return String(value.text).trim();
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeSchemeName(value) {
  return text(value).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']s\b/g, 's')
    .replace(/\((?:erstwhile|formerly|ex\s*:)[^)]*\)/g, ' ')
    .replace(/\bfund\s+of\s+funds\b/g, ' fof ')
    .replace(/\bnil\b/g, ' ')
    .replace(/\b(direct|regular)\s*(plan)?\b/g, ' ')
    .replace(/\b(growth|gr|idcw|dividend)\b/g, ' ')
    .replace(/\b(payout|pay\s*out|reinvestment|reinvest|bonus)\b/g, ' ')
    .replace(/\b(option|plan)\b/g, ' ')
    .replace(/\bmutual\s+fund\b/g, ' fund ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function number(value) {
  if (value == null || value === '' || /^[-–—]$/.test(text(value))) return null;
  const negative = /^\(.*\)$/.test(text(value));
  const cleaned = text(value).replace(/[₹,%()\s]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

function headerKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}

function classifyHeader(value) {
  const h = headerKey(value);
  if (!h) return null;
  if (/\bisin\b/.test(h)) return 'isin';
  if (/%.*(nav|net assets)|(% of|percentage).*net assets|net assets.*%/.test(h)) return 'pctNav';
  if (/market value|fair value|value.*(lakh|crore|rs)|amount.*(lakh|crore)/.test(h)) return 'marketValue';
  if (/quantity|qty|shares|units/.test(h)) return 'quantity';
  if (/industry|sector/.test(h)) return 'sector';
  if (/credit rating|rating/.test(h)) return 'rating';
  if (/maturity|maturity date/.test(h)) return 'maturityDate';
  if (/asset class|asset type|instrument type|category of investment/.test(h)) return 'assetType';
  if (/name of (the )?(instrument|company|issuer|security)|instrument name|security name|particulars|issuer name/.test(h)) return 'instrumentName';
  return null;
}

function headerMap(row) {
  const map = {};
  row.forEach((v, i) => { const key = classifyHeader(v); if (key && map[key] == null) map[key] = i; });
  const score = Object.keys(map).length;
  return score >= 2 && map.instrumentName != null && (map.isin != null || map.pctNav != null || map.marketValue != null) ? map : null;
}

function likelySchemeName(rows, headerIndex, sheetName) {
  for (let r = headerIndex - 1; r >= Math.max(0, headerIndex - 18); r--) {
    const values = rows[r].map(text).filter(Boolean);
    if (!values.length) continue;
    let line = values.join(' ').replace(/^(name of (the )?scheme|scheme name|portfolio of)\s*[:\-]?\s*/i, '').trim();
    line = line.replace(/portfolio (statement )?(as|for the month ended).*$/i, '').trim();
    if (line.length >= 5 && line.length <= 180 && /\b(fund|etf|scheme|fof|index)\b/i.test(line) && !/mutual fund portfolio|portfolio disclosure|name of scheme/i.test(line)) return line;
  }
  if (!/^sheet\d*$/i.test(sheetName) && sheetName.length > 3) return sheetName;
  return '';
}

function parseWorkbook(buffer, filename = 'portfolio.xlsx') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: false });
  const schemes = [];
  const warnings = [];
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    for (let i = 0; i < rows.length; i++) {
      const map = headerMap(rows[i]);
      if (!map) continue;
      const schemeName = likelySchemeName(rows, i, sheetName);
      if (!schemeName) { warnings.push(`${sheetName}: could not identify the scheme above row ${i + 1}`); continue; }
      const holdings = [];
      let assetType = '';
      let blankRun = 0;
      for (let r = i + 1; r < rows.length; r++) {
        if (headerMap(rows[r])) break;
        const cells = rows[r].map(text);
        const populated = cells.filter(Boolean);
        if (!populated.length) { if (++blankRun >= 5 && holdings.length) break; continue; }
        blankRun = 0;
        const instrument = text(cells[map.instrumentName]);
        const isinCandidate = map.isin == null ? '' : text(cells[map.isin]).toUpperCase().replace(/\s/g, '');
        const pctNav = map.pctNav == null ? null : number(cells[map.pctNav]);
        const marketValue = map.marketValue == null ? null : number(cells[map.marketValue]);
        if (!instrument && !ISIN_RE.test(isinCandidate)) {
          if (populated.length <= 3 && /equity|debt|money market|government|cash|derivative|mutual fund|treps|repo/i.test(populated.join(' '))) assetType = populated.join(' ');
          continue;
        }
        if (/^(grand )?total|net assets|subtotal|scheme total/i.test(instrument)) continue;
        if (pctNav == null && marketValue == null && !ISIN_RE.test(isinCandidate)) {
          if (/equity|debt|money market|government|cash|derivative|mutual fund|treps|repo/i.test(instrument)) assetType = instrument;
          continue;
        }
        holdings.push({
          rowNumber: r + 1,
          instrumentName: instrument || isinCandidate,
          isin: ISIN_RE.test(isinCandidate) ? isinCandidate : null,
          assetType: map.assetType == null ? assetType || null : text(cells[map.assetType]) || assetType || null,
          sector: map.sector == null ? null : text(cells[map.sector]) || null,
          rating: map.rating == null ? null : text(cells[map.rating]) || null,
          maturityDate: map.maturityDate == null ? null : text(cells[map.maturityDate]) || null,
          quantity: map.quantity == null ? null : number(cells[map.quantity]),
          marketValue,
          pctNav,
        });
      }
      if (holdings.length) schemes.push({ name: schemeName, normalizedName: normalizeSchemeName(schemeName), holdings });
    }
  }
  const merged = new Map();
  for (const scheme of schemes) {
    const key = scheme.normalizedName || normalizeSchemeName(scheme.name);
    if (!merged.has(key)) merged.set(key, { ...scheme, normalizedName: key, holdings: [] });
    merged.get(key).holdings.push(...scheme.holdings);
  }
  if (!merged.size) throw new Error(`No scheme holding tables were found in ${filename}. Use the original AMC Excel disclosure and check its layout.`);
  return { schemes: [...merged.values()], warnings, parserVersion: PARSER_VERSION };
}

module.exports = { parseWorkbook, normalizeSchemeName, PARSER_VERSION, ISIN_RE };

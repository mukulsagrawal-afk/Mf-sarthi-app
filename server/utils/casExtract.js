// Best-effort extraction of mutual fund holdings from an uploaded CAS (Consolidated
// Account Statement - from CAMS, KFintech/KARVY, or NSDL/CDSL) PDF.
//
// Important honesty note, on purpose: CAS PDFs from different RTAs have different
// layouts, and some are password-protected (usually PAN + date of birth, per RTA
// convention). There is no way to parse every real-world CAS with 100% accuracy from
// text extraction alone. This module does a reasonable best-effort pass - find lines
// that look like a scheme holding, fuzzy-match them against the cached scheme index -
// and returns CANDIDATES with a confidence score, never a silently-trusted final answer.
// The frontend must show these to the user to confirm/edit before analysis runs.

const { PDFParse, PasswordException } = require('pdf-parse');
const db = require('../db');

// Fund houses commonly seen in CAS statements - used to spot the start of a holding line.
const AMC_NAMES = [
  'ICICI Prudential', 'HDFC', 'SBI', 'Axis', 'Nippon India', 'Kotak', 'Aditya Birla Sun Life',
  'UTI', 'DSP', 'Franklin Templeton', 'Mirae Asset', 'Parag Parikh', 'Tata', 'L&T', 'LIC',
  'Canara Robeco', 'PGIM India', 'Invesco India', 'Sundaram', 'IDFC', 'Bandhan', 'Edelweiss',
  'Motilal Oswal', 'Quant', 'WhiteOak Capital', 'Baroda BNP Paribas', 'JM Financial', 'Union',
  'ITI', 'Navi', 'Taurus', 'Groww', 'NJ', 'Shriram', 'Samco', 'Old Bridge', 'Helios', 'Trust',
];
const FUND_TYPE_HINTS = [
  'Large Cap', 'Mid Cap', 'Small Cap', 'Flexi Cap', 'Multi Cap', 'ELSS', 'Tax Saver', 'Hybrid',
  'Balanced', 'Focused', 'Value', 'Contra', 'Dividend Yield', 'Bluechip', 'Blue Chip', 'Equity',
  'Debt', 'Liquid', 'Index', 'Growth', 'Opportunities', 'Emerging',
];

const ISIN_RE = /\bIN[A-Z0-9]{10}\b/g;

async function extractCandidatesFromPdf(buffer, password) {
  const parser = new PDFParse({ data: buffer, password: password || undefined });
  let text;
  try {
    const result = await parser.getText();
    text = result.text || '';
  } catch (e) {
    if (e instanceof PasswordException || /password/i.test(e.message || '')) {
      throw new Error('This PDF is password-protected and the password you entered didn\'t open it (or none was given). CAS passwords are usually your PAN + date of birth - check your RTA\'s email for the exact format.');
    }
    throw new Error('Could not read this PDF. Make sure it\'s a text-based CAS (not a scanned image).');
  } finally {
    await parser.destroy().catch(() => {});
  }
  if (text.trim().length < 200) {
    throw new Error('This PDF has little to no extractable text - it may be a scanned/image-only statement, which this tool can\'t read yet.');
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const isins = new Set((text.match(ISIN_RE) || []));

  const candidateLines = [];
  for (const line of lines) {
    const hasAmc = AMC_NAMES.some((amc) => line.includes(amc));
    const hasHint = FUND_TYPE_HINTS.some((h) => line.toLowerCase().includes(h.toLowerCase()));
    if (hasAmc && hasHint && line.length < 160) candidateLines.push(line);
  }

  // De-dupe near-identical lines (CAS statements often repeat the scheme name in a
  // transaction table, once per row) by normalizing whitespace/case.
  const seen = new Set();
  const uniqueLines = candidateLines.filter((l) => {
    const key = l.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const indexed = db.prepare('SELECT COUNT(*) AS n FROM mf_scheme_index').get().n > 0;
  const results = uniqueLines.slice(0, 40).map((line) => ({
    rawLine: line,
    match: indexed ? bestMatch(line) : null,
  }));

  return { candidates: results, isinsFound: Array.from(isins), schemeIndexReady: indexed };
}

// Simple token-overlap fuzzy match against the cached scheme index - good enough for
// "which of these ~16000 names is this line probably referring to", not meant to be
// perfect. Direct Plan - Growth variants are preferred when multiple plans match equally,
// since that's what most self-directed / newer investments default to.
function bestMatch(line) {
  const cleanLine = line.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const lineTokens = new Set(cleanLine.split(' ').filter((t) => t.length > 2));
  if (!lineTokens.size) return null;

  // Narrow the SQL scan with a LIKE on the most distinctive token (usually the AMC name)
  // before scoring in JS - scanning all ~16k rows in JS per line would be needlessly slow.
  const amcToken = AMC_NAMES.find((amc) => line.includes(amc));
  const likeTerm = amcToken ? `%${amcToken.split(' ')[0]}%` : `%${[...lineTokens][0]}%`;
  const rows = db.prepare('SELECT scheme_code AS schemeCode, scheme_name AS schemeName FROM mf_scheme_index WHERE scheme_name LIKE ? LIMIT 500').all(likeTerm);

  let best = null, bestScore = 0;
  for (const row of rows) {
    const nameTokens = new Set(row.schemeName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 2));
    let overlap = 0;
    for (const t of lineTokens) if (nameTokens.has(t)) overlap++;
    let score = overlap / Math.max(lineTokens.size, nameTokens.size);
    if (/direct/i.test(row.schemeName) && /growth/i.test(row.schemeName)) score += 0.05; // slight preference, tie-breaker only
    if (score > bestScore) { bestScore = score; best = row; }
  }
  if (!best || bestScore < 0.5) return null;
  return { ...best, confidence: Math.round(bestScore * 100) };
}

module.exports = { extractCandidatesFromPdf };

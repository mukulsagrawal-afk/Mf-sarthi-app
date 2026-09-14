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
const { ensureSchemeIndex } = require('./mfapi');
const { bestMatches } = require('./casMatch');

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
  if (!buffer || buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('Upload a valid PDF account statement.');
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

  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const isins = new Set((text.match(ISIN_RE) || []));

  const candidateLines = [];
  for (const line of lines) {
    const hasAmc = AMC_NAMES.some(amc => line.toLowerCase().includes(amc.toLowerCase()));
    const hasHint = /\b(fund|scheme|equity|hybrid|liquid|elss|index|cap|bluechip|opportunities)\b/i.test(line);
    if (hasHint && (hasAmc || /\b(?:mutual fund|fund)\b/i.test(line)) && line.length >= 12 && line.length < 230 && !/^(?:transaction|opening|closing|total|folio|statement|purchase|redemption|dividend|sip\b)/i.test(line)) candidateLines.push(line);
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

  try { await ensureSchemeIndex(); } catch (_) { /* allow cached index if provider is unavailable */ }
  const indexed = db.prepare('SELECT COUNT(*) AS n FROM mf_scheme_index').get().n > 0;
  const schemeRows = indexed ? db.prepare('SELECT scheme_code AS schemeCode, scheme_name AS schemeName FROM mf_scheme_index').all() : [];
  const matchedLines = uniqueLines.slice(0, 200).map(line => {
    const matches = bestMatches(line, schemeRows, AMC_NAMES);
    const top = matches[0];
    const unambiguous = top && top.confidence >= 82 && (!matches[1] || top.confidence - matches[1].confidence >= 7);
    return { rawLine: line, match: unambiguous ? top : null, suggestions: matches, needsConfirmation: true };
  }).filter(r => r.match || r.suggestions.length);
  const seenSchemes = new Set();
  const results = matchedLines.filter(r => {
    const key = r.match?.schemeCode || r.suggestions[0]?.schemeCode;
    if (seenSchemes.has(key)) return false;
    seenSchemes.add(key); return true;
  });
  return { candidates: results, isinsFound: Array.from(isins), schemeIndexReady: indexed,
    warnings: [!indexed ? 'Scheme directory is unavailable. Search and confirm each holding manually.' : null,
      !results.length ? 'No holdings could be identified from this text. Search and add them manually.' : null,
      'Confirm each scheme, plan, option and current value against the statement before generating a report. ISINs are shown for reference; a name-only match is not ISIN verification.'].filter(Boolean) };
}

module.exports = { extractCandidatesFromPdf };

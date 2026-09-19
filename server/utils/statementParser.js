// Parses an uploaded monthly CAS / commission statement (CSV or Excel export from
// CAMS, KFintech, or a broker back-office) into plain rows: { name, mobile, pan, aum, sip }.
//
// This deliberately does NOT try to parse the official password-protected CAS PDF -
// that format is inconsistent across RTAs and needs its own project. Advisors can
// export their statement to Excel/CSV from the CAMS/KFintech portal (a standard
// option) and upload that instead - this covers the "get real numbers in" need
// without waiting on a live API integration.

const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');

const HEADER_ALIASES = {
  name: ['name', 'client name', 'investor name', 'client', 'unit holder name'],
  mobile: ['mobile', 'phone', 'mobile number', 'contact', 'contact number'],
  pan: ['pan', 'pan number', 'pan no'],
  aum: ['aum', 'current value', 'valuation', 'portfolio value', 'value', 'market value', 'current valuation'],
  sip: ['sip', 'sip amount', 'monthly sip', 'sip installment', 'installment amount'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildColumnMap(headerRow) {
  const map = {}; // field -> column index
  headerRow.forEach((raw, idx) => {
    const h = normalizeHeader(raw);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(h) && map[field] === undefined) map[field] = idx;
    }
  });
  return map;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function rowsFromMatrix(matrix) {
  if (!matrix.length) return { rows: [], unmapped: [] };
  const map = buildColumnMap(matrix[0]);
  const missing = ['name'].filter((f) => map[f] === undefined);
  if (missing.length) {
    throw new Error(
      `Could not find a "${missing[0]}" column in the file. Expected headers like: Name, Mobile, PAN, AUM, SIP Amount.`
    );
  }
  const rows = [];
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i];
    if (!r || r.every((c) => c === null || c === undefined || c === '')) continue;
    const name = r[map.name] ? String(r[map.name]).trim() : '';
    if (!name) continue;
    rows.push({
      name,
      mobile: map.mobile !== undefined ? String(r[map.mobile] ?? '').trim() || null : null,
      pan: map.pan !== undefined ? String(r[map.pan] ?? '').trim().toUpperCase() || null : null,
      aum: map.aum !== undefined ? toNumber(r[map.aum]) : null,
      sip: map.sip !== undefined ? toNumber(r[map.sip]) : null,
    });
  }
  return { rows };
}

async function parseStatementFile(buffer, originalName) {
  const lower = originalName.toLowerCase();
  if (lower.endsWith('.csv')) {
    const records = parse(buffer, { skip_empty_lines: true, relax_column_count: true });
    return rowsFromMatrix(records);
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    const workbook = XLSX.read(buffer, { type:'buffer', cellDates:true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header:1, raw:false, defval:'' });
    return rowsFromMatrix(matrix);
  }
  throw new Error('Unsupported file type - please upload a .csv or .xlsx export from your RTA/back-office portal.');
}

module.exports = { parseStatementFile };

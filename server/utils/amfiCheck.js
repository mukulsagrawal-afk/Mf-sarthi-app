// Best-effort comparison of a selected fund's latest MFapi NAV with AMFI's daily file.
// This detects mismatches or provider lag; historical calculations still use MFapi.
const { toDate } = require('./metrics');
const URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
let cache = null, expires = 0, inflight = null;
function parseAmfiDate(s) {
  const m = String(s).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m || MONTHS[m[2].toLowerCase()] === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]))).toISOString().slice(0, 10);
}
async function dailyIndex() {
  if (cache && Date.now() < expires) return cache;
  if (!inflight) inflight = (async () => {
    const response = await fetch(URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`AMFI daily file returned ${response.status}`);
    const rows = new Map();
    for (const line of (await response.text()).split(/\r?\n/)) {
      const fields = line.trim().split(';');
      const code = Number(fields[0]), nav = Number(fields.at(-2)), date = parseAmfiDate(fields.at(-1));
      if (Number.isInteger(code) && code > 0 && Number.isFinite(nav) && nav > 0 && date) rows.set(code, { date, nav });
    }
    if (rows.size < 1000) throw new Error('AMFI daily file could not be parsed');
    cache = rows; expires = Date.now() + 12 * 60 * 60 * 1000;
    return rows;
  })().finally(() => { inflight = null; });
  return inflight;
}
async function checkLatestNav(schemeCode, navDate, nav) {
  try {
    const official = (await dailyIndex()).get(Number(schemeCode));
    if (!official) return { status: 'unavailable', source: 'AMFI daily NAV file', reason: 'Scheme not in current AMFI file' };
    const comparisonDate = toDate(navDate).toISOString().slice(0, 10);
    if (official.date > comparisonDate) return { status: 'provider_lag', source: 'AMFI daily NAV file', officialDate: official.date, officialNav: official.nav };
    if (official.date < comparisonDate) return { status: 'official_older', source: 'AMFI daily NAV file', officialDate: official.date, officialNav: official.nav };
    const difference = Math.abs(Number(nav) - official.nav);
    return { status: difference <= Math.max(0.001, official.nav * 0.0001) ? 'matched' : 'mismatch', source: 'AMFI daily NAV file', officialDate: official.date, officialNav: official.nav };
  } catch (e) { return { status: 'unavailable', source: 'AMFI daily NAV file', reason: e.message }; }
}
module.exports = { checkLatestNav };

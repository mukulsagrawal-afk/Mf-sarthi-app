const holdingsDb = require('../holdings-db');

const AMFI_NAV_ALL_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';

function isoDate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const months = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  const month = months[match[2].toLowerCase()];
  return month ? `${match[3]}-${month}-${match[1].padStart(2,'0')}` : null;
}

function parseNavAll(text) {
  const records = [];
  let category = '', amcName = '';
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(Open Ended|Close Ended|Interval Fund) Schemes?/i.test(line)) {
      category = line;
      amcName = '';
      continue;
    }
    const parts = line.split(';').map(x => x.trim());
    if (/^\d+$/.test(parts[0] || '') && parts.length >= 8) {
      if (!amcName || !category) continue;
      records.push({
        schemeCode:Number(parts[0]), isinPrimary:parts[1] && parts[1] !== '-' ? parts[1] : null,
        isinReinvestment:parts[2] && parts[2] !== '-' ? parts[2] : null,
        schemeName:parts[3], plan:parts[4] || null, option:parts[5] || null,
        nav:Number.isFinite(Number(parts[6])) ? Number(parts[6]) : null, navDate:isoDate(parts[7]),
        amcName, category
      });
      continue;
    }
    if (!line.includes(';') && !/^Scheme Code/i.test(line)) amcName = line;
  }
  return records;
}

function saveSchemeUniverse(records, sourceUrl = AMFI_NAV_ALL_URL) {
  if (!Array.isArray(records) || records.length < 1000) throw new Error('AMFI returned an unexpectedly short scheme list');
  const upsert = holdingsDb.prepare(`INSERT INTO scheme_universe
    (scheme_code,amc_name,category,scheme_name,plan,option,isin_primary,isin_reinvestment,nav,nav_date,active,source_url,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,datetime('now')) ON CONFLICT(scheme_code) DO UPDATE SET
    amc_name=excluded.amc_name,category=excluded.category,scheme_name=excluded.scheme_name,plan=excluded.plan,
    option=excluded.option,isin_primary=excluded.isin_primary,isin_reinvestment=excluded.isin_reinvestment,
    nav=excluded.nav,nav_date=excluded.nav_date,active=1,source_url=excluded.source_url,synced_at=datetime('now')`);
  holdingsDb.transaction(() => {
    holdingsDb.prepare('UPDATE scheme_universe SET active=0').run();
    records.forEach(row => upsert.run(row.schemeCode,row.amcName,row.category,row.schemeName,row.plan,row.option,
      row.isinPrimary,row.isinReinvestment,row.nav,row.navDate,sourceUrl));
    holdingsDb.prepare(`INSERT INTO metadata(key,value,updated_at) VALUES ('scheme_universe_source',?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`).run(sourceUrl);
    holdingsDb.prepare(`INSERT INTO metadata(key,value,updated_at) VALUES ('scheme_universe_count',?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`).run(String(records.length));
  })();
  return records.length;
}

async function syncAmfiSchemeUniverse() {
  const response = await fetch(AMFI_NAV_ALL_URL, { signal:AbortSignal.timeout(20000), headers:{'User-Agent':'MF-Sarthi-AMFI-Scheme-Sync/1.0'} });
  if (!response.ok) throw new Error(`AMFI NAV master returned HTTP ${response.status}`);
  return saveSchemeUniverse(parseNavAll(await response.text()), AMFI_NAV_ALL_URL);
}

module.exports = { AMFI_NAV_ALL_URL, isoDate, parseNavAll, saveSchemeUniverse, syncAmfiSchemeUniverse };

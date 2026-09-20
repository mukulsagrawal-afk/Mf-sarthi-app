// Thin client for api.mfapi.in - a free, community-run API that mirrors AMFI's daily
// NAV data for 10,000+ Indian mutual fund schemes. No API key required.
//
// Everything here caches through the database (mf_nav_cache / mf_scheme_index) rather
// than hitting the live API on every request: MFAPI has no uptime/rate-limit guarantee,
// and NAV history only changes once a day (schemes are valued end-of-day), so re-fetching
// it for every dashboard view would be both slow and unnecessarily hard on a free service.

const db = require('../db');
const { toDate } = require('./metrics');

const BASE = 'https://api.mfapi.in';
const NAV_TTL_MS = 24 * 60 * 60 * 1000;        // re-fetch a scheme's NAV history once a day
const SCHEME_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh the full scheme list weekly

async function fetchJson(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`MFAPI request failed (${res.status}) for ${path}`);
  return res.json();
}

// A scheme code is always a small positive integer per MFAPI's own scheme list - reject
// anything else here, before it can be string-concatenated into an outbound request path
// or used as a cache key. This is the single choke point every caller goes through.
function assertValidSchemeCode(schemeCode) {
  const n = Number(schemeCode);
  if (!Number.isInteger(n) || n <= 0 || String(schemeCode).trim() !== String(n)) {
    throw new Error(`Invalid scheme code: ${schemeCode}`);
  }
  return n;
}

// ---- Per-scheme NAV history, cached ----
function getCachedNav(schemeCode) {
  return db.prepare('SELECT * FROM mf_nav_cache WHERE scheme_code = ?').get(schemeCode);
}

async function getSchemeData(schemeCodeRaw, { forceRefresh = false } = {}) {
  const schemeCode = assertValidSchemeCode(schemeCodeRaw);
  const cached = getCachedNav(schemeCode);
  const isStale = !cached || (Date.now() - new Date(cached.fetched_at + 'Z').getTime()) > NAV_TTL_MS;

  if (cached && !isStale && !forceRefresh) {
    return {
      meta: {
        scheme_code: cached.scheme_code,
        scheme_name: cached.scheme_name,
        fund_house: cached.fund_house,
        scheme_category: cached.scheme_category,
        isin_growth: cached.isin_growth,
      },
      data: JSON.parse(cached.nav_json),
      fromCache: true,
    };
  }

  try {
    const live = await fetchJson(`/mf/${schemeCode}`);
    if (!live || !live.meta || !Array.isArray(live.data) || Number(live.meta.scheme_code) !== schemeCode) throw new Error('Unexpected MFAPI response or scheme code mismatch');
    // Sort and deduplicate by parsed date. The API order is not part of the calculation.
    const byDate = new Map();
    for (const row of live.data) {
      const date = toDate(row.date), nav = Number(row.nav);
      if (Number.isFinite(date.getTime()) && Number.isFinite(nav) && nav > 0) byDate.set(date.toISOString().slice(0, 10), nav);
    }
    const navAsc = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, nav]) => ({ date, nav }));
    if (!navAsc.length) throw new Error('MFAPI returned no valid NAV observations');
    db.prepare(`
      INSERT INTO mf_nav_cache (scheme_code, scheme_name, fund_house, scheme_category, isin_growth, nav_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(scheme_code) DO UPDATE SET
        scheme_name=excluded.scheme_name, fund_house=excluded.fund_house,
        scheme_category=excluded.scheme_category, isin_growth=excluded.isin_growth,
        nav_json=excluded.nav_json, fetched_at=excluded.fetched_at
    `).run(
      schemeCode, live.meta.scheme_name, live.meta.fund_house, live.meta.scheme_category,
      live.meta.isin_growth || null, JSON.stringify(navAsc)
    );
    return { meta: live.meta, data: navAsc, fromCache: false };
  } catch (err) {
    // MFAPI is down/unreachable - fall back to a stale cache rather than fail outright,
    // since slightly-old NAV data is far more useful to an MFD than an error screen.
    if (cached) {
      return {
        meta: {
          scheme_code: cached.scheme_code, scheme_name: cached.scheme_name,
          fund_house: cached.fund_house, scheme_category: cached.scheme_category,
          isin_growth: cached.isin_growth,
        },
      data: JSON.parse(cached.nav_json),
        fromCache: true,
        stale: true,
      };
    }
    throw err;
  }
}

// ---- Full scheme list (code + name only), cached - backs search + CAS auto-match ----
function schemeIndexAge() {
  const row = db.prepare('SELECT fetched_at FROM mf_scheme_index_meta WHERE id = 1').get();
  return row ? Date.now() - new Date(row.fetched_at + 'Z').getTime() : Infinity;
}

async function ensureSchemeIndex() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM mf_scheme_index').get().n;
  if (count > 0 && schemeIndexAge() < SCHEME_INDEX_TTL_MS) return;

  const list = await fetchJson('/mf');
  if (!Array.isArray(list) || !list.length) return; // don't wipe a good cache on a bad response

  const insert = db.prepare('INSERT INTO mf_scheme_index (scheme_code, scheme_name) VALUES (?, ?) ON CONFLICT(scheme_code) DO UPDATE SET scheme_name=excluded.scheme_name');
  const tx = db.transaction((rows) => { for (const r of rows) insert.run(r.schemeCode, r.schemeName); });
  tx(list);
  db.prepare(`
    INSERT INTO mf_scheme_index_meta (id, fetched_at) VALUES (1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET fetched_at=excluded.fetched_at
  `).run();
}

// Local search against the cached index - falls back to MFAPI's own search endpoint
// (and lazily seeds the local index from it) if the local index hasn't been built yet.
//
// Ranked by match quality, not just insertion order: a bare 15-row cap with no ordering
// meant a common query like "HDFC" or "ICICI Prudential" - which can match hundreds of
// scheme variants (Direct/Regular, Growth/IDCW, multiple sub-categories) - would silently
// drop the exact scheme an MFD was looking for if it didn't happen to be among the first
// few rows SQLite returned. Ordering by (starts-with > word-boundary match > contains),
// then by name length, surfaces the most likely intended match first and raises the cap
// so a specific-enough query has room to actually include the right scheme.
async function searchSchemes(query, limit = 25) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const localCount = db.prepare('SELECT COUNT(*) AS n FROM mf_scheme_index').get().n;
  if (localCount > 0) {
    const startsWith = `${q}%`;
    const wordBoundary = `% ${q}%`;
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
    const tokenWhere = terms.map(() => 'scheme_name LIKE ?').join(' AND ');
    const candidateLimit = Math.min(Math.max(limit * 6, 120), 600);
    const localResults = db.prepare(`
      SELECT scheme_code AS schemeCode, scheme_name AS schemeName FROM mf_scheme_index
      WHERE ${tokenWhere}
      ORDER BY
        CASE
          WHEN scheme_name LIKE ? THEN 0
          WHEN scheme_name LIKE ? THEN 1
          ELSE 2
        END,
        LENGTH(scheme_name) ASC,
        scheme_name ASC
      LIMIT ?
    `).all(...terms.map(t => `%${t}%`), startsWith, wordBoundary, candidateLimit);

    // The local index only refreshes on a schedule (daily, see index.js), so a scheme
    // that was newly listed on MFAPI since the last refresh won't be in it yet. Rather
    // than make an MFD wait for tomorrow's refresh, fall through to MFAPI's own live
    // search whenever the local index comes back empty for a query - this is the exact
    // gap that hid a real fund (a newer AMC's scheme) from search before this fix.
    if (localResults.length) return balancePlanVariants(localResults, limit);
    try {
      const live = await fetchJson(`/mf/search?q=${encodeURIComponent(q)}`);
      return balancePlanVariants(live || [], limit);
    } catch (e) {
      return []; // MFAPI unreachable and nothing local either - genuinely nothing to show
    }
  }

  // No local index yet (first run) - use MFAPI's own search so the feature works
  // immediately, and kick off building the full local index in the background.
  ensureSchemeIndex().catch(() => {});
  return fetchJson(`/mf/search?q=${encodeURIComponent(q)}`).then((rows) => balancePlanVariants(rows || [], limit));
}

function planType(name) {
  if (/\bdirect\b/i.test(name || '')) return 'Direct';
  if (/\bregular\b/i.test(name || '')) return 'Regular';
  return 'Other';
}

// Keep both distributor (Regular) and Direct variants visible. MFAPI's catalogue often
// groups every Direct option first, which made a 25-row result look Direct-only even
// when matching Regular plans existed further down the same result set.
function balancePlanVariants(rows, limit) {
  const buckets = { Direct:[], Regular:[], Other:[] };
  const seen = new Set();
  for (const row of rows) {
    const schemeCode = Number(row.schemeCode ?? row.scheme_code);
    const schemeName = String(row.schemeName ?? row.scheme_name ?? '');
    if (!schemeCode || !schemeName || seen.has(schemeCode)) continue;
    seen.add(schemeCode);
    const type = planType(schemeName);
    buckets[type].push({ schemeCode, schemeName, planType:type });
  }
  const result = [];
  while (result.length < limit && (buckets.Regular.length || buckets.Direct.length || buckets.Other.length)) {
    // Regular comes first for an MFD workspace, followed immediately by its Direct peer.
    for (const type of ['Regular','Direct','Other']) {
      if (buckets[type].length && result.length < limit) result.push(buckets[type].shift());
    }
  }
  return result;
}

module.exports = { getSchemeData, searchSchemes, ensureSchemeIndex, balancePlanVariants, planType };

// Thin client for api.mfapi.in - a free, community-run API that mirrors AMFI's daily
// NAV data for 10,000+ Indian mutual fund schemes. No API key required.
//
// Everything here caches through the database (mf_nav_cache / mf_scheme_index) rather
// than hitting the live API on every request: MFAPI has no uptime/rate-limit guarantee,
// and NAV history only changes once a day (schemes are valued end-of-day), so re-fetching
// it for every dashboard view would be both slow and unnecessarily hard on a free service.

const db = require('../db');

const BASE = 'https://api.mfapi.in';
const NAV_TTL_MS = 24 * 60 * 60 * 1000;        // re-fetch a scheme's NAV history once a day
const SCHEME_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh the full scheme list weekly

async function fetchJson(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
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
    if (!live || !live.meta || !Array.isArray(live.data)) throw new Error('Unexpected MFAPI response shape');
    // MFAPI returns newest-first; store oldest-first, which every metrics calc below expects.
    const navAsc = live.data
      .map((d) => ({ date: d.date, nav: parseFloat(d.nav) }))
      .filter((d) => isFinite(d.nav))
      .reverse();
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
    const like = `%${q}%`;
    const startsWith = `${q}%`;
    const wordBoundary = `% ${q}%`;
    return db.prepare(`
      SELECT scheme_code AS schemeCode, scheme_name AS schemeName FROM mf_scheme_index
      WHERE scheme_name LIKE ?
      ORDER BY
        CASE
          WHEN scheme_name LIKE ? THEN 0
          WHEN scheme_name LIKE ? THEN 1
          ELSE 2
        END,
        LENGTH(scheme_name) ASC,
        scheme_name ASC
      LIMIT ?
    `).all(like, startsWith, wordBoundary, limit);
  }

  // No local index yet (first run) - use MFAPI's own search so the feature works
  // immediately, and kick off building the full local index in the background.
  ensureSchemeIndex().catch(() => {});
  return fetchJson(`/mf/search?q=${encodeURIComponent(q)}`).then((rows) => (rows || []).slice(0, limit));
}

module.exports = { getSchemeData, searchSchemes, ensureSchemeIndex };

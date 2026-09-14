// FolioXpert AI report engine - the orchestrator behind the six-section client report.
// This module computes NUMBERS ONLY (metrics, comparisons, classifications, warnings).
// The narrative sentences shown to the client are composed on the frontend from this
// data, so the exact wording stays in one place and easy to review for tone.
//
// Hard rule followed throughout: never invent a figure. Anywhere a real input is missing
// (no benchmark history yet, no invested-amount for a tax estimate, an unclassifiable
// category), the corresponding field comes back null and a plain-language entry is added
// to `warnings` explaining what is missing and why. The frontend must surface these, not
// silently drop them.

const { getSchemeData } = require('./mfapi');
const { computeMetrics, toDate } = require('./metrics');
const peerMap = require('./peerMap');
const benchmarkMap = require('./benchmarkMap');
const { checkLatestNav } = require('./amfiCheck');

function round2(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 100) / 100; }
function round0(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n); }

// Very rough equity/debt/hybrid classification from MFAPI's own category text. This is a
// classification of the SCHEME's category, not of its actual underlying holdings (MFAPI
// does not expose portfolio-level holdings data) - hybrid funds are flagged as an estimate
// because their real equity/debt split varies fund to fund and isn't in this data source.
function classifyAssetClass(rawCategory) {
  const c = String(rawCategory || '').toLowerCase();
  if (!c) return { assetClass: 'Unclassified', estimatedEquityPct: null };
  if (/hybrid|balanced|asset alloc|multi.?asset/.test(c)) return { assetClass: 'Hybrid', estimatedEquityPct: 50 };
  if (/debt|liquid|gilt|money market|overnight|ultra short|low duration|short duration|corporate bond|banking (and|&) psu|credit risk|floater|dynamic bond|ppfas.*debt/.test(c)) {
    return { assetClass: 'Debt', estimatedEquityPct: 0 };
  }
  if (/equity|elss|large cap|mid cap|small cap|flexi cap|multi cap|focused|value|contra|dividend yield|sectoral|thematic|index|etf/.test(c)) {
    return { assetClass: 'Equity', estimatedEquityPct: 100 };
  }
  return { assetClass: 'Unclassified', estimatedEquityPct: null };
}

const metricCache = new Map();
let activeFetches = 0;
const fetchQueue = [];
async function limitedFetch(task) {
  if (activeFetches >= 8) await new Promise(resolve => fetchQueue.push(resolve));
  activeFetches++;
  try { return await task(); }
  finally { activeFetches--; fetchQueue.shift()?.(); }
}
function fetchWithMetrics(schemeCode) {
  const code = Number(schemeCode), cached = metricCache.get(code);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = limitedFetch(async () => {
    const { meta, data, fromCache, stale } = await getSchemeData(code);
    return { schemeCode: code, meta, metrics: computeMetrics(data), dataFreshness: stale ? 'stale_fallback' : fromCache ? 'cached' : 'live' };
  });
  metricCache.set(code, { promise, expires: Date.now() + 5 * 60 * 1000 });
  promise.catch(() => metricCache.delete(code));
  if (metricCache.size > 250) metricCache.delete(metricCache.keys().next().value);
  return promise;
}

// Percentage-point lag/lead of `metrics` versus a comparator return figure, only when both
// sides have a real, sufficiently-long (isAnnualized) figure to compare - otherwise null,
// never a comparison across mismatched windows.
function ppDiff(ownReturn, otherCagrPct) {
  if (!ownReturn || !ownReturn.isAnnualized || otherCagrPct === null || otherCagrPct === undefined) return null;
  return round2(ownReturn.cagrPct - otherCagrPct);
}

async function buildFundMirror(holding, warnings) {
  const { schemeCode, currentValue } = holding;
  const fetched = await fetchWithMetrics(schemeCode);
  const { meta, metrics } = fetched;
  const category = peerMap.normalizeCategory(meta.scheme_category);
  const officialCheck = metrics.asOfDate ? checkLatestNav(schemeCode, metrics.asOfDate, metrics.latestNav) : Promise.resolve({ status: 'unavailable', source: 'AMFI daily NAV file' });
  if (fetched.dataFreshness === 'stale_fallback') warnings.push(`${meta.scheme_name}: NAV provider was unavailable; cached data was used. Check the NAV as-of date before sharing this report.`);
  if (metrics.asOfDate && Date.now() - toDate(metrics.asOfDate).getTime() > 7 * 86400000) warnings.push(`${meta.scheme_name}: latest NAV is more than 7 days old (${metrics.asOfDate}). Refresh before relying on the comparison.`);

  if (metrics.insufficientHistory) {
    warnings.push(`${meta.scheme_name}: only ${metrics.dataPoints} NAV data points available - too little history for reliable return/risk metrics. Shown with holdings data only.`);
  }

  // Same-category, same-plan peers. Discard codes whose live metadata changed.
  let peerComparison = null;
  if (category) {
    const peers = peerMap[category].filter((p) => p.schemeCode !== Number(schemeCode));
    const peerResults = await Promise.all(peers.map(async (p) => {
      try { return await fetchWithMetrics(p.schemeCode); } catch (e) { return null; }
    }));
    const selectedDate = metrics.asOfDate ? toDate(metrics.asOfDate).getTime() : NaN;
    const validPeers = peerResults.filter(p => p && peerMap.isComparable(p.meta, category) && Number.isFinite(selectedDate) && p.metrics.asOfDate && Math.abs(toDate(p.metrics.asOfDate).getTime() - selectedDate) <= 7 * 86400000);
    if (validPeers.length < peers.length) warnings.push(`${meta.scheme_name}: ${peers.length - validPeers.length} curated peers were unavailable, reclassified, or had NAV dates more than 7 days apart; they were excluded.`);
    if (validPeers.length) {
      const returns1Y = validPeers.filter((p) => p.metrics.return1Y).map((p) => p.metrics.return1Y.cagrPct);
      const returns3Y = validPeers.filter((p) => p.metrics.return3Y && p.metrics.return3Y.isAnnualized).map((p) => p.metrics.return3Y.cagrPct);
      const sharpes = validPeers.filter((p) => Number.isFinite(p.metrics.sharpe1Y)).map((p) => p.metrics.sharpe1Y);
      const rolling1 = validPeers.map(p => p.metrics.rolling1Y?.avgPct).filter(Number.isFinite);
      const rolling3 = validPeers.map(p => p.metrics.rolling3Y?.avgPct).filter(Number.isFinite);
      const mean = values => values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null;
      const categoryAvg1Y = returns1Y.length ? round2(returns1Y.reduce((a, b) => a + b, 0) / returns1Y.length) : null;
      const categoryAvg3Y = returns3Y.length ? round2(returns3Y.reduce((a, b) => a + b, 0) / returns3Y.length) : null;
      const categoryAvgSharpe1Y = sharpes.length ? round2(sharpes.reduce((a, b) => a + b, 0) / sharpes.length) : null;
      const categoryAvgRolling1Y = mean(rolling1), categoryAvgRolling3Y = mean(rolling3);
      const ranked = [{ schemeCode: Number(schemeCode), return1Y: metrics.rolling1Y?.avgPct ?? null }, ...validPeers.map((p) => ({ schemeCode: p.schemeCode, return1Y: p.metrics.rolling1Y?.avgPct ?? null }))]
        .filter((r) => r.return1Y !== null).sort((a, b) => b.return1Y - a.return1Y);
      const rank = ranked.findIndex((r) => r.schemeCode === Number(schemeCode)) + 1;
      if (validPeers.length < 2) warnings.push(`${meta.scheme_name}: fewer than 2 peers available in the "${category}" comparison set - peer ranking shown but treat it as indicative only.`);
      peerComparison = {
        category, categoryAvg1Y, categoryAvg3Y, categoryAvgSharpe1Y, categoryAvgRolling1Y, categoryAvgRolling3Y,
        rank: rank || null, outOf: ranked.length,
        lagVs1Y: metrics.rolling1Y && categoryAvgRolling1Y !== null ? round2(metrics.rolling1Y.avgPct - categoryAvgRolling1Y) : null,
        lagVs3Y: metrics.rolling3Y && categoryAvgRolling3Y !== null ? round2(metrics.rolling3Y.avgPct - categoryAvgRolling3Y) : null,
        peers: validPeers.map((p) => ({ schemeCode: p.schemeCode, schemeName: p.meta.scheme_name, metrics: p.metrics })),
      };
    }
  } else {
    warnings.push(`${meta.scheme_name}: category "${meta.scheme_category || 'unknown'}" has no curated peer group yet - peer comparison omitted, category-level metrics still shown.`);
  }

  // Benchmark (ETF proxy - see benchmarkMap.js for the honesty note on why).
  let benchmarkComparison = null;
  if (category && benchmarkMap[category]) {
    try {
      const bm = await fetchWithMetrics(benchmarkMap[category].schemeCode);
      if (!bm.metrics.asOfDate || !metrics.asOfDate || Math.abs(toDate(bm.metrics.asOfDate).getTime() - toDate(metrics.asOfDate).getTime()) > 7 * 86400000) throw new Error('benchmark NAV date is too far from the fund NAV date');
      const bmHistoryYears = bm.metrics.historyYears || 0;
      benchmarkComparison = {
        indexName: benchmarkMap[category].indexName,
        proxySchemeName: benchmarkMap[category].schemeName,
        benchmarkHistoryYears: bmHistoryYears,
        return1Y: bm.metrics.return1Y ? bm.metrics.return1Y.cagrPct : null,
        return3Y: (bm.metrics.return3Y && bm.metrics.return3Y.isAnnualized) ? bm.metrics.return3Y.cagrPct : null,
        return5Y: (bm.metrics.return5Y && bm.metrics.return5Y.isAnnualized) ? bm.metrics.return5Y.cagrPct : null,
        lagVs1Y: ppDiff(metrics.return1Y, bm.metrics.return1Y ? bm.metrics.return1Y.cagrPct : null),
        lagVs3Y: (bmHistoryYears >= 2.9) ? ppDiff(metrics.return3Y, bm.metrics.return3Y ? bm.metrics.return3Y.cagrPct : null) : null,
        lagVs5Y: (bmHistoryYears >= 4.9) ? ppDiff(metrics.return5Y, bm.metrics.return5Y ? bm.metrics.return5Y.cagrPct : null) : null,
      };
      if (bmHistoryYears < 4.9) warnings.push(`${meta.scheme_name}: the ${benchmarkMap[category].indexName} benchmark proxy only has ${bmHistoryYears} years of history - 5Y benchmark comparison omitted, shorter windows shown where they have full coverage.`);
    } catch (e) {
      warnings.push(`${meta.scheme_name}: benchmark proxy NAV was unavailable or dated more than 7 days apart - benchmark comparison omitted.`);
    }
  } else if (category) {
    warnings.push(`${meta.scheme_name}: no benchmark proxy configured for "${category}" yet - benchmark comparison omitted.`);
  }

  const { assetClass, estimatedEquityPct } = classifyAssetClass(meta.scheme_category);
  const navVerification = await officialCheck;
  if (navVerification.status === 'mismatch') warnings.push(`${meta.scheme_name}: MFapi NAV does not match AMFI for ${metrics.asOfDate}. Verify the scheme code and NAV before sharing.`);
  if (navVerification.status === 'provider_lag') warnings.push(`${meta.scheme_name}: AMFI has a newer NAV dated ${navVerification.officialDate}; MFapi may be behind.`);

  return {
    schemeCode: Number(schemeCode), schemeName: meta.scheme_name, fundHouse: meta.fund_house,
    category: meta.scheme_category, normalizedCategory: category, assetClass, estimatedEquityPct,
    currentValue: currentValue || null,
    metrics, peerComparison, benchmarkComparison,
    dataFreshness: fetched.dataFreshness, navVerification,
  };
}

// Keep / Monitor / Review classification. Deliberately requires MULTIPLE corroborating
// signals before recommending a review, never a single recent number - a fund that only
// lagged its category over the last year but is otherwise consistent and reasonably
// priced-in on risk terms should not be flagged from that alone.
function classifyFund(fund) {
  if (!fund.peerComparison && !fund.benchmarkComparison) {
    return { verdict: 'Insufficient data', signals: [], reason: 'Not enough peer or benchmark data to evaluate this fund yet.' };
  }
  const signals = [];
  const pc = fund.peerComparison, bc = fund.benchmarkComparison;

  if (pc && pc.lagVs3Y !== null && pc.lagVs3Y < -2) signals.push({ type: 'peer_lag_3y', magnitude: pc.lagVs3Y, text: `average rolling 3Y return is ${Math.abs(pc.lagVs3Y).toFixed(1)} percentage points behind the peer average` });
  if (bc && bc.lagVs3Y !== null && bc.lagVs3Y < -2) signals.push({ type: 'benchmark_lag_3y', magnitude: bc.lagVs3Y, text: `trailing 3Y return is ${Math.abs(bc.lagVs3Y).toFixed(1)} percentage points behind the ${bc.indexName} benchmark` });
  if (fund.metrics.rolling3Y && fund.metrics.rolling3Y.positivePct !== null && fund.metrics.rolling3Y.positivePct < 60) signals.push({ type: 'weak_consistency', magnitude: fund.metrics.rolling3Y.positivePct, text: `only ${fund.metrics.rolling3Y.positivePct.toFixed(0)}% of rolling 3-year periods were positive` });
  if (pc && pc.categoryAvgSharpe1Y !== null && fund.metrics.sharpe1Y !== null && fund.metrics.sharpe1Y < pc.categoryAvgSharpe1Y - 0.15) signals.push({ type: 'weak_risk_adjusted', magnitude: round2(fund.metrics.sharpe1Y - pc.categoryAvgSharpe1Y), text: `Sharpe ratio (${fund.metrics.sharpe1Y}) trails the category average (${pc.categoryAvgSharpe1Y})` });

  let verdict = 'Keep';
  if (signals.length >= 2) verdict = 'Review';
  else if (signals.length === 1) verdict = 'Monitor';

  return { verdict, signals };
}

// Two holdings in the same normalized category are "doing much the same job" - flagged
// for the advisor to consider consolidating, independent of the Keep/Monitor/Review call
// on either individual fund.
function findDuplication(funds) {
  const byCategory = {};
  for (const f of funds) {
    if (!f.normalizedCategory) continue;
    (byCategory[f.normalizedCategory] = byCategory[f.normalizedCategory] || []).push(f);
  }
  return Object.entries(byCategory)
    .filter(([, list]) => list.length > 1)
    .map(([category, list]) => ({ category, schemes: list.map((f) => ({ schemeCode: f.schemeCode, schemeName: f.schemeName, currentValue: f.currentValue })) }));
}

function portfolioHealth(funds) {
  const totalValue = funds.reduce((sum, f) => sum + (f.currentValue || 0), 0);
  const missingValueCount = funds.filter((f) => !f.currentValue).length;

  const byFund = funds.map((f) => ({
    schemeCode: f.schemeCode, schemeName: f.schemeName, fundHouse: f.fundHouse,
    currentValue: f.currentValue, weightPct: (totalValue && f.currentValue) ? round2((f.currentValue / totalValue) * 100) : null,
  }));

  const byFundHouse = {};
  for (const f of funds) {
    if (!f.currentValue) continue;
    byFundHouse[f.fundHouse] = (byFundHouse[f.fundHouse] || 0) + f.currentValue;
  }
  const fundHouseConcentration = Object.entries(byFundHouse)
    .map(([fundHouse, value]) => ({ fundHouse, value, weightPct: totalValue ? round2((value / totalValue) * 100) : null }))
    .sort((a, b) => b.value - a.value);

  let equityValue = 0, debtValue = 0, unclassifiedValue = 0;
  for (const f of funds) {
    if (!f.currentValue) continue;
    if (f.estimatedEquityPct === null) unclassifiedValue += f.currentValue;
    else { equityValue += f.currentValue * (f.estimatedEquityPct / 100); debtValue += f.currentValue * (1 - f.estimatedEquityPct / 100); }
  }
  const classifiedTotal = equityValue + debtValue;
  const equityPct = classifiedTotal ? round2((equityValue / classifiedTotal) * 100) : null;
  const debtPct = classifiedTotal ? round2((debtValue / classifiedTotal) * 100) : null;

  const maxSingleFund = byFund.reduce((max, f) => (f.weightPct !== null && f.weightPct > (max ? max.weightPct : -1)) ? f : max, null);
  const maxFundHouse = fundHouseConcentration[0] || null;

  return {
    totalValue: totalValue || null, missingValueCount,
    byFund, byFundHouse: fundHouseConcentration,
    equityDebtMix: { equityPct, debtPct, unclassifiedValue: unclassifiedValue || null, hasHybridEstimate: funds.some((f) => f.assetClass === 'Hybrid') },
    concentration: { maxSingleFund, maxFundHouse },
  };
}

async function buildReport({ client, goals = [], holdings = [], proposedReplacements = {} }) {
  const warnings = [];
  if (!holdings.length) throw new Error('At least one holding is required to build a report.');
  if (holdings.length > 12) throw new Error('Please analyze up to 12 holdings at a time.');

  const funds = await Promise.all(holdings.map((h) => buildFundMirror(h, warnings)));

  const recommendations = funds.map((f) => ({ schemeCode: f.schemeCode, schemeName: f.schemeName, ...classifyFund(f) }));
  const duplication = findDuplication(funds);
  const health = portfolioHealth(funds);

  // Horizon fit check against the client's stated investment horizon, if given.
  let horizonFit = null;
  if (client.horizonYears && health.equityDebtMix.equityPct !== null) {
    const eq = health.equityDebtMix.equityPct;
    if (client.horizonYears <= 3 && eq > 60) horizonFit = { flag: 'too_aggressive', text: `Equity exposure is ${eq}% against a ${client.horizonYears}-year horizon - a market fall close to the goal date would have little time to recover.` };
    else if (client.horizonYears >= 7 && eq < 40) horizonFit = { flag: 'too_conservative', text: `Equity exposure is only ${eq}% against a ${client.horizonYears}-year horizon - this may be leaving long-term growth on the table.` };
    else horizonFit = { flag: 'appropriate', text: `Equity exposure of ${eq}% is broadly appropriate for a ${client.horizonYears}-year horizon.` };
  } else if (!client.horizonYears) {
    warnings.push('No investment horizon supplied - horizon-fit check omitted.');
  }

  // Before/after mirror, only for funds the advisor has actually proposed a replacement for.
  let beforeAfter = null;
  const replacementEntries = Object.entries(proposedReplacements).filter(([, v]) => v);
  if (replacementEntries.length) {
    const replacementFunds = await Promise.all(replacementEntries.map(async ([oldCode, newCode]) => {
      try {
        const fetched = await fetchWithMetrics(newCode);
        return { oldCode: Number(oldCode), newCode: Number(newCode), meta: fetched.meta, metrics: fetched.metrics };
      } catch (e) {
        warnings.push(`Could not fetch data for proposed replacement scheme ${newCode} - that swap omitted from the before/after mirror.`);
        return null;
      }
    }));
    const validReplacements = replacementFunds.filter(Boolean);
    const afterFunds = funds.map((f) => {
      const repl = validReplacements.find((r) => r.oldCode === f.schemeCode);
      if (!repl) return f;
      return {
        schemeCode: repl.newCode, schemeName: repl.meta.scheme_name, fundHouse: repl.meta.fund_house,
        category: repl.meta.scheme_category, normalizedCategory: peerMap.normalizeCategory(repl.meta.scheme_category),
        assetClass: classifyAssetClass(repl.meta.scheme_category).assetClass,
        estimatedEquityPct: classifyAssetClass(repl.meta.scheme_category).estimatedEquityPct,
        currentValue: f.currentValue, metrics: repl.metrics, replacesSchemeCode: f.schemeCode, replacesSchemeName: f.schemeName,
      };
    });
    const afterHealth = portfolioHealth(afterFunds);

    // Illustrative historical comparison: same invested amount, same trailing window, what
    // each side's OWN trailing return over that window would have produced. Explicitly not
    // a forecast - just showing the past return each fund actually posted.
    const illustration = validReplacements.map((r) => {
      const oldFund = funds.find((f) => f.schemeCode === r.oldCode);
      if (!oldFund || !oldFund.currentValue) return null;
      const window = (oldFund.metrics.return3Y && oldFund.metrics.return3Y.isAnnualized && r.metrics.return3Y && r.metrics.return3Y.isAnnualized) ? 3
        : (oldFund.metrics.return1Y && r.metrics.return1Y) ? 1 : null;
      if (!window) return null;
      const oldReturn = window === 3 ? oldFund.metrics.return3Y.cagrPct : oldFund.metrics.return1Y.cagrPct;
      const newReturn = window === 3 ? r.metrics.return3Y.cagrPct : r.metrics.return1Y.cagrPct;
      const base = oldFund.currentValue;
      return {
        oldSchemeName: oldFund.schemeName, newSchemeName: r.meta.scheme_name, windowYears: window,
        investedAmount: base,
        oldWouldHaveValue: round0(base * Math.pow(1 + oldReturn / 100, window)),
        newWouldHaveValue: round0(base * Math.pow(1 + newReturn / 100, window)),
        isIllustrationOnly: true,
      };
    }).filter(Boolean);

    beforeAfter = {
      before: { funds, health },
      after: { funds: afterFunds, health: afterHealth },
      illustration,
      exitLoadNote: 'Exit load figures are not available from this report\'s data source. Check each scheme\'s Scheme Information Document (SID) or factsheet before redeeming.',
      taxNote: 'Capital gains tax was not computed - invested amount and purchase date were not supplied for these holdings. Provide them to include an indicative tax estimate.',
    };
  }

  // Goal outlook - imported lazily to avoid a require cycle at module load.
  const { goalOutlook } = require('./goalPlanner');
  const goalResults = goals.map((g) => goalOutlook(g));
  for (const g of goalResults) {
    if (g.projection === null) warnings.push(`Goal "${g.name}": could not project an outcome - a target amount, time horizon, and assumed annual return are all required.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    client, funds, recommendations, duplication, health, horizonFit,
    beforeAfter, goals: goalResults, warnings,
    methodology: {
      riskFreeRateUsed: funds[0] && funds[0].metrics.riskFreeRateUsed,
      benchmarkMethod: 'Benchmarks are proxied using large, liquid ETFs that track the relevant index (see each fund\'s benchmark section for the specific ETF and index). Actual Total Return Index figures may differ slightly due to tracking difference and the ETF\'s own expense ratio.',
      peerMethod: 'Peer groups are a curated set of large, well-known schemes in the same category, not an exhaustive category-wide ranking.',
    },
  };
}

module.exports = { buildReport, classifyAssetClass };

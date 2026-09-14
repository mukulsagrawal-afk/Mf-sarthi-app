const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise the report orchestration with deterministic provider responses.
// The real provider and AMFI checker make network calls, so their modules are
// substituted before loading the engine; the actual metrics/peer logic runs.
const providerPath = require.resolve('../server/utils/mfapi');
const amfiPath = require.resolve('../server/utils/amfiCheck');
const peerMap = require('../server/utils/peerMap');
const benchmarkMap = require('../server/utils/benchmarkMap');

function weekdays(start, end, rate = 0.1) {
  const data = [];
  for (let d = new Date(start), last = new Date(end); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const years = (d - new Date(start)) / (365.25 * 86400000);
    data.push({ date: d.toISOString().slice(0, 10), nav: 100 * Math.pow(1 + rate, years) });
  }
  return data;
}

const fullHistory = weekdays('2021-08-01', '2026-09-11');
const shortHistory = weekdays('2026-09-01', '2026-09-11');
require.cache[providerPath] = {
  id: providerPath, filename: providerPath, loaded: true,
  exports: { getSchemeData: async schemeCode => ({
    meta: { scheme_name: `Test Large Cap Direct Growth ${schemeCode}`, scheme_category: 'Equity Scheme - Large Cap Fund', fund_house: 'Test AMC' },
    data: Number(schemeCode) === 999999 ? shortHistory : fullHistory,
    fromCache: false, stale: false,
  }) },
};
require.cache[amfiPath] = {
  id: amfiPath, filename: amfiPath, loaded: true,
  exports: { checkLatestNav: async () => ({ status: 'matched' }) },
};
const { buildReport } = require('../server/utils/folioEngine');

test('full-history report populates rolling returns, ranking, and the portfolio mirror', async () => {
  assert.ok(peerMap['Large Cap'].length >= 20);
  assert.ok(benchmarkMap['Large Cap']);
  const report = await buildReport({ client: { name: 'Sample Client' }, holdings: [{ schemeCode: 120586, currentValue: 10000 }] });
  const fund = report.funds[0];
  assert.equal(report.health.totalValue, 10000);
  assert.ok(fund.metrics.rolling1Y.sampleCount >= 250);
  assert.ok(fund.metrics.rolling3Y.sampleCount >= 250);
  assert.ok(Number.isFinite(fund.metrics.stdDev1YAvg));
  assert.ok(Number.isFinite(fund.metrics.stdDev3YAvg));
  assert.ok(fund.peerComparison.peers.length >= 19);
  assert.ok(fund.peerComparison.rank >= 1);
  assert.ok(fund.benchmarkComparison.return1Y !== null);
  assert.notEqual(report.recommendations[0].verdict, 'Insufficient data');
});

test('short-history report keeps the holding but makes no unsupported recommendation', async () => {
  const report = await buildReport({ client: { name: 'Sample Client' }, holdings: [{ schemeCode: 999999, currentValue: 10000 }] });
  assert.equal(report.funds[0].metrics.dataPoints, shortHistory.length);
  assert.equal(report.funds[0].metrics.asOfDate, '2026-09-11');
  assert.equal(report.funds[0].metrics.rolling1Y, null);
  assert.equal(report.recommendations[0].verdict, 'Insufficient data');
  assert.match(report.warnings.join(' '), /too little history/i);
  assert.equal(report.health.byFund[0].currentValue, 10000);
});

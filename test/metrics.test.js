const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMetrics } = require('../server/utils/metrics');

function weekdays(start, end, rate = 0.10) {
  const result = [];
  for (let d = new Date(start), last = new Date(end); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const years = (d - new Date(start)) / (365.25 * 86400000);
    result.push({ date: d.toISOString().slice(0, 10), nav: 100 * Math.pow(1 + rate, years) });
  }
  return result;
}

test('rolling 1Y and 3Y use every trading-date endpoint in the latest year', () => {
  const m = computeMetrics(weekdays('2021-08-01', '2026-08-01'));
  assert.ok(m.rolling1Y.sampleCount >= 250 && m.rolling1Y.sampleCount <= 265);
  assert.ok(m.rolling3Y.sampleCount >= 250 && m.rolling3Y.sampleCount <= 265);
  assert.ok(Math.abs(m.rolling1Y.avgPct - 10) < 0.05);
  assert.ok(Math.abs(m.rolling3Y.avgPct - 10) < 0.05);
  assert.ok(Math.abs(m.return1Y.cagrPct - 10) < 0.05);
  assert.equal(m.riskFreeRateUsed, 0.05);
  // Calendar-day compounding creates larger Monday NAV changes after weekends.
  assert.ok(m.stdDev1YAvg > 0 && m.stdDev1YAvg < 1);
  assert.ok(m.stdDev3YAvg > 0 && m.stdDev3YAvg < 1);
});

test('missing full history remains unavailable instead of showing a partial 3Y figure', () => {
  const m = computeMetrics(weekdays('2024-08-01', '2026-08-01'));
  assert.equal(m.return3Y, null);
  assert.equal(m.rolling3Y, null);
  assert.ok(m.rolling1Y.sampleCount > 200);
});

test('a new fund still exposes NAV coverage and date for a clear report explanation', () => {
  const m = computeMetrics(weekdays('2026-07-01', '2026-07-22'));
  assert.equal(m.insufficientHistory, true);
  assert.equal(m.firstNavDate, '2026-07-01');
  assert.equal(m.asOfDate, '2026-07-22');
  assert.equal(m.rolling1Y, null);
});

test('input order, duplicate dates and invalid NAVs cannot change a result', () => {
  const clean = weekdays('2021-08-01', '2026-08-01');
  const dirty = clean.slice().reverse().concat([{ ...clean[100] }, { date: 'bogus', nav: 2 }, { date: '2025-01-01', nav: 0 }]);
  const a = computeMetrics(clean), b = computeMetrics(dirty);
  assert.equal(a.return1Y.cagrPct, b.return1Y.cagrPct);
  assert.equal(a.rolling3Y.avgPct, b.rolling3Y.avgPct);
  assert.equal(a.dataPoints, b.dataPoints);
});

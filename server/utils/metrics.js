// NAV-based performance measures. Rolling observations end on each published NAV
// date in the latest year and start on the closest preceding NAV 1Y/3Y earlier.
const DEFAULT_RISK_FREE_RATE = 0.05;
const DAY_MS = 86400000;
const round2 = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
function toDate(value) {
  const s = String(value || '');
  const p = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').map(Number) : s.split('-').reverse().map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2] ? d : new Date(NaN);
}
function yearsBefore(ms, years) { const d = new Date(ms); d.setUTCFullYear(d.getUTCFullYear() - years); return d.getTime(); }
function prepare(series) {
  return (series || []).map(p => ({ ...p, nav: Number(p.nav), ms: toDate(p.date).getTime() }))
    .filter(p => Number.isFinite(p.ms) && Number.isFinite(p.nav) && p.nav > 0)
    .sort((a, b) => a.ms - b.ms).filter((p, i, a) => i === a.length - 1 || p.ms !== a[i + 1].ms);
}
function onOrBefore(points, target) {
  let lo = 0, hi = points.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (points[mid].ms <= target) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found;
}
function windowStart(points, end, years) {
  const target = yearsBefore(points[end].ms, years), index = onOrBefore(points, target);
  return index >= 0 && target - points[index].ms <= 7 * DAY_MS ? index : -1;
}
function returnAt(points, start, end) {
  const a = points[start], b = points[end], actualYears = (b.ms - a.ms) / (365.25 * DAY_MS);
  return { cagrPct: round2((Math.pow(b.nav / a.nav, 1 / actualYears) - 1) * 100), startDate: a.date, startNav: a.nav, endDate: b.date, endNav: b.nav, actualYears: round2(actualYears), isAnnualized: true };
}
function trailingReturn(series, years) {
  const p = prepare(series); if (p.length < 2) return null;
  const start = windowStart(p, p.length - 1, years); return start < 0 ? null : returnAt(p, start, p.length - 1);
}
function prefixes(p) {
  const sum = [0], square = [0], downside = [0];
  for (let i = 1; i < p.length; i++) { const r = p[i].nav / p[i - 1].nav - 1; sum.push(sum[i - 1] + r); square.push(square[i - 1] + r * r); downside.push(downside[i - 1] + Math.min(r, 0) ** 2); }
  return { sum, square, downside };
}
function windowRisk(pre, start, end) {
  const n = end - start; if (n < 30) return null;
  const sum = pre.sum[end] - pre.sum[start], sq = pre.square[end] - pre.square[start];
  return { stdDevPct: Math.sqrt(Math.max(0, (sq - sum * sum / n) / (n - 1)) * 252) * 100, downsidePct: Math.sqrt((pre.downside[end] - pre.downside[start]) / n * 252) * 100 };
}
function rollingFromPoints(p, years, pre) {
  if (p.length < 2) return null;
  const firstEndpoint = yearsBefore(p.at(-1).ms, 1), samples = [];
  for (let end = 1; end < p.length; end++) {
    if (p[end].ms < firstEndpoint) continue;
    const start = windowStart(p, end, years); if (start < 0) continue;
    samples.push({ date: p[end].date, returnPct: returnAt(p, start, end).cagrPct, stdDevPct: windowRisk(pre, start, end)?.stdDevPct ?? null });
  }
  // Do not present a truncated endpoint year as a full rolling-year average.
  if (samples.length < 200 || toDate(samples[0].date).getTime() - firstEndpoint > 7 * DAY_MS) return null;
  const vals = samples.map(s => s.returnPct), risks = samples.map(s => s.stdDevPct).filter(Number.isFinite);
  const stride = Math.max(1, Math.ceil(samples.length / 48));
  return { avgPct: round2(vals.reduce((a, b) => a + b, 0) / vals.length), minPct: round2(Math.min(...vals)), maxPct: round2(Math.max(...vals)), positivePct: round2(vals.filter(v => v > 0).length / vals.length * 100), stdDevAvgPct: risks.length ? round2(risks.reduce((a, b) => a + b, 0) / risks.length) : null, sampleCount: samples.length, firstEndDate: samples[0].date, lastEndDate: samples.at(-1).date, chart: samples.filter((_, i) => i % stride === 0 || i === samples.length - 1).map(s => ({ date: s.date, returnPct: s.returnPct })) };
}
function rollingReturns(series, years) { const p = prepare(series); return rollingFromPoints(p, years, prefixes(p)); }
function annualizedStdDev(rets) { if (!rets || rets.length < 2) return null; const mean = rets.reduce((a, b) => a + b, 0) / rets.length; return Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1) * 252); }
function annualizedDownsideDeviation(rets, targetDaily = 0) { return rets?.length >= 2 ? Math.sqrt(rets.reduce((a, r) => a + Math.min(r - targetDaily, 0) ** 2, 0) / rets.length * 252) : null; }
function maxDrawdown(series, years) {
  const p = prepare(series); if (p.length < 2) return null;
  let start = p.findIndex(x => x.ms >= yearsBefore(p.at(-1).ms, years)); if (start < 0) start = 0;
  let peak = p[start], max = 0, peakDate = peak.date, troughDate = peak.date;
  for (let i = start; i < p.length; i++) { const x = p[i]; if (x.nav > peak.nav) peak = x; const dd = (x.nav / peak.nav - 1) * 100; if (dd < max) { max = dd; peakDate = peak.date; troughDate = x.date; } }
  return { maxDrawdownPct: round2(max), peakDate, troughDate, windowYears: round2((p.at(-1).ms - p[start].ms) / (365.25 * DAY_MS)) };
}
function historyYears(series) { const p = prepare(series); return p.length < 2 ? 0 : round2((p.at(-1).ms - p[0].ms) / (365.25 * DAY_MS)); }
function computeMetrics(series, { riskFreeRate = DEFAULT_RISK_FREE_RATE } = {}) {
  const p = prepare(series);
  const identity = { asOfDate: p.at(-1)?.date || null, latestNav: p.at(-1)?.nav ?? null, firstNavDate: p[0]?.date || null, dataPoints: p.length, historyYears: p.length < 2 ? 0 : round2((p.at(-1).ms - p[0].ms) / (365.25 * DAY_MS)) };
  if (p.length < 30) return { ...identity, insufficientHistory: true, return1Y:null, return3Y:null, rolling1Y:null, rolling3Y:null, stdDev1Y:null, stdDev1YAvg:null, stdDev3YAvg:null, sharpe1Y:null, sortino1Y:null, riskFreeRateUsed:riskFreeRate };
  const pre = prefixes(p), end = p.length - 1, tr = years => { const start = windowStart(p, end, years); return start < 0 ? null : returnAt(p, start, end); };
  const return1Y = tr(1), return3Y = tr(3), return5Y = tr(5), rolling1Y = rollingFromPoints(p, 1, pre), rolling3Y = rollingFromPoints(p, 3, pre);
  const start1Y = windowStart(p, end, 1), risk = start1Y < 0 ? null : windowRisk(pre, start1Y, end), excess = return1Y ? return1Y.cagrPct / 100 - riskFreeRate : null;
  const dailyTarget = Math.pow(1 + riskFreeRate, 1 / 252) - 1;
  const rets1Y = start1Y < 0 ? [] : p.slice(start1Y + 1).map((x, i) => x.nav / p[start1Y + i].nav - 1);
  const downside = annualizedDownsideDeviation(rets1Y, dailyTarget);
  return { ...identity, return1Y, return3Y, return5Y, rolling1Y, rolling3Y, maxDrawdown5Y: maxDrawdown(p, 5), stdDev1Y: risk ? round2(risk.stdDevPct) : null, stdDev1YAvg: rolling1Y?.stdDevAvgPct ?? null, stdDev3YAvg: rolling3Y?.stdDevAvgPct ?? null, downsideDeviation1Y: downside === null ? null : round2(downside * 100), sharpe1Y: excess !== null && risk?.stdDevPct > 0 ? round2(excess / (risk.stdDevPct / 100)) : null, sortino1Y: excess !== null && downside > 0 ? round2(excess / downside) : null, riskFreeRateUsed: riskFreeRate };
}
module.exports = { computeMetrics, trailingReturn, rollingReturns, annualizedStdDev, annualizedDownsideDeviation, maxDrawdown, historyYears, DEFAULT_RISK_FREE_RATE, toDate };

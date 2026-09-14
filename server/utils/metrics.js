// Financial metrics engine for the Portfolio Analyzer.
//
// Everything here takes `series`: an array of { date: 'YYYY-MM-DD', nav: number },
// oldest-first (this is the shape mfapi.js normalizes MFAPI's NAV history into).
//
// Methodology, spelled out because these numbers go in front of clients:
// - Trailing / point-to-point return: CAGR between the NAV closest to `asOfDate - years`
//   and the latest NAV. For windows under 1 year, this is a simple (not annualized) return.
// - Rolling returns: sample a trailing-return window starting at every ~21st NAV point
//   (roughly monthly) across the whole history, report avg / min / max / % of windows
//   that were positive. This is the standard "rolling return" an MFD means by the term -
//   not just the single most-recent window.
// - Annualized standard deviation: stdev of daily returns over the trailing 1Y, x sqrt(252).
// - Downside deviation: same, but only over the negative daily returns, still divided by
//   the TOTAL number of return observations (not just the negative ones) - this is the
//   standard Sortino-ratio convention, not a mistake.
// - Sharpe / Sortino: (annualized return - risk-free rate) / (std dev / downside dev).
// - Risk-free rate: fixed assumption, not live-fetched (see DEFAULT_RISK_FREE_RATE below).
//   Surfaced in the response so nobody mistakes it for a live rate.

const DEFAULT_RISK_FREE_RATE = 0.065; // 6.5% - roughly the prevailing short-term G-Sec/repo level
const TRADING_DAYS_PER_YEAR = 252;
const MIN_DATA_POINTS = 30; // below this, "metrics" would just be noise - refuse instead

function toDate(d) {
  // MFAPI dates are 'DD-MM-YYYY'
  const [dd, mm, yyyy] = d.split('-').map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

// Nearest series entry to a target date, searching backward first (the closest trading
// day on/before the target), falling back to the earliest point if the fund is younger
// than the requested window.
function nearestOnOrBefore(series, targetDate) {
  let best = null;
  for (const pt of series) {
    const d = toDate(pt.date);
    if (d <= targetDate) {
      if (!best || d > toDate(best.date)) best = pt;
    }
  }
  return best || series[0] || null;
}

function round2(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 100) / 100; }

// Point-to-point trailing return ending at the latest NAV in `series`, over `years`.
// Returns { cagrPct, startDate, startNav, endDate, endNav, isAnnualized } or null.
function trailingReturn(series, years) {
  if (!series.length) return null;
  const end = series[series.length - 1];
  const endDate = toDate(end.date);
  const targetStart = new Date(endDate);
  targetStart.setUTCFullYear(targetStart.getUTCFullYear() - years);
  const start = nearestOnOrBefore(series, targetStart);
  if (!start || start.nav <= 0 || start.date === end.date) return null;

  const actualYears = (endDate - toDate(start.date)) / (365.25 * 24 * 60 * 60 * 1000);
  const growth = end.nav / start.nav;
  let cagrPct;
  if (actualYears >= 0.95) {
    // Long enough to annualize meaningfully.
    cagrPct = (Math.pow(growth, 1 / actualYears) - 1) * 100;
  } else {
    // Young fund / short window - report the plain (non-annualized) point-to-point return
    // instead of an annualization that would wildly exaggerate a few months of data.
    cagrPct = (growth - 1) * 100;
  }
  return {
    cagrPct: round2(cagrPct),
    startDate: start.date, startNav: start.nav,
    endDate: end.date, endNav: end.nav,
    isAnnualized: actualYears >= 0.95,
    actualYears: round2(actualYears),
  };
}

// Rolling N-year returns sampled roughly monthly across the full history.
function rollingReturns(series, years) {
  if (series.length < 2) return null;
  const stepDays = 21; // ~1 trading month
  const windowMs = years * 365.25 * 24 * 60 * 60 * 1000;
  const samples = [];

  for (let i = 0; i < series.length; i += stepDays) {
    const windowStart = series[i];
    const windowStartDate = toDate(windowStart.date);
    const windowEndTarget = new Date(windowStartDate.getTime() + windowMs);
    // Find the series point on/after the target end date.
    let endPt = null;
    for (let j = i; j < series.length; j++) {
      if (toDate(series[j].date) >= windowEndTarget) { endPt = series[j]; break; }
    }
    if (!endPt || windowStart.nav <= 0) continue;
    const actualYears = (toDate(endPt.date) - windowStartDate) / (365.25 * 24 * 60 * 60 * 1000);
    if (actualYears < years * 0.9) continue; // don't count a truncated window near the end of history
    const cagr = (Math.pow(endPt.nav / windowStart.nav, 1 / actualYears) - 1) * 100;
    samples.push(cagr);
  }

  if (!samples.length) return null;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const positivePct = (samples.filter((s) => s > 0).length / samples.length) * 100;
  return {
    avgPct: round2(avg), minPct: round2(min), maxPct: round2(max),
    positivePct: round2(positivePct), sampleCount: samples.length,
  };
}

// Daily returns over the trailing `years` window (for std dev / Sharpe / Sortino).
function dailyReturns(series, years) {
  if (series.length < 2) return [];
  const end = series[series.length - 1];
  const endDate = toDate(end.date);
  const targetStart = new Date(endDate);
  targetStart.setUTCFullYear(targetStart.getUTCFullYear() - years);

  let startIdx = series.findIndex((p) => toDate(p.date) >= targetStart);
  if (startIdx === -1) startIdx = 0;
  const slice = series.slice(startIdx);

  const rets = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1].nav > 0) rets.push(slice[i].nav / slice[i - 1].nav - 1);
  }
  return rets;
}

function annualizedStdDev(rets) {
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

// Downside deviation, standard Sortino convention: only negative returns contribute to
// the sum of squares, but the divisor is still the TOTAL number of observations - not
// just the count of negative ones. This is intentional, not a bug.
function annualizedDownsideDeviation(rets) {
  if (rets.length < 2) return null;
  const downside = rets.filter((r) => r < 0);
  if (!downside.length) return 0;
  const sumSq = downside.reduce((a, b) => a + b ** 2, 0);
  const variance = sumSq / rets.length;
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function computeMetrics(series, { riskFreeRate = DEFAULT_RISK_FREE_RATE } = {}) {
  if (!Array.isArray(series) || series.length < MIN_DATA_POINTS) {
    return { insufficientHistory: true, dataPoints: series ? series.length : 0 };
  }

  const return1Y = trailingReturn(series, 1);
  const return5Y = trailingReturn(series, 5);
  const rolling1Y = rollingReturns(series, 1);
  const rolling5Y = rollingReturns(series, 5);

  const rets1Y = dailyReturns(series, 1);
  const stdDev1Y = annualizedStdDev(rets1Y);
  const downsideDeviation1Y = annualizedDownsideDeviation(rets1Y);

  const annReturn1Y = return1Y ? return1Y.cagrPct / 100 : null;
  const sharpe1Y = (annReturn1Y !== null && stdDev1Y) ? round2((annReturn1Y - riskFreeRate) / stdDev1Y) : null;
  const sortino1Y = (annReturn1Y !== null && downsideDeviation1Y) ? round2((annReturn1Y - riskFreeRate) / downsideDeviation1Y) : (annReturn1Y !== null && downsideDeviation1Y === 0 ? null : null);

  return {
    asOfDate: series[series.length - 1].date,
    latestNav: series[series.length - 1].nav,
    dataPoints: series.length,
    return1Y, return5Y,
    rolling1Y, rolling5Y,
    stdDev1Y: stdDev1Y !== null ? round2(stdDev1Y * 100) : null, // as a %, e.g. 14.28
    downsideDeviation1Y: downsideDeviation1Y !== null ? round2(downsideDeviation1Y * 100) : null,
    sharpe1Y,
    sortino1Y,
    riskFreeRateUsed: riskFreeRate,
  };
}

module.exports = {
  computeMetrics, trailingReturn, rollingReturns, annualizedStdDev, annualizedDownsideDeviation,
  DEFAULT_RISK_FREE_RATE,
};

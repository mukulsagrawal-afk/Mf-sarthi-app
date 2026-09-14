// Scheme-name matching is advisory only. An omitted plan must stay ambiguous.
function bestMatches(line, rows, amcNames = []) {
  const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const stop = new Set(['fund','mutual','plan','option','growth','direct','regular','the','and','of','india','scheme','open','ended','investing','in','equity']);
  const lineNorm = normalize(line), tokens = new Set(lineNorm.split(' ').filter(t => t.length > 2 && !stop.has(t)));
  if (tokens.size < 2) return [];
  const amc = amcNames.find(name => lineNorm.includes(normalize(name)));
  const amcKey = amc ? normalize(amc).split(' ')[0] : null;
  const plan = /\bdirect\b/i.test(line) ? 'direct' : /\bregular\b/i.test(line) ? 'regular' : null;
  const payout = /\b(idcw|dividend|payout|reinvestment)\b/i.test(line) ? 'idcw' : /\bgrowth\b/i.test(line) ? 'growth' : null;
  const scored = [];
  for (const row of rows) {
    if (amcKey && !row.schemeName.toLowerCase().includes(amcKey)) continue;
    const name = normalize(row.schemeName), nameTokens = new Set(name.split(' ').filter(t => t.length > 2 && !stop.has(t)));
    let overlap = 0; for (const t of nameTokens) if (tokens.has(t)) overlap++;
    if (overlap < 2) continue;
    const coverage = overlap / nameTokens.size, precision = overlap / tokens.size;
    let score = (coverage * 0.75 + precision * 0.25) * 100;
    if (plan && !name.includes(plan)) score -= 35;
    if (payout === 'growth' && !name.includes('growth')) score -= 35;
    if (payout === 'idcw' && !/idcw|dividend|payout|reinvest/.test(name)) score -= 35;
    if (score >= 55) scored.push({ ...row, confidence: Math.min(100, Math.round(score)) });
  }
  return scored.sort((a, b) => b.confidence - a.confidence || a.schemeName.length - b.schemeName.length).slice(0, 3);
}
module.exports = { bestMatches };

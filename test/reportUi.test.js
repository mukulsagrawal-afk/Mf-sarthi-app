const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');

test('FolioXpert retains legible hero text and visible scheme-search results', () => {
  assert.match(html, /\.ai-hero h1\{[^}]*color:#fff/i);
  assert.match(html, /\.ai-hero p\{[^}]*color:rgba\(255,255,255/i);
  assert.match(html, /\.picker-dd\.open\{display:block;/);
  const nav = html.match(/<a class="nav-item nav-item-ai" data-view="folioxpert"[^>]*>[^\n]+/);
  assert.ok(nav);
  assert.doesNotMatch(nav[0], /ai-chip-mini/);
  assert.match(html, /@keyframes pickerReveal/);
  assert.match(html, /prefers-reduced-motion:reduce[^}]*\.picker-dd\.open/);
});

test('scheme dropdown keyboard selection keeps the chosen fund while closing', async () => {
  const start = html.indexOf('function fxWireSearch('), end = html.indexOf('async function fxLoadPreview(', start);
  const options = [{id:'scheme-list-0-option-0',dataset:{fxResult:'0'},classList:{toggle(){}},setAttribute(){},scrollIntoView(){}}];
  const classes = new Set();
  const dd = {setAttribute(){},classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v)},querySelectorAll:()=>options};
  const attrs = {};
  const input = {dataset:{fxScheme:'0'},value:'ICICI',setAttribute:(k,v)=>{attrs[k]=v;},removeAttribute:k=>{delete attrs[k];}};
  const chosen = [];
  const context = {api:async()=>({results:[{schemeCode:120586,schemeName:'ICICI Prudential Large Cap Fund Direct Growth'}]}),esc:s=>s,
    clearTimeout(){},setTimeout:fn=>{fn();return 1;},document:{body:{contains:()=>true}}};
  vm.runInNewContext(html.slice(start,end),context);
  context.fxWireSearch(input,dd,fund=>chosen.push(fund));
  input.oninput();
  await new Promise(resolve=>setImmediate(resolve));
  input.onkeydown({key:'ArrowDown',preventDefault(){}});
  input.onkeydown({key:'Enter',preventDefault(){}});
  assert.equal(chosen[0].schemeCode,120586);
  assert.equal(attrs['aria-expanded'],'false');
  assert.equal(classes.has('open'),false);
});

test('short-history holding retains a visible matrix and one useful coverage explanation', () => {
  const start = html.indexOf('function fxCoverageText('), end = html.indexOf('function fxReportBody(', start);
  assert.ok(start > 0 && end > start);
  const context = { esc:s=>String(s), fxPct:n=>n == null ? 'Not available' : n+'%', fxMetric:n=>String(n), fxMoney:n=>'₹'+n,
    fxReturn:()=>'', fxRollingChart:()=>'', fxRow:()=>'', fxPeerBars:()=>'' };
  vm.runInNewContext(html.slice(start,end),context);
  const fund = {schemeName:'New Large Cap Fund',category:'Equity Scheme - Large Cap Fund',normalizedCategory:'Large Cap',currentValue:10000,metrics:{dataPoints:18,firstNavDate:'2026-07-01',asOfDate:'2026-07-22',historyYears:0.06,return1Y:null,rolling1Y:null,rolling3Y:null}};
  const matrix = context.fxPortfolioMatrix([fund]);
  const card = context.fxFundAnalysisCard(fund);
  assert.match(matrix,/Portfolio matrix/);
  assert.match(matrix,/New Large Cap Fund/);
  assert.match(card,/Only 18 NAV observations/);
  assert.doesNotMatch(card,/0 daily windows|Average rolling 3Y.*Not available/);
});

test('a full-history holding renders populated rolling metrics and chart space', () => {
  const start = html.indexOf('function fxCoverageText('), end = html.indexOf('function fxReportBody(', start);
  const context = { esc:s=>String(s), fxPct:n=>n == null ? 'Not available' : n+'%', fxMetric:n=>String(n), fxMoney:n=>'₹'+n,
    fxReturn:r=>r.cagrPct+'%', fxRollingChart:()=>'<svg class="tested-chart"></svg>', fxRow:(label,value)=>label+value, fxPeerBars:()=>'' };
  vm.runInNewContext(html.slice(start,end),context);
  const fund = {schemeName:'ICICI Prudential Large Cap Fund',category:'Equity Scheme - Large Cap Fund',normalizedCategory:'Large Cap',metrics:{dataPoints:3300,historyYears:12,asOfDate:'2026-09-11',return1Y:{cagrPct:-4.41},rolling1Y:{avgPct:4.42,sampleCount:247,minPct:-8,maxPct:15,positivePct:65,chart:[{date:'a',returnPct:1},{date:'b',returnPct:2}]},rolling3Y:{avgPct:16.51,sampleCount:247,minPct:8,maxPct:20,positivePct:100,chart:[{date:'a',returnPct:1},{date:'b',returnPct:2}]},stdDev1YAvg:11.99,stdDev3YAvg:11.85,sharpe1Y:-0.74},peerComparison:{categoryAvgRolling1Y:5,categoryAvgRolling3Y:15,rank:7,outOf:20,lagVs1Y:-0.58,lagVs3Y:1.51,peers:[]}};
  const card = context.fxFundAnalysisCard(fund);
  assert.match(card,/Average rolling 1Y/);
  assert.match(card,/247 daily windows/);
  assert.match(card,/tested-chart/);
  assert.doesNotMatch(card,/0 daily windows|Performance history is too short/);
});

test('peer comparison shows four rolling measures and preserves unavailable windows', () => {
  const start = html.indexOf('function fxPeerComparisonTable('), end = html.indexOf('function fxReportBody(', start);
  const context = {esc:s=>String(s),fxPct:n=>Number(n).toFixed(2)+'%',fxMetric:n=>String(n),fxMoney:n=>'₹'+n,
    fxReturn:()=>'',fxRollingChart:()=>'',fxRow:()=>'',fxPeerBars:()=>''};
  vm.runInNewContext(html.slice(start,end),context);
  const full = {schemeName:'Selected Large Cap Direct Growth',normalizedCategory:'Large Cap',metrics:{rolling1Y:{avgPct:9.3,sampleCount:251},rolling3Y:{avgPct:12.8,sampleCount:251},stdDev1YAvg:11.2,stdDev3YAvg:10.4}};
  const peer = {schemeName:'Peer Large Cap Direct Growth',metrics:{rolling1Y:{avgPct:8.5},rolling3Y:{avgPct:11.5},stdDev1YAvg:12.3,stdDev3YAvg:11.7}};
  const limited = {schemeName:'New Peer Direct Growth',metrics:{rolling1Y:null,rolling3Y:null,stdDev1YAvg:null,stdDev3YAvg:null}};
  const table = context.fxPeerComparisonTable(full,{category:'Large Cap',peers:[peer,limited]});
  assert.match(table,/Avg rolling 1Y return/);
  assert.match(table,/Avg rolling 3Y return/);
  assert.match(table,/Avg rolling 1Y SD/);
  assert.match(table,/Avg rolling 3Y SD/);
  assert.match(table,/Selected Large Cap Direct Growth/);
  assert.match(table,/Peer average/);
  assert.match(table,/9\.30%/);
  assert.match(table,/10\.40%/);
  assert.match(table,/New Peer Direct Growth[\s\S]*Full NAV history unavailable/);
  assert.doesNotMatch(table,/NaN%|0\.00%/);
});

test('design system uses Manrope, one brand palette and reduced-motion fallbacks', () => {
  assert.match(html,/family=Manrope:wght@400;500;600;700;800/);
  assert.match(html,/--font-body:'Manrope'/);
  assert.match(html,/\.kpi-card\.grad:hover\{transform:translateY\(-7px\) scale\(1\.025\)/);
  assert.match(html,/animation:riseIn \.5s var\(--ease-premium\) backwards/);
  assert.match(html,/\.fx-compare-table tr\.selected/);
  assert.match(html,/prefers-reduced-motion:reduce/);
  assert.doesNotMatch(html,/linear-gradient\(150deg,#7C3AED|linear-gradient\(150deg,#E11D48/);
});

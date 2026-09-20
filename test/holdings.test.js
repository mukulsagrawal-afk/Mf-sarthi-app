const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const XLSX = require('xlsx');

process.env.DATA_DIR = path.join(process.cwd(), '.test-data', `holdings-${process.pid}`);
const db = require('../server/db');
const holdingsDb = require('../server/holdings-db');
const { parseWorkbook, normalizeSchemeName } = require('../server/utils/portfolioParser');
const { importPortfolioBuffer, getSchemeHoldings, searchMappedSchemes, portfolioOverlap, lookThrough, parseAmfiRegistryHtml, assertPublicUrl, discoverDisclosurePages, linkMatchesTargetMonth } = require('../server/utils/portfolioService');
const { balancePlanVariants } = require('../server/utils/mfapi');
const { parseNavAll } = require('../server/utils/amfiUniverse');

function fixtureWorkbook() {
  const rows = [
    ['HDFC Large Cap Fund'],
    ['Name of Instrument','ISIN','Industry / Rating','Quantity','Market Value (Rs. in Lakh)','% to NAV'],
    ['Reliance Industries Limited','INE002A01018','Petroleum Products',1000,245,8.25],
    ['HDFC Bank Limited','INE040A01034','Banks',800,210,7.10],
    ['TREPS','','Money Market',null,34,1.15],
    ['Total','','',null,489,16.5],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Large Cap');
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}

test('portfolio parser reads security rows and ignores totals', () => {
  const parsed = parseWorkbook(fixtureWorkbook(),'portfolio.xlsx');
  assert.equal(parsed.schemes.length,1);
  assert.equal(parsed.schemes[0].holdings.length,3);
  assert.equal(parsed.schemes[0].holdings[0].isin,'INE002A01018');
  assert.equal(parsed.schemes[0].holdings[0].pctNav,8.25);
});

test('Direct, Regular, Growth and IDCW normalize to one underlying scheme', () => {
  const names = [
    'HDFC Large Cap Fund - Direct Plan - Growth Option',
    'HDFC Large Cap Fund - Regular Plan - Growth Option',
    'HDFC Large Cap Fund - Direct Plan - IDCW Payout',
    'HDFC Large Cap Fund - Regular Plan - Dividend Reinvestment',
  ];
  assert.equal(new Set(names.map(normalizeSchemeName)).size,1);
});

test('one imported disclosure serves every mapped plan and portfolio look-through', () => {
  const amc = holdingsDb.prepare("SELECT mf_id FROM amc_sources WHERE mf_name LIKE 'HDFC%' LIMIT 1").get();
  assert.ok(amc);
  const insert = db.prepare('INSERT OR REPLACE INTO mf_scheme_index (scheme_code,scheme_name) VALUES (?,?)');
  insert.run(900001,'HDFC Large Cap Fund - Direct Plan - Growth Option');
  insert.run(900002,'HDFC Large Cap Fund - Regular Plan - IDCW Payout');
  const addUniverse=holdingsDb.prepare(`INSERT OR REPLACE INTO scheme_universe
    (scheme_code,amc_name,category,scheme_name,plan,option,active) VALUES (?,?,?,?,?,?,1)`);
  addUniverse.run(900001,'HDFC Mutual Fund','Open Ended Schemes(Equity Scheme - Large Cap Fund)','HDFC Large Cap Fund - Direct Plan - Growth Option','Direct Plan','Growth Option');
  addUniverse.run(900002,'HDFC Mutual Fund','Open Ended Schemes(Equity Scheme - Large Cap Fund)','HDFC Large Cap Fund - Regular Plan - IDCW Payout','Regular Plan','IDCW Payout');
  const result = importPortfolioBuffer({buffer:fixtureWorkbook(),filename:'hdfc-portfolio.xlsx',mfId:amc.mf_id,disclosureDate:'2026-08-31',sourceUrl:'https://example.com/hdfc.xlsx'});
  assert.equal(result.schemeCount,1);
  assert.equal(result.holdingCount,3);
  assert.ok(result.mappedPlans>=2);
  assert.equal(getSchemeHoldings(900001).holdings.length,3);
  assert.equal(getSchemeHoldings(900002).disclosureDate,'2026-08-31');
  const exposure = lookThrough([{schemeCode:900001,currentValue:100000},{schemeCode:900002,currentValue:50000}]);
  assert.equal(exposure.coveredValue,150000);
  assert.equal(Math.round(exposure.exposures[0].amount),12375);
  const duplicate = importPortfolioBuffer({buffer:fixtureWorkbook(),filename:'again.xlsx',mfId:amc.mf_id,disclosureDate:'2026-08-31'});
  assert.equal(duplicate.duplicate,true);
});

test('official holdings search covers AMFI schemes and labels holdings availability', () => {
  const results = searchMappedSchemes('HDFC Large Cap',20);
  assert.ok(results.some(x=>x.schemeCode===900001));
  assert.ok(results.some(x=>x.schemeCode===900002));
  assert.ok(results.filter(x=>x.schemeCode>=900001).every(x=>x.hasHoldings));
});

test('AMFI NAV master parser captures AMC, category, Direct and Regular variants', () => {
  const text=`Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date\nOpen Ended Schemes(Equity Scheme - Large Cap Fund)\nExample Mutual Fund\n123;INF000A1;-;Example Fund - Direct Growth;Direct Plan;Growth Option;10.5;18-Sep-2026\n124;INF000A2;-;Example Fund - Regular IDCW;Regular Plan;IDCW Payout;11;18-Sep-2026`;
  const rows=parseNavAll(text);
  assert.equal(rows.length,2);
  assert.equal(rows[0].amcName,'Example Mutual Fund');
  assert.equal(rows[1].plan,'Regular Plan');
  assert.equal(rows[1].navDate,'2026-09-18');
});

test('FolioXpert overlap uses the smaller shared security weights', () => {
  const result=portfolioOverlap([{schemeCode:900001,currentValue:100000},{schemeCode:900002,currentValue:50000}]);
  assert.equal(result.pairCount,1);
  assert.equal(result.highestOverlap.sharedHoldings,3);
  assert.equal(result.highestOverlap.overlapPct,16.5);
  assert.equal(result.highestOverlap.topShared[0].instrumentName,'Reliance Industries Limited');
});

test('AMFI registry parser preserves AMCs without a published URL for coverage tracking', () => {
  const html = '<script>self.__next_f.push([1,"x\\\"members\\\":[{\\\"mf_id\\\":\\\"9\\\",\\\"mf_name\\\":\\\"Example Mutual Fund\\\",\\\"amc_name\\\":\\\"Example AMC\\\",\\\"amc_monthly_portfolio_disclosure\\\":\\\"\\\"}]"])</script>';
  const rows = parseAmfiRegistryHtml(html);
  assert.deepEqual(rows,[{mfId:9,mfName:'Example Mutual Fund',amcName:'Example AMC',monthlyUrl:''}]);
});

test('portfolio source URLs reject local and private-network destinations', () => {
  assert.throws(()=>assertPublicUrl('http://127.0.0.1/private.xlsx'),/Unsafe/);
  assert.throws(()=>assertPublicUrl('http://172.20.1.4/private.xlsx'),/Unsafe/);
  assert.throws(()=>assertPublicUrl('javascript:alert(1)'),/Unsafe/);
  assert.equal(assertPublicUrl('https://www.amfiindia.com/disclosure.xlsx').protocol,'https:');
});

test('scheme search keeps Regular and Direct plans visible together', () => {
  const rows = [
    ...Array.from({length:30},(_,i)=>({schemeCode:1000+i,schemeName:`Bandhan Example Fund ${i} - Direct Plan - Growth`})),
    ...Array.from({length:6},(_,i)=>({schemeCode:2000+i,schemeName:`Bandhan Example Fund ${i} - Regular Plan - Growth`})),
  ];
  const balanced = balancePlanVariants(rows,10);
  assert.equal(balanced[0].planType,'Regular');
  assert.ok(balanced.some(x=>x.planType==='Direct'));
  assert.ok(balanced.some(x=>x.planType==='Regular'));
});

test('disclosure crawler follows relevant same-AMC pages only', () => {
  const html = '<a href="/downloads/monthly-portfolio">Monthly portfolio</a><a href="https://evil.example/file.xlsx">Other site</a><a href="/about">About</a>';
  assert.deepEqual(discoverDisclosurePages(html,'https://fund.example/disclosures','2026-08-31'),['https://fund.example/downloads/monthly-portfolio']);
});

test('automatic portfolio import rejects the wrong year even when the month matches', () => {
  assert.equal(linkMatchesTargetMonth('https://fund.example/Monthly-Portfolio-31-August-2026.xlsx','2026-08-31'),true);
  assert.equal(linkMatchesTargetMonth('https://fund.example/Monthly-Portfolio-31-August-2025.xlsx','2026-08-31'),false);
  assert.equal(linkMatchesTargetMonth('https://fund.example/portfolio_20260831.xlsx','2026-08-31'),true);
});

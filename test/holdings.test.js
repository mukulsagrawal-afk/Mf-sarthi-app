const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const XLSX = require('xlsx');

process.env.DATA_DIR = path.join(process.cwd(), '.test-data', `holdings-${process.pid}`);
const db = require('../server/db');
const { parseWorkbook, normalizeSchemeName } = require('../server/utils/portfolioParser');
const { importPortfolioBuffer, getSchemeHoldings, lookThrough, parseAmfiRegistryHtml, assertPublicUrl } = require('../server/utils/portfolioService');

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
  const amc = db.prepare("SELECT mf_id FROM mf_amc_sources WHERE mf_name LIKE 'HDFC%' LIMIT 1").get();
  assert.ok(amc);
  const insert = db.prepare('INSERT OR REPLACE INTO mf_scheme_index (scheme_code,scheme_name) VALUES (?,?)');
  insert.run(900001,'HDFC Large Cap Fund - Direct Plan - Growth Option');
  insert.run(900002,'HDFC Large Cap Fund - Regular Plan - IDCW Payout');
  const result = importPortfolioBuffer({buffer:fixtureWorkbook(),filename:'hdfc-portfolio.xlsx',mfId:amc.mf_id,disclosureDate:'2026-08-31',sourceUrl:'https://example.com/hdfc.xlsx'});
  assert.equal(result.schemeCount,1);
  assert.equal(result.holdingCount,3);
  assert.equal(result.mappedPlans,2);
  assert.equal(getSchemeHoldings(900001).holdings.length,3);
  assert.equal(getSchemeHoldings(900002).disclosureDate,'2026-08-31');
  const exposure = lookThrough([{schemeCode:900001,currentValue:100000},{schemeCode:900002,currentValue:50000}]);
  assert.equal(exposure.coveredValue,150000);
  assert.equal(Math.round(exposure.exposures[0].amount),12375);
  const duplicate = importPortfolioBuffer({buffer:fixtureWorkbook(),filename:'again.xlsx',mfId:amc.mf_id,disclosureDate:'2026-08-31'});
  assert.equal(duplicate.duplicate,true);
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

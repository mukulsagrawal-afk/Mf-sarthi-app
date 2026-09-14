const test = require('node:test');
const assert = require('node:assert/strict');
const { bestMatches } = require('../server/utils/casMatch');
const schemes = [
  {schemeCode:1,schemeName:'ICICI Prudential Large Cap Fund - Direct Plan - Growth'},
  {schemeCode:2,schemeName:'ICICI Prudential Large Cap Fund - Regular Plan - Growth'},
  {schemeCode:3,schemeName:'ICICI Prudential Large & Mid Cap Fund - Direct Plan - Growth'},
];
test('explicit CAS plan selects the same plan and same category', () => {
  const matches = bestMatches('ICICI Prudential Large Cap Fund - Regular Plan - Growth',schemes,['ICICI Prudential']);
  assert.equal(matches[0].schemeCode,2);
  assert.ok(matches[0].confidence - matches[1].confidence >= 7);
});
test('missing plan is ambiguous and must be confirmed by the advisor', () => {
  const matches = bestMatches('ICICI Prudential Large Cap Fund',schemes,['ICICI Prudential']);
  assert.deepEqual(new Set(matches.slice(0,2).map(m=>m.schemeCode)),new Set([1,2]));
  assert.equal(matches[0].confidence,matches[1].confidence);
});

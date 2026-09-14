// MFapi scheme codes checked against its public scheme directory in September 2026.
// Curated breadth, not an AUM or performance league table. Metadata is validated at
// report time because names and categories can change.
const groups = {
  'Large Cap': [120586,119018,119598,118479,150797,118632,118825,120465,120152,119250,119528,120656,118269,118531,118617,119160,120392,120030,150440,148507],
  'Mid Cap': [118989,120505,118533,118668,119071,119178,119581,119620,119716,119775,120381,120403,118872,119392],
  'Small Cap': [125497,118778,118525,119212,119556,120077,120164,120591,120828,125354,130503,145137,145206,146130,147946],
  'Flexi Cap': [122639,118955,118275,118424,118535,119076,119718,120046,120166,120564,120662,120843,129046,140353,141925],
};
for (const [category, codes] of Object.entries(groups)) groups[category] = codes.map(schemeCode => ({ schemeCode }));
function normalizeCategory(rawCategory) {
  const c = String(rawCategory || '').toLowerCase();
  if (/large\s*(?:&|and)\s*mid|multi\s*cap/.test(c)) return null;
  if (/large\s*cap/.test(c)) return 'Large Cap';
  if (/mid\s*cap|midcap/.test(c)) return 'Mid Cap';
  if (/small\s*cap|smallcap/.test(c)) return 'Small Cap';
  if (/flexi\s*cap|flexicap/.test(c)) return 'Flexi Cap';
  return null;
}
function isComparable(meta, category) {
  const name = String(meta?.scheme_name || '');
  return normalizeCategory(meta?.scheme_category) === category && /direct/i.test(name) && /growth/i.test(name) && !/idcw|dividend|bonus|segregated|series\s*\d/i.test(name);
}
module.exports = { ...groups, normalizeCategory, isComparable };

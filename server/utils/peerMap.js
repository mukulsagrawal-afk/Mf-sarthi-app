// Curated peer groups for the "compare against category" feature.
//
// MFAPI has no "list all schemes in category X" endpoint - scheme_category only comes
// back when you fetch an individual scheme. Building a live, complete category index
// would mean crawling all ~10-16k schemes, which is heavy and unnecessary for what an
// MFD actually needs: a handful of well-known, large, comparable peers to benchmark
// against, not an exhaustive list. So this is a small, hand-curated set of real,
// verified scheme codes (Direct Plan - Growth) per category, grown over time.
//
// category here is our own normalized label - matched against MFAPI's scheme_category
// string with a loose "contains" check in mf.js, since MFAPI's own category strings are
// inconsistent in wording (e.g. "Equity Scheme - Large Cap Fund" vs "Large Cap Fund").

module.exports = {
  'Large Cap': [
    { schemeCode: 120586, schemeName: 'ICICI Prudential Large Cap Fund - Direct Plan - Growth' },
    { schemeCode: 119018, schemeName: 'HDFC Large Cap Fund - Direct Plan - Growth Option' },
    { schemeCode: 118632, schemeName: 'Nippon India Large Cap Fund - Direct Plan - Growth Option' },
  ],
  'Mid Cap': [
    { schemeCode: 118989, schemeName: 'HDFC Mid Cap Fund - Direct Plan - Growth Option' },
    { schemeCode: 120505, schemeName: 'Axis Midcap Fund - Direct Plan - Growth Option' },
  ],
  'Small Cap': [
    { schemeCode: 125497, schemeName: 'SBI Small Cap Fund - Direct Plan - Growth' },
    { schemeCode: 118778, schemeName: 'Nippon India Small Cap Fund - Direct Plan - Growth Option' },
  ],
  'Flexi Cap': [
    { schemeCode: 122639, schemeName: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth' },
    { schemeCode: 118955, schemeName: 'HDFC Flexi Cap Fund - Direct Plan - Growth Option' },
  ],
};

// Loose match from MFAPI's raw scheme_category string to our normalized labels above.
function normalizeCategory(rawCategory) {
  const c = String(rawCategory || '').toLowerCase();
  if (c.includes('large') && c.includes('mid')) return null; // large & mid cap - no curated peer group yet, avoid a misleading comparison
  if (c.includes('large cap')) return 'Large Cap';
  if (c.includes('mid cap') || c.includes('midcap')) return 'Mid Cap';
  if (c.includes('small cap') || c.includes('smallcap')) return 'Small Cap';
  if (c.includes('flexi cap') || c.includes('flexicap') || c.includes('multi cap') || c.includes('multicap')) return 'Flexi Cap';
  return null;
}

module.exports.normalizeCategory = normalizeCategory;

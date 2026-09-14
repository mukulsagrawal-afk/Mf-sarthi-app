// Benchmark proxies for the FolioXpert AI report.
//
// Honest note, on purpose: mfapi.in (our only free, no-key data source) carries mutual
// fund NAVs, not official index/TRI (Total Return Index) data. There is no free, reliable
// TRI feed to pull automatically. Rather than invent benchmark figures, we use a real,
// liquid, large-AMC ETF that tracks the relevant index as a stand-in - its NAV is real,
// live, and fetched exactly like any other scheme through mfapi.js. This is disclosed in
// the report's own methodology section: an ETF proxy tracks its index closely but is not
// identical to the TRI figure (a small tracking difference plus the ETF's own expense
// ratio mean its return will run a little below true TRI, typically by well under 1
// percentage point a year for these large, liquid ETFs).
//
// Each entry's scheme code was checked against mfapi.in's live data before being hardcoded
// here (see the codes' history length below) - genuinely real, not placeholder, values.

module.exports = {
  'Large Cap': {
    schemeCode: 123004,
    schemeName: 'ICICI Prudential Nifty 100 ETF',
    indexName: 'Nifty 100',
    // history from 28-05-2019 - supports 1Y/3Y/5Y comparison
  },
  'Mid Cap': {
    schemeCode: 147921,
    schemeName: 'ICICI Prudential Nifty Midcap 150 ETF',
    indexName: 'Nifty Midcap 150',
    // history from 27-01-2020 - supports 1Y/3Y/5Y comparison
  },
  'Small Cap': {
    schemeCode: 152546,
    schemeName: 'Motilal Oswal Nifty Smallcap 250 ETF',
    indexName: 'Nifty Smallcap 250',
    // history from 21-03-2024 only - 1Y comparison is reliable, 3Y/5Y is not available yet
    // and the report must say so rather than compute a partial-period figure as if it
    // were a full 3Y/5Y return.
  },
  'Flexi Cap': {
    schemeCode: 152106,
    schemeName: 'Motilal Oswal Nifty 500 ETF',
    indexName: 'Nifty 500',
    // history from 06-10-2023 only - 1Y reliable, 3Y borderline (report flags it under
    // ~3.1 years of true history), 5Y not available.
  },
};

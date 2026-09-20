CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS amc_sources (
  mf_id INTEGER PRIMARY KEY,
  mf_name TEXT NOT NULL,
  amc_name TEXT,
  monthly_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mf_id INTEGER REFERENCES amc_sources(mf_id) ON DELETE SET NULL,
  source_url TEXT,
  source_filename TEXT NOT NULL,
  source_sha256 TEXT NOT NULL UNIQUE,
  disclosure_date TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid',
  scheme_count INTEGER NOT NULL DEFAULT 0,
  holding_count INTEGER NOT NULL DEFAULT 0,
  warning_json TEXT NOT NULL DEFAULT '[]',
  stored_path TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_schemes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mf_id INTEGER REFERENCES amc_sources(mf_id) ON DELETE SET NULL,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mf_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS scheme_map (
  scheme_code INTEGER PRIMARY KEY,
  scheme_name TEXT NOT NULL,
  portfolio_scheme_id INTEGER NOT NULL REFERENCES portfolio_schemes(id) ON DELETE CASCADE,
  match_method TEXT NOT NULL,
  confidence REAL NOT NULL,
  mapped_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_scheme_id INTEGER NOT NULL REFERENCES portfolio_schemes(id) ON DELETE CASCADE,
  import_id INTEGER NOT NULL REFERENCES portfolio_imports(id) ON DELETE CASCADE,
  disclosure_date TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  instrument_name TEXT NOT NULL,
  isin TEXT,
  asset_type TEXT,
  sector TEXT,
  issuer TEXT,
  rating TEXT,
  maturity_date TEXT,
  quantity REAL,
  market_value REAL,
  pct_nav REAL,
  UNIQUE(portfolio_scheme_id, import_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_scheme_name ON portfolio_schemes(normalized_name);
CREATE INDEX IF NOT EXISTS idx_holdings_scheme_date ON holdings(portfolio_scheme_id, disclosure_date DESC);
CREATE INDEX IF NOT EXISTS idx_holdings_isin ON holdings(isin);
CREATE INDEX IF NOT EXISTS idx_imports_date ON portfolio_imports(disclosure_date DESC);

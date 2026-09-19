-- MF Sarthi database schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  arn TEXT,
  city TEXT,
  role TEXT NOT NULL DEFAULT 'owner',       -- owner | associate
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Client',       -- Client | Prospect
  mobile TEXT,
  email TEXT,
  city TEXT,
  pan TEXT,                                  -- stored encrypted (see crypto.js)
  aum REAL DEFAULT 0,                        -- last known AUM, in rupees
  sip_amount REAL DEFAULT 0,                 -- monthly SIP total, in rupees
  last_review_date TEXT,
  next_review_date TEXT,
  next_followup_date TEXT,
  rm TEXT,                                   -- relationship manager name
  status TEXT DEFAULT 'Active',              -- Active | VIP | Review Overdue | SIP Stopped | KYC Pending
  source TEXT,                               -- how this record was created: manual | statement_import
  age INTEGER,
  gender TEXT,
  occupation TEXT,
  schemes INTEGER DEFAULT 0,
  risk_profile TEXT,
  vip INTEGER DEFAULT 0,
  kyc_pending INTEGER DEFAULT 0,
  sip_stopped INTEGER DEFAULT 0,
  goals_json TEXT DEFAULT '[]',
  timeline_json TEXT DEFAULT '[]',
  tasks_json TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mobile TEXT,
  email TEXT,
  city TEXT,
  stage TEXT NOT NULL DEFAULT 'New Lead',    -- New Lead | Contacted | Meeting | Proposal | Converted | Lost
  source TEXT,
  est_investment REAL DEFAULT 0,             -- rupees
  interest TEXT,
  next_followup_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  type TEXT DEFAULT 'Portfolio Review',
  scheduled_at TEXT NOT NULL,                 -- ISO datetime
  status TEXT NOT NULL DEFAULT 'Upcoming',    -- Upcoming | Done | Cancelled
  reminder_email_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  due_date TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  reminder_email_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  rows_total INTEGER DEFAULT 0,
  rows_matched INTEGER DEFAULT 0,
  rows_created INTEGER DEFAULT 0,
  rows_failed INTEGER DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mf_nav_cache (
  scheme_code INTEGER PRIMARY KEY,
  scheme_name TEXT,
  fund_house TEXT,
  scheme_category TEXT,
  isin_growth TEXT,
  nav_json TEXT NOT NULL,       -- JSON array of {date, nav}, oldest first
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mf_scheme_index (
  scheme_code INTEGER PRIMARY KEY,
  scheme_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mf_scheme_index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at TEXT
);

-- Monthly scheme-portfolio disclosures. A portfolio is shared by every NAV plan
-- variant (Direct/Regular, Growth/IDCW); mf_portfolio_scheme_map connects those
-- searchable NAV scheme codes to the underlying disclosed portfolio.
CREATE TABLE IF NOT EXISTS mf_amc_sources (
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

CREATE TABLE IF NOT EXISTS mf_portfolio_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mf_id INTEGER REFERENCES mf_amc_sources(mf_id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS mf_portfolio_schemes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mf_id INTEGER REFERENCES mf_amc_sources(mf_id) ON DELETE SET NULL,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mf_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS mf_portfolio_scheme_map (
  scheme_code INTEGER PRIMARY KEY REFERENCES mf_scheme_index(scheme_code) ON DELETE CASCADE,
  portfolio_scheme_id INTEGER NOT NULL REFERENCES mf_portfolio_schemes(id) ON DELETE CASCADE,
  match_method TEXT NOT NULL,
  confidence REAL NOT NULL,
  mapped_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mf_portfolio_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_scheme_id INTEGER NOT NULL REFERENCES mf_portfolio_schemes(id) ON DELETE CASCADE,
  import_id INTEGER NOT NULL REFERENCES mf_portfolio_imports(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_time ON meetings(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(user_id);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(due_date);
CREATE INDEX IF NOT EXISTS idx_notes_client ON notes(client_id);
CREATE INDEX IF NOT EXISTS idx_mf_scheme_index_name ON mf_scheme_index(scheme_name);
CREATE INDEX IF NOT EXISTS idx_portfolio_scheme_name ON mf_portfolio_schemes(normalized_name);
CREATE INDEX IF NOT EXISTS idx_portfolio_holdings_scheme_date ON mf_portfolio_holdings(portfolio_scheme_id, disclosure_date DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_holdings_isin ON mf_portfolio_holdings(isin);
CREATE INDEX IF NOT EXISTS idx_portfolio_imports_date ON mf_portfolio_imports(disclosure_date DESC);

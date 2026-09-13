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

CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_time ON meetings(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(user_id);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(due_date);
CREATE INDEX IF NOT EXISTS idx_notes_client ON notes(client_id);

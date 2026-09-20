const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.HOLDINGS_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'holdings.db');
const SEED_PATH = path.join(__dirname, '..', 'seed', 'holdings-2026-08-31.db');

// A fresh deployment starts from the verified August 2026 snapshot. The writable
// copy lives on Render's persistent disk; monthly admin imports never alter the seed.
if (!fs.existsSync(DB_PATH) && fs.existsSync(SEED_PATH)) fs.copyFileSync(SEED_PATH, DB_PATH);

const holdingsDb = new Database(DB_PATH);
holdingsDb.pragma('journal_mode = WAL');
holdingsDb.pragma('foreign_keys = ON');
holdingsDb.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

module.exports = holdingsDb;
module.exports.DB_PATH = DB_PATH;

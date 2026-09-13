// Daily backup of the SQLite database file. Financial client data lives in one file —
// losing it with no backup would be a business-ending mistake, so this runs automatically
// and needs no one to remember to do it manually.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'mfsarthi.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_DAYS = 14;

function runBackup() {
  if (!fs.existsSync(DB_PATH)) return null;
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest = path.join(BACKUP_DIR, `mfsarthi-${stamp}.db`);
  fs.copyFileSync(DB_PATH, dest);

  // prune backups older than KEEP_DAYS
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const full = path.join(BACKUP_DIR, f);
    const stat = fs.statSync(full);
    if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
  }
  return dest;
}

module.exports = { runBackup };

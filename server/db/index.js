const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// On most hosts (Render's free tier included) the app's own folder is wiped on every
// deploy/restart. If DATA_DIR wasn't explicitly pointed at a mounted persistent disk,
// warn loudly now rather than let someone discover it the day their client list vanishes.
if (!process.env.DATA_DIR) {
  console.warn(
    '\nWARNING: DATA_DIR is not set, so the database is being stored inside the app\'s ' +
    'own folder. On most hosting platforms (including Render\'s free plan) this folder ' +
    'is wiped on every redeploy or restart - your client data can be lost.\n' +
    'Fix: attach a persistent disk on your hosting platform, then set DATA_DIR to its ' +
    'mount path (e.g. Render: add a Disk mounted at /var/data, set DATA_DIR=/var/data).\n'
  );
}

const DB_PATH = path.join(DATA_DIR, 'mfsarthi.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // safer + faster under concurrent access
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;

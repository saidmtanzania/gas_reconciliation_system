// SQLite schema + connection setup (better-sqlite3, synchronous, file-based)
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'reconciliation.db');
require('fs').mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  mofat_filename TEXT,
  lake_filename TEXT,
  gas_price REAL NOT NULL DEFAULT 3250,
  bus_capacity REAL NOT NULL DEFAULT 200,
  variance_tol REAL NOT NULL DEFAULT 2,
  dup_threshold REAL NOT NULL DEFAULT 4,
  planned_buses TEXT NOT NULL DEFAULT '',
  backup_buses TEXT NOT NULL DEFAULT '',
  reserve_buses TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS mofat_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  date TEXT, bus TEXT, bus_display TEXT, driver TEXT, km REAL, gas REAL,
  time_in TEXT, time_out TEXT, shift TEXT, category TEXT, src_row INTEGER, matched INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lake_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  date TEXT, bus TEXT, bus_display TEXT, recipient TEXT, pod TEXT, station TEXT, gas REAL,
  shift TEXT, category TEXT, src_row INTEGER, matched INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  date TEXT, bus TEXT, bus_display TEXT, category TEXT, shift TEXT,
  mofat_kg REAL, lake_kg REAL, variance REAL, abs_variance REAL,
  mofat_row INTEGER, lake_row INTEGER, pod TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  ckey TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  UNIQUE(batch_id, ckey)
);

-- Persistent fleet master registry: the single source of truth for bus categorization.
CREATE TABLE IF NOT EXISTS fleet_master (
  bus TEXT PRIMARY KEY,
  bus_display TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('Planned','Backup','Reserve'))
);

CREATE INDEX IF NOT EXISTS idx_mofat_batch ON mofat_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_lake_batch ON lake_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_matches_batch ON matches(batch_id);
`);

module.exports = db;

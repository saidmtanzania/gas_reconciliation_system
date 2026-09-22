require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set to connect to PostgreSQL.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schemaSql = `
CREATE TABLE IF NOT EXISTS batches (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mofat_filename TEXT,
  lake_filename TEXT,
  gas_price DOUBLE PRECISION NOT NULL DEFAULT 3250,
  bus_capacity DOUBLE PRECISION NOT NULL DEFAULT 200,
  variance_tol DOUBLE PRECISION NOT NULL DEFAULT 2,
  dup_threshold DOUBLE PRECISION NOT NULL DEFAULT 4,
  planned_buses TEXT NOT NULL DEFAULT '',
  backup_buses TEXT NOT NULL DEFAULT '',
  reserve_buses TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS mofat_records (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  date TEXT, bus TEXT, bus_display TEXT, driver TEXT, km DOUBLE PRECISION, gas DOUBLE PRECISION,
  time_in TEXT, time_out TEXT, shift TEXT, category TEXT, src_row INTEGER, matched INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lake_records (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  date TEXT, bus TEXT, bus_display TEXT, recipient TEXT, pod TEXT, station TEXT, gas DOUBLE PRECISION,
  shift TEXT, category TEXT, src_row INTEGER, matched INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS matches (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  date TEXT, bus TEXT, bus_display TEXT, category TEXT, shift TEXT,
  mofat_kg DOUBLE PRECISION, lake_kg DOUBLE PRECISION, variance DOUBLE PRECISION, abs_variance DOUBLE PRECISION,
  mofat_row INTEGER, lake_row INTEGER, pod TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  ckey TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', UNIQUE(batch_id, ckey)
);
CREATE TABLE IF NOT EXISTS fleet_master (
  bus TEXT PRIMARY KEY, bus_display TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('Planned','Backup','Reserve'))
);
CREATE INDEX IF NOT EXISTS idx_mofat_batch ON mofat_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_lake_batch ON lake_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_matches_batch ON matches(batch_id);
`;

const ready = pool.query(schemaSql).then(() => undefined);

async function query(text, params) {
  await ready;
  return pool.query(text, params);
}

async function withTransaction(callback) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, ready, query, withTransaction };

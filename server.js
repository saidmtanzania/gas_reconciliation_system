const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('./db');
const parser = require('./parser');
const { computeResults } = require('./calc');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_PLANNED = `T 603 ENQ\nT 608 ENQ\nT 609 ENQ\nT 610 ENQ\nT 612 ENS\nT 614 ENQ\nT 614 ENS\nT 615 ENQ\nT 617 ENQ\nT 619 ENQ\nT 619 ENS\nT 620 ENS\nT 621 ENS\nT 624 ENS\nT 672 ENS\nT 636 ENS\nT 643 ENS\nT 645 ENS\nT 649 ENS\nT 650 ENS\nT 660 ENS\nT 662 ENS\nT 664 ENS\nT 669 ENS\nT 674 ENS\nT 686 ENS\nT 689 ENS\nT 694ENS\nT 695 ENS\nT 717 ENS\nT 719 ENS\nT 720 ENS\nT 721 ENS\nT 725 ENS\nT 836 ENT\nT 838 ENT\nT 843 ENT\nT 845 ENT\nT 858 ENT\nT 897 ENT\nT 911 ENT\nT 914 ENT\nT 924 ENT\nT 919 ENT\nT 920 ENT\nT 921 ENT\nT 922 ENT\nT 925 ENT\nT 926 ENT\nT 938 ENT`;
const DEFAULT_BACKUP = `T 639 ENS\nT 912 ENT\nT 657 ENS\nT 658 ENS\nT 667 ENS`;
const DEFAULT_RESERVE = `T 893 ENT\nT 894 ENT\nT 707 ENS\nT 712 ENS\nT 633 ENS\nT 710 ENS\nT 701 ENS\nT 851 ENS\nT 900 ENT\nT 723 ENS`;

async function seedFleetMasterIfEmpty() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM fleet_master');
  if (rows[0].c > 0) return;
  await db.withTransaction(async client => {
    for (const [text, category] of [[DEFAULT_PLANNED, 'Planned'], [DEFAULT_BACKUP, 'Backup'], [DEFAULT_RESERVE, 'Reserve']]) {
      for (const bus of text.split(/\n|,|;/).map(parser.normBus).filter(Boolean)) {
        await client.query('INSERT INTO fleet_master (bus,bus_display,category) VALUES ($1,$2,$3) ON CONFLICT(bus) DO NOTHING', [bus, parser.fmtBus(bus), category]);
      }
    }
  });
}

const startup = db.ready.then(seedFleetMasterIfEmpty);
app.use(async (req, res, next) => { try { await startup; next(); } catch (error) { next(error); } });

async function loadFleetMaster() {
  const { rows: entries } = await db.query('SELECT bus,bus_display AS "busDisplay",category FROM fleet_master ORDER BY category,bus');
  const map = parser.fleetMapFromEntries(entries);
  const numberIndex = parser.buildNumberIndex(map);
  const textByCategory = { Planned: [], Backup: [], Reserve: [] };
  entries.forEach(entry => textByCategory[entry.category]?.push(entry.busDisplay));
  return { map, numberIndex, textByCategory };
}

async function insertRows(client, table, columns, rows, toValues) {
  const chunkSize = 500;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, rowIndex) => {
      const rowValues = toValues(row);
      values.push(...rowValues);
      return `(${columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(',')})`;
    }).join(',');
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, values);
  }
}

async function reprocessBatch(id) {
  const { rows: batches } = await db.query('SELECT * FROM batches WHERE id=$1', [id]);
  if (!batches[0]) return null;
  const { rows: mofat } = await db.query('SELECT id,date,bus,bus_display AS "busDisplay",driver,km,gas,time_in AS "timeIn",time_out AS "timeOut",shift,src_row AS row FROM mofat_records WHERE batch_id=$1', [id]);
  const { rows: lake } = await db.query('SELECT id,date,bus,bus_display AS "busDisplay",recipient,pod,station,gas,src_row AS row FROM lake_records WHERE batch_id=$1', [id]);
  const { map, numberIndex, textByCategory } = await loadFleetMaster();
  parser.enrichFleet(mofat, map, numberIndex); parser.enrichFleet(lake, map, numberIndex);
  const { matches } = parser.matchRecords(mofat, lake);
  await db.withTransaction(async client => {
    for (const row of mofat) await client.query('UPDATE mofat_records SET category=$1,matched=$2 WHERE id=$3', [row.category, row.matched ? 1 : 0, row.id]);
    for (const row of lake) await client.query('UPDATE lake_records SET category=$1,matched=$2,shift=$3 WHERE id=$4', [row.category, row.matched ? 1 : 0, row.shift, row.id]);
    await client.query('DELETE FROM matches WHERE batch_id=$1', [id]);
    for (const row of matches) await client.query('INSERT INTO matches (batch_id,date,bus,bus_display,category,shift,mofat_kg,lake_kg,variance,abs_variance,mofat_row,lake_row,pod) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [id, row.date, row.bus, row.busDisplay, row.category, row.shift, row.mofatKg, row.lakeKg, row.variance, row.absVariance, row.mofatRow, row.lakeRow, row.pod]);
    await client.query('UPDATE batches SET planned_buses=$1,backup_buses=$2,reserve_buses=$3 WHERE id=$4', [textByCategory.Planned.join('\n'), textByCategory.Backup.join('\n'), textByCategory.Reserve.join('\n'), id]);
  });
  return id;
}

async function getBatchPayload(id) {
  const { rows: batches } = await db.query('SELECT * FROM batches WHERE id=$1', [id]);
  const batch = batches[0];
  if (!batch) return null;
  const { rows: mofat } = await db.query('SELECT date,bus,bus_display AS "busDisplay",driver,km,gas,time_in AS "timeIn",time_out AS "timeOut",shift,category,src_row AS row,matched FROM mofat_records WHERE batch_id=$1', [id]);
  const { rows: lake } = await db.query('SELECT date,bus,bus_display AS "busDisplay",recipient,pod,station,gas,shift,category,src_row AS row,matched FROM lake_records WHERE batch_id=$1', [id]);
  const { rows: matches } = await db.query('SELECT date,bus,bus_display AS "busDisplay",category,shift,mofat_kg AS "mofatKg",lake_kg AS "lakeKg",variance,abs_variance AS "absVariance",mofat_row AS "mofatRow",lake_row AS "lakeRow",pod FROM matches WHERE batch_id=$1', [id]);
  const { map, numberIndex } = await loadFleetMaster();
  parser.enrichFleet(mofat, map, numberIndex); parser.enrichFleet(lake, map, numberIndex);
  const { rows: commentRows } = await db.query('SELECT ckey,text FROM comments WHERE batch_id=$1', [id]);
  const comments = {}; commentRows.forEach(comment => { comments[comment.ckey] = comment.text; });
  const config = { gasPrice: batch.gas_price, busCapacity: batch.bus_capacity, varianceTol: batch.variance_tol, dupThreshold: batch.dup_threshold, plannedBuses: batch.planned_buses, backupBuses: batch.backup_buses, reserveBuses: batch.reserve_buses };
  const results = computeResults({ mofat, lake, matches, unmatchedMofat: mofat.filter(row => !row.matched), unmatchedLake: lake.filter(row => !row.matched), config, comments });
  return { batchId: id, name: batch.name, createdAt: batch.created_at, config, ...results };
}

app.post('/api/reconcile', upload.fields([{ name: 'mofatFile', maxCount: 1 }, { name: 'lakeFile', maxCount: 1 }]), async (req, res) => {
  try {
    const mofatFile = req.files?.mofatFile?.[0], lakeFile = req.files?.lakeFile?.[0];
    if (!mofatFile || !lakeFile) return res.status(400).json({ error: 'Both mofatFile and lakeFile are required.' });
    const gasPrice = req.body.gasPrice || 3250, busCapacity = req.body.busCapacity || 200, varianceTol = req.body.varianceTol || 2, dupThreshold = req.body.dupThreshold || 4;
    const name = req.body.name || `Batch ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
    const mofatRows = parser.parseMofatRows(parser.sheetRows(parser.readWorkbook(mofatFile.buffer)));
    const lakeRows = parser.parseLakeRows(parser.sheetRows(parser.readWorkbook(lakeFile.buffer)));
    if (!mofatRows.length) return res.status(400).json({ error: 'No valid Mofat records found. Check required columns (Date, Bus, Gas).' });
    if (!lakeRows.length) return res.status(400).json({ error: 'No valid Lake Gas records found. Check required columns (Date, Vehicle, Total KG).' });
    const { map, numberIndex, textByCategory } = await loadFleetMaster();
    parser.enrichFleet(mofatRows, map, numberIndex); parser.enrichFleet(lakeRows, map, numberIndex);
    const { matches } = parser.matchRecords(mofatRows, lakeRows);
    const batchId = await db.withTransaction(async client => {
      const inserted = await client.query('INSERT INTO batches (name,mofat_filename,lake_filename,gas_price,bus_capacity,variance_tol,dup_threshold,planned_buses,backup_buses,reserve_buses) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [name, mofatFile.originalname, lakeFile.originalname, +gasPrice, +busCapacity, +varianceTol, +dupThreshold, textByCategory.Planned.join('\n'), textByCategory.Backup.join('\n'), textByCategory.Reserve.join('\n')]);
      const id = inserted.rows[0].id;
      await insertRows(client, 'mofat_records', ['batch_id', 'date', 'bus', 'bus_display', 'driver', 'km', 'gas', 'time_in', 'time_out', 'shift', 'category', 'src_row', 'matched'], mofatRows, row => [id, row.date, row.bus, row.busDisplay, row.driver, row.km, row.gas, row.timeIn, row.timeOut, row.shift, row.category, row.row, row.matched ? 1 : 0]);
      await insertRows(client, 'lake_records', ['batch_id', 'date', 'bus', 'bus_display', 'recipient', 'pod', 'station', 'gas', 'shift', 'category', 'src_row', 'matched'], lakeRows, row => [id, row.date, row.bus, row.busDisplay, row.recipient, row.pod, row.station, row.gas, row.shift, row.category, row.row, row.matched ? 1 : 0]);
      await insertRows(client, 'matches', ['batch_id', 'date', 'bus', 'bus_display', 'category', 'shift', 'mofat_kg', 'lake_kg', 'variance', 'abs_variance', 'mofat_row', 'lake_row', 'pod'], matches, row => [id, row.date, row.bus, row.busDisplay, row.category, row.shift, row.mofatKg, row.lakeKg, row.variance, row.absVariance, row.mofatRow, row.lakeRow, row.pod]);
      return id;
    });
    res.json(await getBatchPayload(batchId));
  } catch (error) { console.error(error); res.status(500).json({ error: 'Reconciliation failed: ' + error.message }); }
});

app.get('/api/fleet', async (req, res, next) => { try { res.json((await db.query('SELECT bus,bus_display AS "busDisplay",category FROM fleet_master ORDER BY category,bus_display')).rows); } catch (error) { next(error); } });
app.post('/api/fleet', async (req, res, next) => { try {
  const bus = parser.normBus(req.body.bus), category = req.body.category;
  if (!bus) return res.status(400).json({ error: 'A valid bus plate is required.' });
  if (!['Planned', 'Backup', 'Reserve'].includes(category)) return res.status(400).json({ error: 'Category must be Planned, Backup or Reserve.' });
  await db.query('INSERT INTO fleet_master (bus,bus_display,category) VALUES ($1,$2,$3) ON CONFLICT(bus) DO UPDATE SET category=EXCLUDED.category,bus_display=EXCLUDED.bus_display', [bus, parser.fmtBus(bus), category]);
  res.json({ ok: true, bus, busDisplay: parser.fmtBus(bus), category });
} catch (error) { next(error); } });
app.post('/api/fleet/bulk', async (req, res, next) => { try {
  const category = req.body.category;
  if (!['Planned', 'Backup', 'Reserve'].includes(category)) return res.status(400).json({ error: 'Category must be Planned, Backup or Reserve.' });
  const buses = (req.body.text || '').split(/\n|,|;/).map(parser.normBus).filter(Boolean);
  await db.withTransaction(async client => { for (const bus of buses) await client.query('INSERT INTO fleet_master (bus,bus_display,category) VALUES ($1,$2,$3) ON CONFLICT(bus) DO UPDATE SET category=EXCLUDED.category,bus_display=EXCLUDED.bus_display', [bus, parser.fmtBus(bus), category]); });
  res.json({ ok: true, added: buses.length });
} catch (error) { next(error); } });
app.delete('/api/fleet/:bus', async (req, res, next) => { try { await db.query('DELETE FROM fleet_master WHERE bus=$1', [parser.normBus(req.params.bus)]); res.json({ ok: true }); } catch (error) { next(error); } });
app.get('/api/batches', async (req, res, next) => { try { res.json((await db.query('SELECT id,name,created_at,mofat_filename,lake_filename FROM batches ORDER BY id DESC')).rows); } catch (error) { next(error); } });
app.get('/api/batches/:id', async (req, res, next) => { try { const payload = await getBatchPayload(+req.params.id); if (!payload) return res.status(404).json({ error: 'Batch not found' }); res.json(payload); } catch (error) { next(error); } });
app.post('/api/batches/:id/reprocess', async (req, res, next) => { try { const id = await reprocessBatch(+req.params.id); if (!id) return res.status(404).json({ error: 'Batch not found' }); res.json(await getBatchPayload(id)); } catch (error) { next(error); } });
app.post('/api/batches/:id/accept-all-suggestions', async (req, res, next) => { try {
  const id = +req.params.id, payload = await getBatchPayload(id); if (!payload) return res.status(404).json({ error: 'Batch not found' });
  const uniqueByBus = new Map(); payload.tables.audits.filter(a => a.type === 'Unauthorized Fueling' && a.suggestedBus).forEach(s => uniqueByBus.set(s.busNorm, s.suggestedCategory));
  await db.withTransaction(async client => { for (const [bus, category] of uniqueByBus) await client.query('INSERT INTO fleet_master (bus,bus_display,category) VALUES ($1,$2,$3) ON CONFLICT(bus) DO UPDATE SET category=EXCLUDED.category,bus_display=EXCLUDED.bus_display', [bus, parser.fmtBus(bus), category]); });
  await reprocessBatch(id); res.json({ applied: uniqueByBus.size, ...(await getBatchPayload(id)) });
} catch (error) { next(error); } });
app.put('/api/batches/:id/comments', async (req, res, next) => { try { const { ckey, text } = req.body; if (!ckey) return res.status(400).json({ error: 'ckey is required' }); await db.query('INSERT INTO comments (batch_id,ckey,text) VALUES ($1,$2,$3) ON CONFLICT(batch_id,ckey) DO UPDATE SET text=EXCLUDED.text', [+req.params.id, ckey, text || '']); res.json({ ok: true }); } catch (error) { next(error); } });
app.delete('/api/batches/:id', async (req, res, next) => { try { await db.query('DELETE FROM batches WHERE id=$1', [+req.params.id]); res.json({ ok: true }); } catch (error) { next(error); } });

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  startup.then(() => app.listen(PORT, () => console.log(`Gas reconciliation system running at http://localhost:${PORT}`))).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = app;

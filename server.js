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

// Seed the persistent fleet master table once, on first run only.
function seedFleetMasterIfEmpty() {
  const count = db.prepare(`SELECT COUNT(*) as c FROM fleet_master`).get().c;
  if (count > 0) return;
  const ins = db.prepare(`INSERT OR IGNORE INTO fleet_master (bus, bus_display, category) VALUES (?,?,?)`);
  const tx = db.transaction(() => {
    function add(text, category) {
      text.split(/\n|,|;/).map(parser.normBus).filter(Boolean).forEach(bus => ins.run(bus, parser.fmtBus(bus), category));
    }
    add(DEFAULT_PLANNED, 'Planned'); add(DEFAULT_BACKUP, 'Backup'); add(DEFAULT_RESERVE, 'Reserve');
  });
  tx();
}
seedFleetMasterIfEmpty();

function loadFleetMaster() {
  const entries = db.prepare(`SELECT bus, bus_display as busDisplay, category FROM fleet_master ORDER BY category, bus`).all();
  const map = parser.fleetMapFromEntries(entries);
  const numberIndex = parser.buildNumberIndex(map);
  const textByCategory = { Planned: [], Backup: [], Reserve: [] };
  entries.forEach(e => textByCategory[e.category]?.push(e.busDisplay));
  return { entries, map, numberIndex, textByCategory };
}

// Recompute + persist a batch's categories/matches from its already-stored records, using the CURRENT fleet master.
function reprocessBatch(id) {
  const batch = db.prepare(`SELECT * FROM batches WHERE id=?`).get(id);
  if (!batch) return null;

  const mofat = db.prepare(`SELECT id,date,bus,bus_display as busDisplay,driver,km,gas,time_in as timeIn,time_out as timeOut,shift,src_row as row FROM mofat_records WHERE batch_id=?`).all(id);
  const lake = db.prepare(`SELECT id,date,bus,bus_display as busDisplay,recipient,pod,station,gas,src_row as row FROM lake_records WHERE batch_id=?`).all(id);

  const { map, numberIndex, textByCategory } = loadFleetMaster();
  parser.enrichFleet(mofat, map, numberIndex); parser.enrichFleet(lake, map, numberIndex);
  const { matches } = parser.matchRecords(mofat, lake);

  const tx = db.transaction(() => {
    const updMofat = db.prepare(`UPDATE mofat_records SET category=?, matched=? WHERE id=?`);
    mofat.forEach(r => updMofat.run(r.category, r.matched ? 1 : 0, r.id));
    const updLake = db.prepare(`UPDATE lake_records SET category=?, matched=?, shift=? WHERE id=?`);
    lake.forEach(r => updLake.run(r.category, r.matched ? 1 : 0, r.shift, r.id));

    db.prepare(`DELETE FROM matches WHERE batch_id=?`).run(id);
    const insMatch = db.prepare(`INSERT INTO matches (batch_id,date,bus,bus_display,category,shift,mofat_kg,lake_kg,variance,abs_variance,mofat_row,lake_row,pod)
      VALUES (@batch_id,@date,@bus,@busDisplay,@category,@shift,@mofatKg,@lakeKg,@variance,@absVariance,@mofatRow,@lakeRow,@pod)`);
    matches.forEach(r => insMatch.run({ ...r, batch_id: id }));

    db.prepare(`UPDATE batches SET planned_buses=?, backup_buses=?, reserve_buses=? WHERE id=?`)
      .run(textByCategory.Planned.join('\n'), textByCategory.Backup.join('\n'), textByCategory.Reserve.join('\n'), id);
  });
  tx();
  return id;
}

// Build the full computed payload for a stored batch (used after both load and reprocess).
function getBatchPayload(id) {
  const batch = db.prepare(`SELECT * FROM batches WHERE id=?`).get(id);
  if (!batch) return null;

  const mofat = db.prepare(`SELECT date,bus,bus_display as busDisplay,driver,km,gas,time_in as timeIn,time_out as timeOut,shift,category,src_row as row,matched FROM mofat_records WHERE batch_id=?`).all(id);
  const lake = db.prepare(`SELECT date,bus,bus_display as busDisplay,recipient,pod,station,gas,shift,category,src_row as row,matched FROM lake_records WHERE batch_id=?`).all(id);
  const matches = db.prepare(`SELECT date,bus,bus_display as busDisplay,category,shift,mofat_kg as mofatKg,lake_kg as lakeKg,variance,abs_variance as absVariance,mofat_row as mofatRow,lake_row as lakeRow,pod FROM matches WHERE batch_id=?`).all(id);
  // Suggestion hints aren't persisted (cheap to recompute) -- re-derive against the CURRENT fleet master on every load.
  const { map, numberIndex } = loadFleetMaster();
  parser.enrichFleet(mofat, map, numberIndex); parser.enrichFleet(lake, map, numberIndex);
  const unmatchedMofat = mofat.filter(r => !r.matched);
  const unmatchedLake = lake.filter(r => !r.matched);
  const comments = {};
  db.prepare(`SELECT ckey, text FROM comments WHERE batch_id=?`).all(id).forEach(c => comments[c.ckey] = c.text);

  const cfg = {
    gasPrice: batch.gas_price, busCapacity: batch.bus_capacity, varianceTol: batch.variance_tol, dupThreshold: batch.dup_threshold,
    plannedBuses: batch.planned_buses, backupBuses: batch.backup_buses, reserveBuses: batch.reserve_buses
  };
  const results = computeResults({ mofat, lake, matches, unmatchedMofat, unmatchedLake, config: cfg, comments });
  return { batchId: id, name: batch.name, createdAt: batch.created_at, config: cfg, ...results };
}

// Run reconciliation for a fresh upload, persist everything as a new batch.
app.post('/api/reconcile', upload.fields([{ name: 'mofatFile', maxCount: 1 }, { name: 'lakeFile', maxCount: 1 }]), (req, res) => {
  try {
    const mofatFile = req.files?.mofatFile?.[0], lakeFile = req.files?.lakeFile?.[0];
    if (!mofatFile || !lakeFile) return res.status(400).json({ error: 'Both mofatFile and lakeFile are required.' });

    const gasPrice = req.body.gasPrice || 3250, busCapacity = req.body.busCapacity || 200;
    const varianceTol = req.body.varianceTol || 2, dupThreshold = req.body.dupThreshold || 4;
    const name = req.body.name || `Batch ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;

    const mofatRows = parser.parseMofatRows(parser.sheetRows(parser.readWorkbook(mofatFile.buffer)));
    const lakeRows = parser.parseLakeRows(parser.sheetRows(parser.readWorkbook(lakeFile.buffer)));
    if (!mofatRows.length) return res.status(400).json({ error: 'No valid Mofat records found. Check required columns (Date, Bus, Gas).' });
    if (!lakeRows.length) return res.status(400).json({ error: 'No valid Lake Gas records found. Check required columns (Date, Vehicle, Total KG).' });

    const { map, numberIndex, textByCategory } = loadFleetMaster();
    parser.enrichFleet(mofatRows, map, numberIndex); parser.enrichFleet(lakeRows, map, numberIndex);
    const { matches, unmatchedMofat, unmatchedLake } = parser.matchRecords(mofatRows, lakeRows);

    const insertBatch = db.prepare(`INSERT INTO batches (name, mofat_filename, lake_filename, gas_price, bus_capacity, variance_tol, dup_threshold, planned_buses, backup_buses, reserve_buses)
      VALUES (@name, @mofat_filename, @lake_filename, @gas_price, @bus_capacity, @variance_tol, @dup_threshold, @planned_buses, @backup_buses, @reserve_buses)`);

    const tx = db.transaction(() => {
      const info = insertBatch.run({
        name, mofat_filename: mofatFile.originalname, lake_filename: lakeFile.originalname,
        gas_price: +gasPrice, bus_capacity: +busCapacity, variance_tol: +varianceTol, dup_threshold: +dupThreshold,
        planned_buses: textByCategory.Planned.join('\n'), backup_buses: textByCategory.Backup.join('\n'), reserve_buses: textByCategory.Reserve.join('\n')
      });
      const batchId = info.lastInsertRowid;

      const insMofat = db.prepare(`INSERT INTO mofat_records (batch_id,date,bus,bus_display,driver,km,gas,time_in,time_out,shift,category,src_row,matched)
        VALUES (@batch_id,@date,@bus,@busDisplay,@driver,@km,@gas,@timeIn,@timeOut,@shift,@category,@row,@matched)`);
      mofatRows.forEach(r => insMofat.run({ ...r, batch_id: batchId, matched: r.matched ? 1 : 0 }));

      const insLake = db.prepare(`INSERT INTO lake_records (batch_id,date,bus,bus_display,recipient,pod,station,gas,shift,category,src_row,matched)
        VALUES (@batch_id,@date,@bus,@busDisplay,@recipient,@pod,@station,@gas,@shift,@category,@row,@matched)`);
      lakeRows.forEach(r => insLake.run({ ...r, batch_id: batchId, matched: r.matched ? 1 : 0 }));

      const insMatch = db.prepare(`INSERT INTO matches (batch_id,date,bus,bus_display,category,shift,mofat_kg,lake_kg,variance,abs_variance,mofat_row,lake_row,pod)
        VALUES (@batch_id,@date,@bus,@busDisplay,@category,@shift,@mofatKg,@lakeKg,@variance,@absVariance,@mofatRow,@lakeRow,@pod)`);
      matches.forEach(r => insMatch.run({ ...r, batch_id: batchId }));

      return batchId;
    });

    const batchId = tx();
    res.json(getBatchPayload(batchId));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Reconciliation failed: ' + e.message });
  }
});

// Fleet master registry (persistent source of truth for Planned/Backup/Reserve categorization).
app.get('/api/fleet', (req, res) => {
  res.json(db.prepare(`SELECT bus, bus_display as busDisplay, category FROM fleet_master ORDER BY category, bus_display`).all());
});

app.post('/api/fleet', (req, res) => {
  const bus = parser.normBus(req.body.bus);
  const category = req.body.category;
  if (!bus) return res.status(400).json({ error: 'A valid bus plate is required.' });
  if (!['Planned', 'Backup', 'Reserve'].includes(category)) return res.status(400).json({ error: 'Category must be Planned, Backup or Reserve.' });
  db.prepare(`INSERT INTO fleet_master (bus, bus_display, category) VALUES (?,?,?)
    ON CONFLICT(bus) DO UPDATE SET category=excluded.category, bus_display=excluded.bus_display`).run(bus, parser.fmtBus(bus), category);
  res.json({ ok: true, bus, busDisplay: parser.fmtBus(bus), category });
});

app.post('/api/fleet/bulk', (req, res) => {
  const category = req.body.category;
  if (!['Planned', 'Backup', 'Reserve'].includes(category)) return res.status(400).json({ error: 'Category must be Planned, Backup or Reserve.' });
  const buses = (req.body.text || '').split(/\n|,|;/).map(parser.normBus).filter(Boolean);
  const ins = db.prepare(`INSERT INTO fleet_master (bus, bus_display, category) VALUES (?,?,?)
    ON CONFLICT(bus) DO UPDATE SET category=excluded.category, bus_display=excluded.bus_display`);
  const tx = db.transaction(() => buses.forEach(bus => ins.run(bus, parser.fmtBus(bus), category)));
  tx();
  res.json({ ok: true, added: buses.length });
});

app.delete('/api/fleet/:bus', (req, res) => {
  db.prepare(`DELETE FROM fleet_master WHERE bus=?`).run(parser.normBus(req.params.bus));
  res.json({ ok: true });
});

// List all stored batches (history).
app.get('/api/batches', (req, res) => {
  const rows = db.prepare(`SELECT id, name, created_at, mofat_filename, lake_filename FROM batches ORDER BY id DESC`).all();
  res.json(rows);
});

// Reload a previously stored batch and recompute its view (including saved comments).
app.get('/api/batches/:id', (req, res) => {
  const payload = getBatchPayload(+req.params.id);
  if (!payload) return res.status(404).json({ error: 'Batch not found' });
  res.json(payload);
});

// Re-run categorization/matching for a stored batch against the CURRENT fleet master (no re-upload needed).
app.post('/api/batches/:id/reprocess', (req, res) => {
  const id = reprocessBatch(+req.params.id);
  if (!id) return res.status(404).json({ error: 'Batch not found' });
  res.json(getBatchPayload(id));
});

// Apply every suffix-mismatch "did you mean" suggestion for a batch at once, then reprocess.
app.post('/api/batches/:id/accept-all-suggestions', (req, res) => {
  const id = +req.params.id;
  const payload = getBatchPayload(id);
  if (!payload) return res.status(404).json({ error: 'Batch not found' });

  const suggestions = payload.tables.audits.filter(a => a.type === 'Unauthorized Fueling' && a.suggestedBus);
  const uniqueByBus = new Map();
  // Authorize the AS-RECORDED plate (busNorm) under the suggested category — not the master's already-correct entry.
  suggestions.forEach(s => uniqueByBus.set(s.busNorm, s.suggestedCategory));

  const ins = db.prepare(`INSERT INTO fleet_master (bus, bus_display, category) VALUES (?,?,?)
    ON CONFLICT(bus) DO UPDATE SET category=excluded.category, bus_display=excluded.bus_display`);
  const tx = db.transaction(() => uniqueByBus.forEach((category, bus) => ins.run(bus, parser.fmtBus(bus), category)));
  tx();

  reprocessBatch(id);
  res.json({ applied: uniqueByBus.size, ...getBatchPayload(id) });
});

// Save/update an audit remark for one exception row within a batch.
app.put('/api/batches/:id/comments', (req, res) => {
  const id = +req.params.id;
  const { ckey, text } = req.body;
  if (!ckey) return res.status(400).json({ error: 'ckey is required' });
  db.prepare(`INSERT INTO comments (batch_id, ckey, text) VALUES (?,?,?)
    ON CONFLICT(batch_id, ckey) DO UPDATE SET text=excluded.text`).run(id, ckey, text || '');
  res.json({ ok: true });
});

app.delete('/api/batches/:id', (req, res) => {
  db.prepare(`DELETE FROM batches WHERE id=?`).run(+req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Gas reconciliation system running at http://localhost:${PORT}`));

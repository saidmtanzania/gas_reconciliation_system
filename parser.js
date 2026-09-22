// Parsing + fleet categorization + matching logic, ported from the client-side dashboard.
const XLSX = require('xlsx');

function normBus(v) {
  let s = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Bus plates always carry a leading "T"; source files sometimes omit it.
  if (s && !s.startsWith('T') && /^\d{3}[A-Z]{2,4}$/.test(s)) s = 'T' + s;
  return s;
}
function fmtBus(b) { const m = String(b).match(/^T(\d{3})([A-Z]{3})$/); return m ? `T ${m[1]} ${m[2]}` : b; }
function toNum(v) { if (v == null || v === '') return 0; const n = Number(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
  if (m) {
    let d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
}

function monthKey(date) { return date ? date.slice(0, 7) : ''; }
function weekKey(date) {
  const d = new Date(date + 'T00:00:00Z');
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const w = Math.ceil((d.getUTCDate() + first.getUTCDay()) / 7);
  return `${date.slice(0, 7)} W${w}`;
}

function readWorkbook(buffer) {
  return XLSX.read(buffer, { type: 'buffer', cellDates: true });
}
function sheetRows(wb) {
  let out = [];
  wb.SheetNames.forEach(s => {
    const ws = wb.Sheets[s];
    out = out.concat(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }));
  });
  return out;
}

function parseMofatRows(rows) {
  const data = []; let shift = 'Unknown', headers = null, idx = {};
  rows.forEach((r, ri) => {
    const line = r.map(x => String(x).toUpperCase()).join(' ');
    if (line.includes('MORNING')) shift = 'Morning';
    else if (line.includes('AFTERNOON')) shift = 'Afternoon';
    else if (line.includes('NIGHT')) shift = 'Night';
    if (line.includes('BUS') && line.includes('GAS') && line.includes('DATE')) {
      headers = r.map(x => String(x).trim().toUpperCase());
      headers.forEach((h, i) => {
        if (h.includes('DATE')) idx.date = i;
        if (h.includes('BUS')) idx.bus = i;
        if (h.includes('DRIVER')) idx.driver = i;
        if (h === 'KM' || h.includes('ODO')) idx.km = i;
        if (h.includes('GAS')) idx.gas = i;
        if (h.includes('TIME IN')) idx.timeIn = i;
        if (h.includes('TIME OUT')) idx.timeOut = i;
        if (h.includes('SHIFT')) idx.shift = i;
      });
      return;
    }
    const bus = normBus(r[idx.bus]); const gas = toNum(r[idx.gas]); const date = parseDate(r[idx.date]);
    if (headers && bus && gas && date) {
      data.push({
        source: 'Mofat', date, bus, busDisplay: fmtBus(bus), driver: r[idx.driver] || '', km: toNum(r[idx.km]),
        gas, timeIn: r[idx.timeIn] || '', timeOut: r[idx.timeOut] || '',
        shift: idx.shift != null ? (r[idx.shift] || shift) : shift, row: ri + 1, matched: false
      });
    }
  });
  return data;
}

function parseLakeRows(rows) {
  const data = []; let headers = null, idx = {};
  rows.forEach((r, ri) => {
    const line = r.map(x => String(x).toUpperCase()).join(' ');
    if (line.includes('VEHICLE') && line.includes('TOTAL') && line.includes('KG')) {
      headers = r.map(x => String(x).trim().toUpperCase());
      headers.forEach((h, i) => {
        if (h.includes('DATE')) idx.date = i;
        if (h.includes('VEHICLE')) idx.bus = i;
        if (h.includes('TOTAL') && h.includes('KG')) idx.gas = i;
        if (h.includes('RECEIP')) idx.recipient = i;
        if (h.includes('POD')) idx.pod = i;
        if (h.includes('STATION')) idx.station = i;
      });
      return;
    }
    const bus = normBus(r[idx.bus]); const gas = toNum(r[idx.gas]); const date = parseDate(r[idx.date]);
    if (headers && bus && gas && date) {
      data.push({
        source: 'Lake', date, bus, busDisplay: fmtBus(bus), recipient: r[idx.recipient] || '',
        pod: r[idx.pod] || '', station: r[idx.station] || '', gas, row: ri + 1, matched: false, shift: 'Unassigned'
      });
    }
  });
  return data;
}

function fleetMap(plannedText, backupText, reserveText) {
  const map = {};
  function add(txt, cat) { (txt || '').split(/\n|,|;/).map(normBus).filter(Boolean).forEach(b => map[b] = cat); }
  add(plannedText, 'Planned'); add(backupText, 'Backup'); add(reserveText, 'Reserve');
  return map;
}

// Build the fleet map straight from fleet_master DB rows: [{bus, category}].
function fleetMapFromEntries(entries) {
  const map = {};
  entries.forEach(e => map[e.bus] = e.category);
  return map;
}

// Index fleet master entries by bus number alone, so a suffix mismatch (e.g. ENQ vs ENS)
// can still surface a "did you mean" hint instead of a bare Unknown.
function buildNumberIndex(fm) {
  const idx = {};
  Object.entries(fm).forEach(([key, cat]) => {
    const m = key.match(/^T(\d{3})([A-Z]*)$/);
    if (m) (idx[m[1]] ??= []).push({ suffix: m[2], category: cat });
  });
  return idx;
}

function enrichFleet(rows, fm, numberIndex) {
  rows.forEach(r => {
    r.category = fm[r.bus] || 'Unknown';
    if (r.category === 'Unknown' && numberIndex) {
      const m = r.bus.match(/^T?(\d{3})([A-Z]*)$/);
      const opts = m && numberIndex[m[1]];
      if (opts) {
        r.suggestion = `Bus number ${m[1]} exists in fleet master as ${opts.map(o => `${fmtBus('T' + m[1] + o.suffix)} (${o.category})`).join(', ')} — this record's suffix is "${m[2] || '—'}". Likely a plate typo; verify and correct.`;
        if (opts.length === 1) {
          r.suggestedBus = 'T' + m[1] + opts[0].suffix;
          r.suggestedCategory = opts[0].category;
          r.suggestedBusDisplay = fmtBus(r.suggestedBus);
        }
      }
    }
  });
}

function matchRecords(mofat, lake) {
  mofat.forEach(r => r.matched = false);
  lake.forEach(r => { r.matched = false; r.shift = 'Unassigned'; });
  const lakeByKey = {};
  lake.forEach(l => { const key = l.date + '|' + l.bus; (lakeByKey[key] ??= []).push(l); });
  const matches = [];
  mofat.forEach(m => {
    const candidates = (lakeByKey[m.date + '|' + m.bus] || []).filter(l => !l.matched);
    if (!candidates.length) return;
    candidates.sort((a, b) => Math.abs(a.gas - m.gas) - Math.abs(b.gas - m.gas));
    const l = candidates[0];
    m.matched = true; l.matched = true; l.shift = m.shift;
    matches.push({
      date: m.date, bus: m.bus, busDisplay: m.busDisplay, category: m.category, shift: m.shift,
      mofatKg: m.gas, lakeKg: l.gas, variance: m.gas - l.gas, absVariance: Math.abs(m.gas - l.gas),
      mofatRow: m.row, lakeRow: l.row, pod: l.pod
    });
  });
  const unmatchedMofat = mofat.filter(r => !r.matched);
  const unmatchedLake = lake.filter(r => !r.matched);
  return { matches, unmatchedMofat, unmatchedLake };
}

module.exports = {
  normBus, fmtBus, toNum, parseDate, monthKey, weekKey,
  readWorkbook, sheetRows, parseMofatRows, parseLakeRows,
  fleetMap, fleetMapFromEntries, buildNumberIndex, enrichFleet, matchRecords
};

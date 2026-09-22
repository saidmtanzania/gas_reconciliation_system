const $ = id => document.getElementById(id);
let current = null; // last loaded/computed batch payload
let charts = {};

function esc(v) { return String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function kg(n) { return (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function money(n) { return 'TZS ' + Math.round(n).toLocaleString(); }
function pct(n) { return (n || 0).toFixed(2) + '%'; }
function statusPill(status) {
  const c = status.includes('Investigate') || status.includes('Unauthorized') ? 'p-red' : status.includes('Review') || status.includes('Exception') ? 'p-yellow' : 'p-green';
  return `<span class="pill ${c}">${status}</span>`;
}
function table(rows, cols) {
  if (!rows.length) return '<div class="note">No records for this batch.</div>';
  return '<table><thead><tr>' + cols.map(c => `<th class="${c.right ? 'right' : ''}">${c.h}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + cols.map(c => `<td class="${c.right ? 'right' : ''}">${c.f ? c.f(r) : (r[c.k] ?? '')}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
}

function draw(id, type, labels, datasets) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), { type, data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#cbd5e1' } } }, scales: { x: { ticks: { color: '#cbd5e1' }, grid: { color: '#263244' } }, y: { ticks: { color: '#cbd5e1' }, grid: { color: '#263244' } } } } });
}

function render(payload) {
  current = payload;
  const s = payload.statusBar;
  $('statusBar').className = 'status ' + (s.status === 'PASS' ? 'pass' : s.status === 'WARNING' ? 'warns' : 'fail');
  $('statusBar').innerHTML = `${s.status === 'PASS' ? '\uD83D\uDFE2' : '\uD83D\uDD34'} RECON ${s.status} | Planned: ${s.planned} | Backup: ${s.backup} | Reserve: ${s.reserve} | Unauthorized: ${s.unknown.length ? s.unknown.join(', ') : 'None'} | Variance: ${kg(s.variance)} Kg | Exposure: ${money(s.exposure)} | Invoice: ${s.inv}`;

  $('kpis').innerHTML = payload.kpis.map(x => `<div class="kpi"><div class="l">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');
  $('mgmtSummary').textContent = payload.mgmtSummary;
  $('mgmtEmail').value = payload.mgmtEmail;

  const t = payload.tables;
  $('dailyTable').innerHTML = table(t.daily, [{ h: 'Date', k: 'date' }, { h: 'Mofat KG', f: r => kg(r.mofatKg), right: 1 }, { h: 'Lake KG', f: r => kg(r.lakeKg), right: 1 }, { h: 'Variance', f: r => kg(r.variance), right: 1 }, { h: 'Variance %', f: r => pct(r.variancePct), right: 1 }, { h: 'Status', f: r => statusPill(r.status) }]);
  $('shiftTable').innerHTML = table(t.shift, [{ h: 'Shift', k: 'shift' }, { h: 'Mofat KG', f: r => kg(r.mofatKg), right: 1 }, { h: 'Lake KG', f: r => kg(r.lakeKg), right: 1 }, { h: 'Variance', f: r => kg(r.variance), right: 1 }, { h: 'Status', f: r => statusPill(r.status) }]);
  $('busTable').innerHTML = table(t.bus, [{ h: 'Bus', k: 'bus' }, { h: 'Category', k: 'category' }, { h: 'Mofat KG', f: r => kg(r.mofatKg), right: 1 }, { h: 'Lake KG', f: r => kg(r.lakeKg), right: 1 }, { h: 'Variance', f: r => kg(r.variance), right: 1 }, { h: 'Status', f: r => statusPill(r.status) }]);
  $('fleetTable').innerHTML = table(t.fleet, [{ h: 'Category', k: 'category' }, { h: 'Buses Fueled', k: 'buses', right: 1 }, { h: 'Transactions', k: 'transactions', right: 1 }, { h: 'Total KG', f: r => kg(r.kg), right: 1 }]);
  $('freqTable').innerHTML = table(t.freq, [{ h: 'Date', k: 'date' }, { h: 'Bus', k: 'bus' }, { h: 'Category', k: 'category' }, { h: 'Fillings', k: 'count', right: 1 }, { h: 'Mofat KG', f: r => kg(r.kg), right: 1 }, { h: 'Status', f: r => statusPill(r.status) }]);
  $('missingTable').innerHTML = table(t.missing, [{ h: 'Source', k: 'source' }, { h: 'Date', k: 'date' }, { h: 'Bus', k: 'bus' }, { h: 'Category', k: 'category' }, { h: 'KG', f: r => kg(r.kg), right: 1 }, { h: 'Notes', k: 'notes' }]);
  renderAuditTable(t.audits);
  $('financeTable').innerHTML = table(t.finance, [{ h: 'Item', k: 'item' }, { h: 'Value', k: 'value' }]);

  draw('trendChart', 'line', payload.charts.trend.map(x => x.date), [{ label: 'Variance KG', data: payload.charts.trend.map(x => x.variance) }]);
  draw('fleetChart', 'bar', payload.charts.fleetCategories, [{ label: 'Total KG', data: payload.charts.fleetChart }]);

  if (payload.config) {
    $('gasPrice').value = payload.config.gasPrice; $('busCapacity').value = payload.config.busCapacity;
    $('varianceTol').value = payload.config.varianceTol; $('dupThreshold').value = payload.config.dupThreshold;
    const p = (payload.config.plannedBuses || '').split('\n').filter(Boolean).length;
    const b = (payload.config.backupBuses || '').split('\n').filter(Boolean).length;
    const r = (payload.config.reserveBuses || '').split('\n').filter(Boolean).length;
    $('fleetSummary').textContent = `Fleet master: ${p + b + r} buses (${p} Planned / ${b} Backup / ${r} Reserve)`;
  }
}

// Audit table gets custom rendering: suffix-mismatch rows get an "Accept correction" button,
// true-unknown rows get an inline category picker to authorize the bus directly.
function renderAuditTable(rows) {
  if (!rows.length) { $('auditTable').innerHTML = '<div class="note">No records for this batch.</div>'; return; }
  const head = '<tr><th>Exception Type</th><th>Date</th><th>Bus</th><th class="right">KG/Variance</th><th>Recommended Action</th><th>Fix</th><th>Remarks / Action Taken</th></tr>';
  const body = rows.map(r => {
    let fix = '—';
    if (r.type === 'Unauthorized Fueling') {
      if (r.suggestedBus) {
        fix = `<button class="secondary" onclick="acceptSuggestion('${esc(r.busNorm)}','${esc(r.suggestedCategory)}')">Accept as ${esc(r.suggestedCategory)} (matches ${esc(r.suggestedBusDisplay)})</button>`;
      } else if (r.busNorm) {
        fix = `<select id="cat_${esc(r.busNorm)}"><option>Planned</option><option>Backup</option><option>Reserve</option></select>
          <button class="secondary" onclick="authorizeBus('${esc(r.busNorm)}')">Authorize</button>`;
      }
    }
    return `<tr><td>${esc(r.type)}</td><td>${esc(r.date)}</td><td>${esc(r.bus)}</td><td class="right">${kg(r.kg)}</td><td>${esc(r.action)}</td><td>${fix}</td>
      <td><input class="remarkInput" value="${esc(r.comment)}" placeholder="Add audit comment / action taken" onchange="saveComment('${esc(r.ckey)}', this.value)"></td></tr>`;
  }).join('');
  $('auditTable').innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

async function acceptSuggestion(bus, category) {
  await fetch('/api/fleet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bus, category }) });
  await reprocessCurrent();
}
window.acceptSuggestion = acceptSuggestion;

async function authorizeBus(busNorm) {
  const category = $('cat_' + busNorm).value;
  await fetch('/api/fleet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bus: busNorm, category }) });
  await reprocessCurrent();
}
window.authorizeBus = authorizeBus;

async function reprocessCurrent() {
  if (!current) return;
  const resp = await fetch(`/api/batches/${current.batchId}/reprocess`, { method: 'POST' });
  const payload = await resp.json();
  if (!resp.ok) { alert('Error: ' + (payload.error || 'Reprocess failed')); return; }
  render(payload);
  loadFleetMasterTable();
}

async function autoFixAllSuggestions() {
  if (!current) { alert('Process or open a batch first.'); return; }
  const resp = await fetch(`/api/batches/${current.batchId}/accept-all-suggestions`, { method: 'POST' });
  const payload = await resp.json();
  if (!resp.ok) { alert('Error: ' + (payload.error || 'Auto-fix failed')); return; }
  render(payload);
  loadFleetMasterTable();
  alert(`Applied ${payload.applied} suffix correction(s). Unauthorized buses remaining: ${payload.statusBar.unknown.length}.`);
}

async function saveComment(ckey, text) {
  if (!current) return;
  await fetch(`/api/batches/${current.batchId}/comments`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ckey, text }) });
}
window.saveComment = saveComment;

async function process() {
  const mf = $('mofatFile').files[0], lf = $('lakeFile').files[0];
  if (!mf || !lf) { alert('Please select both Mofat and Lake Gas files.'); return; }
  $('runBtn').disabled = true; $('runBtn').textContent = 'Processing...';
  try {
    const fd = new FormData();
    fd.append('mofatFile', mf); fd.append('lakeFile', lf);
    fd.append('name', $('batchName').value);
    fd.append('gasPrice', $('gasPrice').value); fd.append('busCapacity', $('busCapacity').value);
    fd.append('varianceTol', $('varianceTol').value); fd.append('dupThreshold', $('dupThreshold').value);
    const resp = await fetch('/api/reconcile', { method: 'POST', body: fd });
    const payload = await resp.json();
    if (!resp.ok) { alert('Error: ' + (payload.error || 'Unknown error')); return; }
    $('mofatInfo').textContent = `Uploaded ${mf.name}`; $('lakeInfo').textContent = `Uploaded ${lf.name}`;
    render(payload);
    loadHistory();
    alert(`Saved as batch #${payload.batchId} in the SQLite database.`);
  } catch (e) {
    alert('Upload error: ' + e.message);
  } finally {
    $('runBtn').disabled = false; $('runBtn').textContent = 'Process & Save to Database';
  }
}

async function loadHistory() {
  const rows = await (await fetch('/api/batches')).json();
  $('historyList').innerHTML = rows.length ? rows.map(b => `
    <div class="histrow" onclick="openBatch(${b.id})">
      <div><b>#${b.id} — ${esc(b.name)}</b><br><small>${b.mofat_filename} + ${b.lake_filename} | ${b.created_at}</small></div>
      <button class="secondary" onclick="event.stopPropagation();deleteBatch(${b.id})">Delete</button>
    </div>`).join('') : '<div class="note">No batches saved yet.</div>';
}

async function openBatch(id) {
  const payload = await (await fetch(`/api/batches/${id}`)).json();
  render(payload);
  document.querySelector('.tab[data-page="summary"]').click();
}
window.openBatch = openBatch;

async function deleteBatch(id) {
  if (!confirm('Delete batch #' + id + '? This cannot be undone.')) return;
  await fetch(`/api/batches/${id}`, { method: 'DELETE' });
  loadHistory();
}
window.deleteBatch = deleteBatch;

// Fleet Master tab: add/edit/delete/bulk-import buses in the persistent registry.
async function loadFleetMasterTable() {
  const rows = await (await fetch('/api/fleet')).json();
  $('fleetMasterTable').innerHTML = table(rows, [
    { h: 'Bus', k: 'busDisplay' }, { h: 'Category', k: 'category' },
    { h: 'Remove', f: r => `<button class="secondary" onclick="deleteFleetBus('${esc(r.bus)}')">Delete</button>` }
  ]);
  const p = rows.filter(r => r.category === 'Planned').length, b = rows.filter(r => r.category === 'Backup').length, res = rows.filter(r => r.category === 'Reserve').length;
  $('fleetSummary').textContent = `Fleet master: ${rows.length} buses (${p} Planned / ${b} Backup / ${res} Reserve)`;
}

async function addFleetBus() {
  const bus = $('fleetBusInput').value.trim(), category = $('fleetCatInput').value;
  if (!bus) { alert('Enter a bus plate.'); return; }
  const resp = await fetch('/api/fleet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bus, category }) });
  if (!resp.ok) { alert('Error saving bus.'); return; }
  $('fleetBusInput').value = '';
  loadFleetMasterTable();
}

async function bulkImportFleet() {
  const text = $('fleetBulkInput').value.trim(), category = $('fleetBulkCat').value;
  if (!text) { alert('Paste at least one bus plate.'); return; }
  const resp = await fetch('/api/fleet/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, category }) });
  const j = await resp.json();
  if (!resp.ok) { alert('Error importing list.'); return; }
  $('fleetBulkInput').value = '';
  alert(`Imported ${j.added} bus(es) as ${category}.`);
  loadFleetMasterTable();
}

async function deleteFleetBus(bus) {
  if (!confirm('Remove ' + bus + ' from the fleet master?')) return;
  await fetch(`/api/fleet/${encodeURIComponent(bus)}`, { method: 'DELETE' });
  loadFleetMasterTable();
}
window.deleteFleetBus = deleteFleetBus;

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  t.classList.add('active'); $(t.dataset.page).classList.add('active');
  if (t.dataset.page === 'history') loadHistory();
  if (t.dataset.page === 'fleetmaster') loadFleetMasterTable();
});

$('runBtn').onclick = process;
$('printBtn').onclick = () => window.print();
$('copySummaryBtn').onclick = () => { navigator.clipboard?.writeText($('mgmtEmail').value); alert('Management summary copied.'); };
$('fleetAddBtn').onclick = addFleetBus;
$('fleetBulkBtn').onclick = bulkImportFleet;
$('autoFixBtn').onclick = autoFixAllSuggestions;

loadFleetMasterTable();
loadHistory();

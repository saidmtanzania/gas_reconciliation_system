// Computes KPIs, tables, chart data and summaries from parsed/matched records.
const { fmtBus, toNum, monthKey } = require('./parser');

function kg(n) { return (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function money(n) { return 'TZS ' + Math.round(n).toLocaleString(); }
function pct(n) { return (n || 0).toFixed(2) + '%'; }
function ckey(r) { return [r.type || '', r.date || '', r.bus || '', String(r.kg || '')].join('|'); }

function countCat(mofat, lake, cat) {
  return new Set([...mofat, ...lake].filter(r => r.category === cat).map(r => r.bus)).size;
}

function selectedPeriodLabel(mofat, lake) {
  const dates = [...new Set([...mofat, ...lake].map(r => r.date))].sort();
  if (!dates.length) return 'All uploaded data';
  return dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
}

function computeResults({ mofat, lake, matches, unmatchedMofat, unmatchedLake, config, comments }) {
  const gp = toNum(config.gasPrice), cap = toNum(config.busCapacity), tol = toNum(config.varianceTol), dup = toNum(config.dupThreshold);
  const totalM = mofat.reduce((s, r) => s + r.gas, 0), totalL = lake.reduce((s, r) => s + r.gas, 0);
  const variance = totalM - totalL, absVar = Math.abs(variance), exposure = absVar * gp;
  const unknown = [...new Set([...mofat, ...lake].filter(r => r.category === 'Unknown').map(r => fmtBus(r.bus)))];
  const reserve = [...new Set([...mofat, ...lake].filter(r => r.category === 'Reserve').map(r => fmtBus(r.bus)))];
  const missingCount = unmatchedMofat.length + unmatchedLake.length;
  const highVar = matches.filter(r => r.absVariance > tol).length;
  const capViol = [...mofat, ...lake].filter(r => r.gas > cap);

  let status = 'PASS', inv = 'APPROVED';
  if (unknown.length || highVar || capViol.length) { status = 'FAIL'; inv = 'HOLD PAYMENT'; }
  else if (missingCount || reserve.length || absVar > tol) { status = 'WARNING'; inv = 'APPROVED WITH EXCEPTIONS'; }

  const kpis = [
    ['Mofat KG', kg(totalM)], ['Lake KG', kg(totalL)], ['Variance KG', kg(variance)],
    ['Financial exposure', money(exposure)], ['Transactions', mofat.length + lake.length],
    ['Matched events', matches.length], ['Unmatched records', missingCount], ['Invoice status', inv]
  ];

  const mgmtSummary = `The selected period has ${matches.length} matched fueling events, ${missingCount} unmatched records, ${unknown.length} unauthorized buses, and total variance of ${kg(variance)} Kg. Estimated financial exposure is ${money(exposure)}. Invoice recommendation: ${inv}.`;

  const periodLabel = selectedPeriodLabel(mofat, lake);
  const mgmtEmail = `Subject: Gas Reconciliation Summary - ${periodLabel}

Dear Management,

Please find below the gas reconciliation summary for the selected period (${periodLabel}):

- Reconciliation Status: ${status}
- Invoice Recommendation: ${inv}
- Mofat Verified KG: ${kg(totalM)} Kg
- Lake Gas Invoice KG: ${kg(totalL)} Kg
- Variance: ${kg(variance)} Kg
- Estimated Financial Exposure: ${money(exposure)}
- Matched Fueling Events: ${matches.length}
- Unmatched Records: ${missingCount}
- Unauthorized Buses: ${unknown.length ? unknown.join(', ') : 'None'}
- Reserve Buses Used: ${reserve.length ? reserve.join(', ') : 'None'}

Recommended Action:
${inv === 'APPROVED' ? 'Invoice may proceed for payment based on the reconciled data.' : inv === 'APPROVED WITH EXCEPTIONS' ? 'Invoice may proceed only after the listed exceptions are reviewed and documented.' : 'Payment should be held until all major exceptions are investigated and cleared.'}

Regards,
Mofat Gas Reconciliation Team`;

  // Daily table
  const dailyKeys = [...new Set([...mofat, ...lake].map(r => r.date))].sort();
  const daily = dailyKeys.map(date => {
    const m = mofat.filter(r => r.date === date).reduce((s, r) => s + r.gas, 0);
    const l = lake.filter(r => r.date === date).reduce((s, r) => s + r.gas, 0);
    return { date, mofatKg: m, lakeKg: l, variance: m - l, variancePct: l ? ((m - l) / l * 100) : 0, status: Math.abs(m - l) <= tol ? 'Matched' : 'Review' };
  });

  // Shift table
  const shifts = ['Morning', 'Afternoon', 'Night', 'Unknown', 'Unassigned'];
  const shiftRows = shifts.map(s => {
    const m = mofat.filter(r => r.shift === s).reduce((a, r) => a + r.gas, 0);
    const l = lake.filter(r => r.shift === s).reduce((a, r) => a + r.gas, 0);
    return { shift: s, mofatKg: m, lakeKg: l, variance: m - l, status: Math.abs(m - l) <= tol ? 'Matched' : 'Review' };
  }).filter(r => r.mofatKg || r.lakeKg);

  // Bus table
  const busKeys = [...new Set([...mofat, ...lake].map(r => r.bus))].sort();
  const busRows = busKeys.map(b => {
    const all = [...mofat, ...lake].filter(r => r.bus === b);
    const m = mofat.filter(r => r.bus === b).reduce((a, r) => a + r.gas, 0);
    const l = lake.filter(r => r.bus === b).reduce((a, r) => a + r.gas, 0);
    const cat = (all[0] || {}).category || 'Unknown';
    const av = Math.abs(m - l);
    const st = cat === 'Unknown' ? 'Unauthorized' : av <= tol ? 'Matched' : av <= tol * 3 ? 'Review' : 'Investigate';
    return { bus: fmtBus(b), category: cat, mofatKg: m, lakeKg: l, variance: m - l, status: st };
  });

  // Fleet table
  const fleetRows = ['Planned', 'Backup', 'Reserve', 'Unknown'].map(cat => {
    const rows = [...mofat, ...lake].filter(r => r.category === cat);
    return { category: cat, buses: new Set(rows.map(r => r.bus)).size, transactions: rows.length, kg: rows.reduce((a, r) => a + r.gas, 0) };
  });

  // Frequency table
  const freqMap = {};
  mofat.forEach(r => {
    const k = r.date + '|' + r.bus;
    if (!freqMap[k]) freqMap[k] = { date: r.date, bus: fmtBus(r.bus), category: r.category, count: 0, kg: 0 };
    freqMap[k].count++; freqMap[k].kg += r.gas;
  });
  const freq = Object.values(freqMap).sort((a, b) => b.count - a.count).map(r => ({ ...r, status: r.count >= dup ? 'Review/Investigate' : 'Normal' }));

  // Missing table
  const missing = [
    ...unmatchedMofat.map(r => ({ source: 'Mofat only', date: r.date, bus: fmtBus(r.bus), category: r.category, kg: r.gas, notes: 'No matching Lake record' })),
    ...unmatchedLake.map(r => ({ source: 'Lake only', date: r.date, bus: fmtBus(r.bus), category: r.category, kg: r.gas, notes: 'No matching Mofat record' }))
  ];

  // Audit exceptions
  const audits = [];
  [...mofat, ...lake].filter(r => r.category === 'Unknown').forEach(r => audits.push({
    type: 'Unauthorized Fueling', date: r.date, bus: fmtBus(r.bus), busNorm: r.bus, kg: r.gas,
    action: r.suggestion || 'Verify bus against approved fleet master',
    suggestedBus: r.suggestedBus || null, suggestedCategory: r.suggestedCategory || null, suggestedBusDisplay: r.suggestedBusDisplay || null
  }));
  capViol.forEach(r => audits.push({ type: 'Capacity Violation', date: r.date, bus: fmtBus(r.bus), kg: r.gas, action: 'Single transaction exceeds bus capacity' }));
  freq.filter(r => r.count >= dup).forEach(r => audits.push({ type: 'High Fill Frequency', date: r.date, bus: r.bus, kg: r.kg, action: 'Review operational justification' }));
  matches.filter(r => r.absVariance > tol).forEach(r => audits.push({ type: 'High Variance', date: r.date, bus: fmtBus(r.bus), kg: r.variance, action: 'Investigate before payment' }));
  audits.forEach(a => { a.ckey = ckey(a); a.comment = (comments && comments[a.ckey]) || ''; });

  // Finance table
  const finance = [
    { item: 'Lake invoice KG', value: kg(totalL) }, { item: 'Mofat verified KG', value: kg(totalM) },
    { item: 'Variance KG', value: kg(variance) }, { item: 'Gas price per KG', value: money(gp) },
    { item: 'Estimated amount by Lake KG', value: money(totalL * gp) }, { item: 'Estimated amount by Mofat KG', value: money(totalM * gp) },
    { item: 'Financial exposure', value: money(exposure) },
    { item: 'Unauthorized buses', value: unknown.length ? unknown.join(', ') : 'None' },
    { item: 'Reserve buses used', value: reserve.length ? reserve.join(', ') : 'None' },
    { item: 'Invoice recommendation', value: inv }
  ];

  // Charts
  const trend = dailyKeys.map(date => ({ date, variance: daily.find(d => d.date === date).variance }));
  const cats = ['Planned', 'Backup', 'Reserve', 'Unknown'];
  const fleetChart = cats.map(c => [...mofat, ...lake].filter(r => r.category === c).reduce((s, r) => s + r.gas, 0));

  return {
    statusBar: { status, inv, planned: countCat(mofat, lake, 'Planned'), backup: countCat(mofat, lake, 'Backup'), reserve: reserve.length, unknown, variance, exposure },
    kpis, mgmtSummary, mgmtEmail,
    tables: { daily, shift: shiftRows, bus: busRows, fleet: fleetRows, freq, missing, audits, finance },
    charts: { trend, fleetCategories: cats, fleetChart },
    raw: { totalM, totalL, variance, exposure, inv, status, unknown, reserve }
  };
}

module.exports = { computeResults, kg, money, pct, ckey };

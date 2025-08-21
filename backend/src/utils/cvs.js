function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

// rows: array of telemetry docs (lean)
// prefer columns: ts, homeId, deviceId, stream, then all payload.* keys
function toCSV(rows) {
  const flatRows = rows.map(r => {
    const f = {
      ts: r.ts || r.createdAt,
      homeId: r.homeId,
      deviceId: r.deviceId,
      stream: r.stream
    };
    const payloadFlat = flatten(r.payload || {}, 'payload');
    return { ...f, ...payloadFlat };
  });

  // collect all keys
  const keys = new Set(['ts','homeId','deviceId','stream']);
  flatRows.forEach(r => Object.keys(r).forEach(k => keys.add(k)));
  const headers = Array.from(keys);

  const lines = [
    headers.join(',')
  ];
  for (const row of flatRows) {
    const line = headers.map(h => escapeCSV(row[h] ?? '')).join(',');
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = { toCSV };

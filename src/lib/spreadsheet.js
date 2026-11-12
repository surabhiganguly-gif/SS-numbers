// Minimal, read-only spreadsheet reader for bank statements — runs entirely in
// the browser, no third-party code. Supports legacy Excel (.xls / BIFF8, which
// is what most Indian bank "Excel" downloads still are) and CSV/TSV text.
// Returns rows as arrays of cell values (strings and numbers).

const ENDOFCHAIN = 0xfffffffe;
const SPECIAL_SECTOR = 0xfffffffc; // anything >= this is not a real sector id

export async function readSpreadsheet(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isOle2(bytes)) return parseXls(bytes);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new Error("This is a newer .xlsx file, which isn't supported yet — download the statement as .xls or CSV instead.");
  }
  return parseCsv(new TextDecoder('utf-8').decode(bytes));
}

function isOle2(bytes) {
  return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b);
}

// ---------------------------------------------------------------- CSV / TSV

export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sample = lines.slice(0, 30);
  const delimiter = [',', '\t', ';', '|'].reduce(
    (best, d) => {
      const count = sample.reduce((n, l) => n + l.split(d).length - 1, 0);
      return count > best.count ? { d, count } : best;
    },
    { d: ',', count: -1 }
  ).d;

  return lines.map((line) => {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delimiter) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  });
}

// ---------------------------------------------------------------- .xls (BIFF8)

function concat(parts, total) {
  const out = new Uint8Array(total ?? parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Excel files are an OLE2 "compound file": a tiny filesystem of sectors. We only
// need to find the Workbook stream and return its bytes.
function readWorkbookStream(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const dirStart = dv.getUint32(0x30, true);
  const miniCutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3c, true);
  const difatStart = dv.getUint32(0x44, true);
  const numDifat = dv.getUint32(0x48, true);

  const sector = (id) => bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  const u32s = (buf) => {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return Array.from({ length: Math.floor(buf.length / 4) }, (_, i) => v.getUint32(i * 4, true));
  };

  const fatSectorIds = [];
  for (let i = 0; i < 109; i++) {
    const id = dv.getUint32(0x4c + i * 4, true);
    if (id < SPECIAL_SECTOR) fatSectorIds.push(id);
  }
  let difat = difatStart;
  for (let n = 0; n < numDifat && difat < SPECIAL_SECTOR; n++) {
    const entries = u32s(sector(difat));
    fatSectorIds.push(...entries.slice(0, -1).filter((id) => id < SPECIAL_SECTOR));
    difat = entries[entries.length - 1];
  }
  const fat = fatSectorIds.flatMap((id) => u32s(sector(id)));

  const chain = (start, table) => {
    const ids = [];
    for (let id = start; id < SPECIAL_SECTOR && ids.length <= table.length; id = table[id]) ids.push(id);
    return ids;
  };
  const readChain = (start) => concat(chain(start, fat).map(sector));

  const dir = readChain(dirStart);
  const dirView = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameBytes = dirView.getUint16(off + 0x40, true);
    let name = '';
    for (let i = 0; i < Math.max(0, nameBytes / 2 - 1); i++) name += String.fromCharCode(dirView.getUint16(off + i * 2, true));
    entries.push({ name, type: dir[off + 0x42], start: dirView.getUint32(off + 0x74, true), size: dirView.getUint32(off + 0x78, true) });
  }

  const target = entries.find((e) => e.type === 2 && (e.name === 'Workbook' || e.name === 'Book'));
  if (!target) throw new Error('No Excel workbook found in this file.');

  if (target.size >= miniCutoff) return readChain(target.start).subarray(0, target.size);

  // Small streams live in the "mini stream" owned by the root entry.
  const root = entries.find((e) => e.type === 5);
  const miniStream = readChain(root.start).subarray(0, root.size);
  const miniFat = u32s(readChain(miniFatStart));
  const parts = chain(target.start, miniFat).map((id) => miniStream.subarray(id * miniSize, (id + 1) * miniSize));
  return concat(parts).subarray(0, target.size);
}

// The shared-string table can be split across CONTINUE records; when a string's
// characters cross a record boundary the new record restarts with a 1-byte flag
// that re-declares 8-bit vs 16-bit characters.
function parseSharedStrings(chunks) {
  let ci = 0;
  let off = 0;
  const more = () => {
    while (ci < chunks.length && off >= chunks[ci].length) { ci++; off = 0; }
    return ci < chunks.length;
  };
  const u8 = () => { if (!more()) throw new Error('Unexpected end of string table'); return chunks[ci][off++]; };
  const u16 = () => u8() | (u8() << 8);
  const u32 = () => (u16() | (u16() << 16)) >>> 0;
  const skip = (n) => {
    while (n > 0 && more()) { const take = Math.min(n, chunks[ci].length - off); off += take; n -= take; }
  };

  u32(); // total reference count
  const unique = u32();
  const out = [];
  for (let i = 0; i < unique && more(); i++) {
    const cch = u16();
    const flags = u8();
    let wide = flags & 1;
    const runs = flags & 8 ? u16() : 0;
    const extLen = flags & 4 ? u32() : 0;
    let s = '';
    let left = cch;
    while (left > 0) {
      if (off >= chunks[ci].length) { ci++; off = 0; wide = chunks[ci][off++] & 1; }
      const width = wide ? 2 : 1;
      const take = Math.min(left, Math.floor((chunks[ci].length - off) / width));
      for (let k = 0; k < take; k++) {
        s += String.fromCharCode(wide ? chunks[ci][off] | (chunks[ci][off + 1] << 8) : chunks[ci][off]);
        off += width;
      }
      left -= take;
    }
    skip(runs * 4 + extLen);
    out.push(s);
  }
  return out;
}

function decodeRk(rk) {
  let v;
  if (rk & 2) v = (rk | 0) >> 2;
  else {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setUint32(4, rk & 0xfffffffc, true);
    v = dv.getFloat64(0, true);
  }
  return rk & 1 ? v / 100 : v;
}

export function parseXls(bytes) {
  const wb = readWorkbookStream(bytes);
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);

  let sst = [];
  const cells = new Map(); // "row,col" -> value
  let inSheet = false;
  let maxRow = -1;
  let maxCol = -1;
  const put = (r, c, v) => { cells.set(r * 65536 + c, v); maxRow = Math.max(maxRow, r); maxCol = Math.max(maxCol, c); };

  let pos = 0;
  while (pos + 4 <= wb.length) {
    const op = dv.getUint16(pos, true);
    const len = dv.getUint16(pos + 2, true);
    const start = pos + 4;
    pos = start + len;

    if (op === 0x0809) { // BOF
      const kind = dv.getUint16(start + 2, true);
      if (kind === 0x0010) { if (inSheet) break; inSheet = true; }
    } else if (op === 0x000a) { // EOF
      if (inSheet) break;
    } else if (op === 0x00fc) { // SST (+ CONTINUE records)
      const chunks = [wb.subarray(start, start + len)];
      while (pos + 4 <= wb.length && dv.getUint16(pos, true) === 0x003c) {
        const clen = dv.getUint16(pos + 2, true);
        chunks.push(wb.subarray(pos + 4, pos + 4 + clen));
        pos += 4 + clen;
      }
      sst = parseSharedStrings(chunks);
    } else if (inSheet) {
      if (op === 0x00fd) put(dv.getUint16(start, true), dv.getUint16(start + 2, true), sst[dv.getUint32(start + 6, true)] ?? ''); // LABELSST
      else if (op === 0x0203) put(dv.getUint16(start, true), dv.getUint16(start + 2, true), dv.getFloat64(start + 6, true)); // NUMBER
      else if (op === 0x027e) put(dv.getUint16(start, true), dv.getUint16(start + 2, true), decodeRk(dv.getUint32(start + 6, true))); // RK
      else if (op === 0x00bd) { // MULRK
        const row = dv.getUint16(start, true);
        const first = dv.getUint16(start + 2, true);
        const count = (len - 6) / 6;
        for (let i = 0; i < count; i++) put(row, first + i, decodeRk(dv.getUint32(start + 4 + i * 6 + 2, true)));
      }
    }
  }

  const rows = [];
  for (let r = 0; r <= maxRow; r++) {
    const row = [];
    for (let c = 0; c <= maxCol; c++) row.push(cells.get(r * 65536 + c) ?? '');
    rows.push(row);
  }
  return rows;
}

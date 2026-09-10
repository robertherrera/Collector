import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.TRAINSTASH_DATA_DIR
  ? path.resolve(process.env.TRAINSTASH_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'trainstash.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    status          TEXT NOT NULL DEFAULT 'owned',      -- owned | wishlist | sold
    category        TEXT NOT NULL DEFAULT 'locomotive', -- locomotive | rolling_stock | passenger | set | track | structure | accessory | other
    subtype         TEXT NOT NULL DEFAULT '',           -- e.g. Diesel, Steam, Boxcar, Caboose
    brand           TEXT NOT NULL DEFAULT '',
    scale           TEXT NOT NULL DEFAULT '',
    catalog_number  TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT '',           -- model / description, e.g. "SD70ACe"
    road_name       TEXT NOT NULL DEFAULT '',           -- railroad, e.g. "Union Pacific"
    road_number     TEXT NOT NULL DEFAULT '',
    dcc             TEXT NOT NULL DEFAULT 'na',         -- na | dc | dcc_ready | dcc | dcc_sound
    condition       TEXT NOT NULL DEFAULT '',           -- mint | excellent | good | fair | poor
    quantity        INTEGER NOT NULL DEFAULT 1,
    original_box    INTEGER NOT NULL DEFAULT 0,
    purchase_price  REAL,
    purchase_date   TEXT NOT NULL DEFAULT '',
    purchased_from  TEXT NOT NULL DEFAULT '',
    estimated_value REAL,
    sold_price      REAL,
    sold_date       TEXT NOT NULL DEFAULT '',
    location        TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    filename   TEXT,                                    -- local file in uploads/, or NULL for external URL
    url        TEXT,                                    -- external URL, or NULL for local file
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
  CREATE INDEX IF NOT EXISTS idx_photos_item ON photos(item_id);
`);

// ---------- Field definitions & validation ----------

export const STATUSES = ['owned', 'wishlist', 'sold'];
export const CATEGORIES = ['locomotive', 'rolling_stock', 'passenger', 'set', 'track', 'structure', 'accessory', 'other'];
export const DCC_OPTIONS = ['na', 'dc', 'dcc_ready', 'dcc', 'dcc_sound'];
export const CONDITIONS = ['', 'mint', 'excellent', 'good', 'fair', 'poor'];

const TEXT_FIELDS = [
  'subtype', 'brand', 'scale', 'catalog_number', 'name', 'road_name', 'road_number',
  'condition', 'purchase_date', 'purchased_from', 'sold_date', 'location', 'tags', 'notes',
];
const NUMBER_FIELDS = ['purchase_price', 'estimated_value', 'sold_price'];

function str(v, max = 2000) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}
function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function oneOf(v, list, fallback) {
  return list.includes(v) ? v : fallback;
}

/** Normalise + validate an incoming item payload. Returns a clean object or throws. */
export function cleanItem(input, existing = null) {
  const src = { ...(existing || {}), ...(input || {}) };
  const out = {};
  out.status = oneOf(src.status, STATUSES, 'owned');
  out.category = oneOf(src.category, CATEGORIES, 'locomotive');
  out.dcc = oneOf(src.dcc, DCC_OPTIONS, 'na');
  for (const f of TEXT_FIELDS) out[f] = str(src[f], f === 'notes' ? 10000 : 500);
  out.condition = oneOf(out.condition, CONDITIONS, '');
  for (const f of NUMBER_FIELDS) out[f] = num(src[f]);
  const q = parseInt(src.quantity, 10);
  out.quantity = Number.isFinite(q) && q >= 0 ? q : 1;
  out.original_box = src.original_box === true || src.original_box === 1 || src.original_box === '1' || src.original_box === 'true' ? 1 : 0;

  const hasIdentity = out.brand || out.name || out.catalog_number || out.road_name;
  if (!hasIdentity) {
    const err = new Error('Give the item at least a brand, model name, catalog number, or road name.');
    err.status = 400;
    throw err;
  }
  return out;
}

const ITEM_COLUMNS = [
  'status', 'category', 'subtype', 'brand', 'scale', 'catalog_number', 'name', 'road_name', 'road_number',
  'dcc', 'condition', 'quantity', 'original_box', 'purchase_price', 'purchase_date', 'purchased_from',
  'estimated_value', 'sold_price', 'sold_date', 'location', 'tags', 'notes',
];

// ---------- Prepared statements ----------

const insertItemStmt = db.prepare(
  `INSERT INTO items (${ITEM_COLUMNS.join(', ')}) VALUES (${ITEM_COLUMNS.map((c) => '@' + c).join(', ')})`,
);
const updateItemStmt = db.prepare(
  `UPDATE items SET ${ITEM_COLUMNS.map((c) => `${c} = @${c}`).join(', ')},
   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`,
);
const getItemStmt = db.prepare('SELECT * FROM items WHERE id = ?');
const listItemsStmt = db.prepare('SELECT * FROM items ORDER BY created_at DESC, id DESC');
const deleteItemStmt = db.prepare('DELETE FROM items WHERE id = ?');

const photosForItemStmt = db.prepare('SELECT * FROM photos WHERE item_id = ? ORDER BY is_primary DESC, id ASC');
const allPhotosStmt = db.prepare('SELECT * FROM photos ORDER BY item_id, is_primary DESC, id ASC');
const insertPhotoStmt = db.prepare('INSERT INTO photos (item_id, filename, url, is_primary) VALUES (?, ?, ?, ?)');
const getPhotoStmt = db.prepare('SELECT * FROM photos WHERE id = ? AND item_id = ?');
const deletePhotoStmt = db.prepare('DELETE FROM photos WHERE id = ?');
const clearPrimaryStmt = db.prepare('UPDATE photos SET is_primary = 0 WHERE item_id = ?');
const setPrimaryStmt = db.prepare('UPDATE photos SET is_primary = 1 WHERE id = ?');
const countPhotosStmt = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE item_id = ?');

function photoView(p) {
  return {
    id: p.id,
    item_id: p.item_id,
    src: p.filename ? `/uploads/${encodeURIComponent(p.filename)}` : p.url,
    external: !p.filename,
    is_primary: !!p.is_primary,
    created_at: p.created_at,
  };
}

function itemView(row, photos) {
  return { ...row, original_box: !!row.original_box, photos: photos.map(photoView) };
}

// ---------- Items ----------

export function listItems() {
  const rows = listItemsStmt.all();
  const byItem = new Map();
  for (const p of allPhotosStmt.all()) {
    if (!byItem.has(p.item_id)) byItem.set(p.item_id, []);
    byItem.get(p.item_id).push(p);
  }
  return rows.map((r) => itemView(r, byItem.get(r.id) || []));
}

export function getItem(id) {
  const row = getItemStmt.get(id);
  if (!row) return null;
  return itemView(row, photosForItemStmt.all(id));
}

export function createItem(input) {
  const clean = cleanItem(input);
  const res = insertItemStmt.run(clean);
  return getItem(Number(res.lastInsertRowid));
}

export function updateItem(id, input) {
  const existing = getItemStmt.get(id);
  if (!existing) return null;
  const clean = cleanItem(input, existing);
  updateItemStmt.run({ ...clean, id });
  return getItem(id);
}

export function deleteItem(id) {
  const photos = photosForItemStmt.all(id);
  const res = deleteItemStmt.run(id);
  if (res.changes === 0) return false;
  for (const p of photos) removeFile(p.filename);
  return true;
}

// ---------- Photos ----------

function removeFile(filename) {
  if (!filename) return;
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, filename));
  } catch {
    /* already gone */
  }
}

export function addPhoto(itemId, { filename = null, url = null }) {
  if (!getItemStmt.get(itemId)) return null;
  const isFirst = countPhotosStmt.get(itemId).n === 0;
  const res = insertPhotoStmt.run(itemId, filename, url, isFirst ? 1 : 0);
  return photoView({ id: Number(res.lastInsertRowid), item_id: itemId, filename, url, is_primary: isFirst ? 1 : 0 });
}

export function setPrimaryPhoto(itemId, photoId) {
  const p = getPhotoStmt.get(photoId, itemId);
  if (!p) return false;
  db.exec('BEGIN');
  try {
    clearPrimaryStmt.run(itemId);
    setPrimaryStmt.run(photoId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

export function deletePhoto(itemId, photoId) {
  const p = getPhotoStmt.get(photoId, itemId);
  if (!p) return false;
  deletePhotoStmt.run(photoId);
  removeFile(p.filename);
  if (p.is_primary) {
    const next = photosForItemStmt.get(itemId);
    if (next) setPrimaryStmt.run(next.id);
  }
  return true;
}

// ---------- Stats ----------

export function stats() {
  const items = listItems();
  const owned = items.filter((i) => i.status === 'owned');
  const sum = (arr, fn) => arr.reduce((a, i) => a + (fn(i) || 0), 0);
  const groupBy = (arr, key) => {
    const m = new Map();
    for (const i of arr) {
      const k = i[key] || 'Unspecified';
      const g = m.get(k) || { key: k, items: 0, pieces: 0, value: 0 };
      g.items += 1;
      g.pieces += i.quantity;
      g.value += (i.estimated_value || 0) * i.quantity;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.items - a.items || a.key.localeCompare(b.key));
  };
  return {
    items: owned.length,
    pieces: sum(owned, (i) => i.quantity),
    estimated_value: sum(owned, (i) => (i.estimated_value || 0) * i.quantity),
    invested: sum(owned, (i) => (i.purchase_price || 0) * i.quantity),
    wishlist: items.filter((i) => i.status === 'wishlist').length,
    wishlist_value: sum(items.filter((i) => i.status === 'wishlist'), (i) => (i.estimated_value || 0) * i.quantity),
    sold: items.filter((i) => i.status === 'sold').length,
    sold_total: sum(items.filter((i) => i.status === 'sold'), (i) => (i.sold_price || 0) * i.quantity),
    by_brand: groupBy(owned, 'brand'),
    by_scale: groupBy(owned, 'scale'),
    by_category: groupBy(owned, 'category'),
    by_dcc: groupBy(owned, 'dcc'),
    by_road: groupBy(owned, 'road_name'),
    recent: owned.slice(0, 6),
    with_photos: owned.filter((i) => i.photos.length > 0).length,
  };
}

// ---------- Backup / restore ----------

export function exportAll() {
  return { version: 1, exported_at: new Date().toISOString(), items: listItems() };
}

/**
 * Restore from a backup. mode = 'merge' (default) appends items; 'replace' wipes first.
 * Local photo files are not part of the JSON; external URL photos are restored.
 */
export function importAll(payload, mode = 'merge') {
  const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : null;
  if (!items) {
    const err = new Error('Backup must be a JSON object with an "items" array.');
    err.status = 400;
    throw err;
  }
  let imported = 0;
  db.exec('BEGIN');
  try {
    if (mode === 'replace') {
      for (const p of allPhotosStmt.all()) removeFile(p.filename);
      db.exec('DELETE FROM photos; DELETE FROM items;');
    }
    for (const raw of items) {
      let clean;
      try {
        clean = cleanItem(raw);
      } catch {
        continue; // skip junk rows
      }
      const res = insertItemStmt.run(clean);
      const id = Number(res.lastInsertRowid);
      const photos = Array.isArray(raw.photos) ? raw.photos : [];
      let first = true;
      for (const p of photos) {
        const url = typeof p === 'string' ? p : p?.src || p?.url;
        if (!url || !/^https?:\/\//i.test(url)) continue;
        insertPhotoStmt.run(id, null, url, first ? 1 : 0);
        first = false;
      }
      imported += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { imported, skipped: items.length - imported };
}

const CSV_COLUMNS = ['id', ...ITEM_COLUMNS, 'created_at', 'updated_at', 'photo_urls'];

export function exportCsv() {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(',')];
  for (const it of listItems()) {
    const row = CSV_COLUMNS.map((c) => (c === 'photo_urls' ? it.photos.map((p) => p.src).join(' ') : it[c]));
    lines.push(row.map(esc).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

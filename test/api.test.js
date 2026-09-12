import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4499;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'train-collection-test-'));
let server;

async function waitForServer(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/options`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
const json = async (method, p, body, type = 'application/json') => {
  const res = await fetch(BASE + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': type } : {},
    body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), res };
};

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    env: { ...process.env, PORT: String(PORT), TRAIN_COLLECTION_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  await waitForServer();
});
after(() => {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('rejects an item with no identity', async () => {
  const r = await json('POST', '/api/items', { notes: 'nothing' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /brand/);
});

test('creates, reads, updates and deletes an item', async () => {
  const create = await json('POST', '/api/items', {
    brand: 'Kato', scale: 'N', catalog_number: '176-8524', name: 'SD70ACe', road_name: 'Union Pacific',
    purchase_price: '189.99', estimated_value: 210, quantity: '2', original_box: true, dcc: 'dcc_sound', condition: 'excellent',
  });
  assert.equal(create.status, 201);
  const it = create.body;
  assert.equal(it.purchase_price, 189.99);
  assert.equal(it.quantity, 2);
  assert.equal(it.original_box, true);
  assert.equal(it.status, 'owned');

  const read = await json('GET', `/api/items/${it.id}`);
  assert.equal(read.body.brand, 'Kato');

  const upd = await json('PUT', `/api/items/${it.id}`, { status: 'wishlist', condition: 'bogus' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.status, 'wishlist');
  assert.equal(upd.body.condition, '', 'invalid condition falls back to unrated');
  assert.equal(upd.body.brand, 'Kato', 'partial update keeps other fields');

  const del = await json('DELETE', `/api/items/${it.id}`);
  assert.equal(del.status, 204);
  assert.equal((await json('GET', `/api/items/${it.id}`)).status, 404);
});

test('photos: upload, url, primary, delete, cascade', async () => {
  const { body: it } = await json('POST', '/api/items', { brand: 'Athearn', name: 'Big Boy' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const up = await json('POST', `/api/items/${it.id}/photos`, png, 'image/png');
  assert.equal(up.status, 201);
  assert.equal(up.body.is_primary, true);
  assert.match(up.body.src, /^\/uploads\/.+\.png$/);
  assert.equal((await fetch(BASE + up.body.src)).status, 200);

  const bad = await json('POST', `/api/items/${it.id}/photos`, Buffer.from('x'), 'text/plain');
  assert.equal(bad.status, 415);

  const url = await json('POST', `/api/items/${it.id}/photos/url`, { url: 'https://example.com/a.jpg' });
  assert.equal(url.status, 201);
  assert.equal(url.body.is_primary, false);
  assert.equal((await json('POST', `/api/items/${it.id}/photos/url`, { url: 'nope' })).status, 400);

  assert.equal((await json('PUT', `/api/items/${it.id}/photos/${url.body.id}/primary`)).status, 200);
  let item = (await json('GET', `/api/items/${it.id}`)).body;
  assert.equal(item.photos[0].id, url.body.id, 'primary sorts first');
  assert.equal(item.photos.filter((p) => p.is_primary).length, 1);

  assert.equal((await json('DELETE', `/api/items/${it.id}/photos/${url.body.id}`)).status, 204);
  item = (await json('GET', `/api/items/${it.id}`)).body;
  assert.equal(item.photos.length, 1);
  assert.equal(item.photos[0].is_primary, true, 'primary passes to remaining photo');

  await json('DELETE', `/api/items/${it.id}`);
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 0, 'deleting the item removes its files');
});

test('stats, export and import', async () => {
  await json('POST', '/api/items', { brand: 'Kato', scale: 'N', estimated_value: 100, purchase_price: 80, quantity: 2 });
  await json('POST', '/api/items', { brand: 'Lionel', scale: 'O', estimated_value: 50, status: 'wishlist' });
  const s = (await json('GET', '/api/stats')).body;
  assert.equal(s.items, 1);
  assert.equal(s.pieces, 2);
  assert.equal(s.estimated_value, 200);
  assert.equal(s.invested, 160);
  assert.equal(s.wishlist, 1);
  assert.equal(s.by_brand[0].key, 'Kato');

  const csv = await (await fetch(`${BASE}/api/export.csv`)).text();
  assert.match(csv.split('\r\n')[0], /^id,status,category/);
  assert.match(csv, /Kato,N/);

  const backup = (await json('GET', '/api/export.json')).body;
  assert.equal(backup.items.length, 2);

  const merged = await json('POST', '/api/import', backup);
  assert.equal(merged.body.imported, 2);
  assert.equal((await json('GET', '/api/items')).body.length, 4);

  const replaced = await json('POST', '/api/import?mode=replace', { items: [{ brand: 'Rapido', photos: ['https://example.com/x.jpg'] }, { notes: 'junk' }] });
  assert.deepEqual(replaced.body, { imported: 1, skipped: 1 });
  const all = (await json('GET', '/api/items')).body;
  assert.equal(all.length, 1);
  assert.equal(all[0].photos[0].src, 'https://example.com/x.jpg');
});

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4400;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
};

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));

// ---------- helpers ----------

const idParam = (req) => {
  const id = Number.parseInt(req.params.id, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const notFound = (res, what = 'Item') => res.status(404).json({ error: `${what} not found` });

// ---------- API: items ----------

app.get('/api/items', (_req, res) => res.json(store.listItems()));

app.get('/api/items/:id', (req, res) => {
  const id = idParam(req);
  const item = id && store.getItem(id);
  return item ? res.json(item) : notFound(res);
});

app.post('/api/items', (req, res) => res.status(201).json(store.createItem(req.body)));

app.put('/api/items/:id', (req, res) => {
  const id = idParam(req);
  const item = id && store.updateItem(id, req.body);
  return item ? res.json(item) : notFound(res);
});

app.delete('/api/items/:id', (req, res) => {
  const id = idParam(req);
  return id && store.deleteItem(id) ? res.status(204).end() : notFound(res);
});

// ---------- API: photos ----------

// Upload: send the raw image bytes as the request body with the image's Content-Type.
app.post('/api/items/:id/photos', express.raw({ type: 'image/*', limit: MAX_PHOTO_BYTES }), (req, res) => {
  const id = idParam(req);
  if (!id || !store.getItem(id)) return notFound(res);
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[mime];
  if (!ext) return res.status(415).json({ error: 'Unsupported image type. Use JPEG, PNG, WebP, GIF, HEIC or AVIF.' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Empty upload' });
  const filename = `${id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(store.UPLOAD_DIR, filename), req.body);
  res.status(201).json(store.addPhoto(id, { filename }));
});

app.post('/api/items/:id/photos/url', (req, res) => {
  const id = idParam(req);
  if (!id || !store.getItem(id)) return notFound(res);
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return res.status(400).json({ error: 'Enter a valid http(s) image URL' });
  res.status(201).json(store.addPhoto(id, { url }));
});

app.put('/api/items/:id/photos/:pid/primary', (req, res) => {
  const id = idParam(req);
  const pid = Number.parseInt(req.params.pid, 10);
  return id && store.setPrimaryPhoto(id, pid) ? res.json({ ok: true }) : notFound(res, 'Photo');
});

app.delete('/api/items/:id/photos/:pid', (req, res) => {
  const id = idParam(req);
  const pid = Number.parseInt(req.params.pid, 10);
  return id && store.deletePhoto(id, pid) ? res.status(204).end() : notFound(res, 'Photo');
});

// ---------- API: stats, backup, export ----------

app.get('/api/stats', (_req, res) => res.json(store.stats()));

app.get('/api/export.json', (_req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="train-collection-backup-${today()}.json"`);
  res.json(store.exportAll());
});

app.get('/api/export.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="train-collection-${today()}.csv"`);
  res.send(store.exportCsv());
});

app.post('/api/import', (req, res) => {
  const mode = req.query.mode === 'replace' ? 'replace' : 'merge';
  res.json(store.importAll(req.body, mode));
});

app.get('/api/options', (_req, res) =>
  res.json({
    statuses: store.STATUSES,
    categories: store.CATEGORIES,
    dcc: store.DCC_OPTIONS,
    conditions: store.CONDITIONS.filter(Boolean),
  }),
);

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint' }));

// ---------- static ----------

app.use('/uploads', express.static(store.UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- errors ----------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

app.listen(PORT, HOST, () => {
  console.log(`\n  🚂  Train Collection is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`      Data lives in ${store.DATA_DIR}\n`);
});

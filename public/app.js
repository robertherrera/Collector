/* TrainStash — front-end. Plain JS, no build step. */
(() => {
  'use strict';

  // ---------- constants ----------
  const CATEGORY = {
    locomotive: 'Locomotive', rolling_stock: 'Freight car', passenger: 'Passenger car', set: 'Train set',
    track: 'Track', structure: 'Structure', accessory: 'Accessory', other: 'Other',
  };
  const DCC = { na: '', dc: 'DC', dcc_ready: 'DCC ready', dcc: 'DCC', dcc_sound: 'DCC + Sound' };
  const CONDITION = { mint: 'Mint', excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor' };
  const STATUS = { owned: 'In collection', wishlist: 'Wishlist', sold: 'Sold' };
  const FILTER_KEYS = ['brand', 'scale', 'category', 'dcc', 'location'];

  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const money2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const fmtMoney = (n, cents = false) => (n === null || n === undefined ? '—' : (cents ? money2 : money).format(n));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---------- state ----------
  const state = {
    items: [],
    stats: null,
    view: 'collection',
    q: '',
    filters: { brand: '', scale: '', category: '', dcc: '', location: '' },
    sort: localStorage.getItem('ts.sort') || 'newest',
    layout: localStorage.getItem('ts.layout') || 'grid',
    selectedId: null,
    heroIndex: 0,
    edit: null, // { id, photos, pending: [{file, preview}], pendingUrls: [] }
  };

  // ---------- api ----------
  async function api(method, url, body, headers = {}) {
    const opts = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (body instanceof Blob || body instanceof ArrayBuffer) {
        opts.body = body;
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, opts);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function load() {
    const [items, stats] = await Promise.all([api('GET', '/api/items'), api('GET', '/api/stats')]);
    state.items = items;
    state.stats = stats;
    render();
  }

  // ---------- helpers ----------
  const title = (it) => {
    const road = it.road_name.trim();
    const name = it.name.trim();
    const dup = road && name && name.toLowerCase().includes(road.toLowerCase());
    return [dup ? '' : road, name].filter(Boolean).join(' ') || it.catalog_number || it.brand || 'Untitled';
  };
  const primaryPhoto = (it) => it.photos.find((p) => p.is_primary) || it.photos[0] || null;
  const tags = (it) => it.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const unitValue = (it) => (it.status === 'sold' ? it.sold_price ?? it.estimated_value : it.estimated_value);

  function visibleItems() {
    const status = state.view === 'wishlist' ? 'wishlist' : 'owned';
    const q = state.q.trim().toLowerCase();
    let list = state.items.filter((it) => it.status === status || (state.view === 'collection' && it.status === 'sold' && state.filters.showSold));
    if (q) {
      list = list.filter((it) =>
        [it.brand, it.scale, it.catalog_number, it.name, it.road_name, it.road_number, it.subtype, it.location, it.tags, it.notes, it.purchased_from, CATEGORY[it.category], DCC[it.dcc]]
          .join(' ')
          .toLowerCase()
          .includes(q),
      );
    }
    for (const k of FILTER_KEYS) if (state.filters[k]) list = list.filter((it) => (it[k] || '') === state.filters[k]);

    const cmpText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    const sorters = {
      newest: (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
      oldest: (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
      value_desc: (a, b) => (b.estimated_value ?? -1) - (a.estimated_value ?? -1),
      value_asc: (a, b) => (a.estimated_value ?? Infinity) - (b.estimated_value ?? Infinity),
      brand: (a, b) => cmpText(a.brand, b.brand) || cmpText(title(a), title(b)),
      road: (a, b) => cmpText(a.road_name, b.road_name) || cmpText(a.road_number, b.road_number),
      catalog: (a, b) => cmpText(a.catalog_number, b.catalog_number),
    };
    return list.sort(sorters[state.sort] || sorters.newest);
  }

  // ---------- render: shell ----------
  function render() {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === state.view));
    $('#view-collection').hidden = state.view === 'insights';
    $('#view-insights').hidden = state.view !== 'insights';
    const wl = state.stats?.wishlist || 0;
    const wc = $('#wishlistCount');
    wc.hidden = !wl;
    wc.textContent = wl;

    if (state.view === 'insights') return renderInsights();

    $('#viewTitle').textContent = state.view === 'wishlist' ? 'Wishlist' : 'Your collection';
    $('#viewSubtitle').textContent = state.view === 'wishlist' ? 'The ones that got away — for now.' : 'Everything on the roster, at a glance.';
    renderStats();
    renderFilters();
    renderGrid();
    renderDatalists();
  }

  function renderStats() {
    const s = state.stats;
    if (!s) return;
    const icon = {
      box: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg>',
      train: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M9 20l-1.5 2M15 20l1.5 2M8 16l-1 4h10l-1-4"/><circle cx="9" cy="13" r=".8"/><circle cx="15" cy="13" r=".8"/></svg>',
      trend: '<svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8M15 7h6v6"/></svg>',
      wallet: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 15h2"/></svg>',
      heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
    };
    const tile = (label, value, sub, ic) =>
      `<div class="stat"><div class="stat-label"><span>${label}</span>${icon[ic]}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
    let html;
    if (state.view === 'wishlist') {
      html =
        tile('Wanted', s.wishlist, s.wishlist === 1 ? 'item on the list' : 'items on the list', 'heart') +
        tile('Estimated cost', fmtMoney(s.wishlist_value), 'to buy everything', 'wallet') +
        tile('Collection', s.items, 'items you already own', 'train') +
        tile('Collection value', fmtMoney(s.estimated_value), 'estimated today', 'trend');
    } else {
      const gain = s.estimated_value - s.invested;
      html =
        tile('Items', s.items, s.pieces === s.items ? 'catalogued' : `${s.pieces} pieces in total`, 'train') +
        tile('Collection value', fmtMoney(s.estimated_value), s.with_photos ? `${s.with_photos} of ${s.items} photographed` : 'estimated today', 'trend') +
        tile('Invested', fmtMoney(s.invested), s.invested ? `${gain >= 0 ? '+' : '−'}${fmtMoney(Math.abs(gain))} vs. paid` : 'purchase prices', 'wallet') +
        tile('Wishlist', s.wishlist, s.wishlist ? `${fmtMoney(s.wishlist_value)} to complete` : 'nothing wanted yet', 'heart');
    }
    $('#statsStrip').innerHTML = html;
  }

  function renderFilters() {
    const status = state.view === 'wishlist' ? 'wishlist' : 'owned';
    const pool = state.items.filter((it) => it.status === status || (status === 'owned' && it.status === 'sold'));
    const labelFor = { brand: 'Brand', scale: 'Scale', category: 'Category', dcc: 'Control', location: 'Location' };
    const display = { category: (v) => CATEGORY[v] || v, dcc: (v) => DCC[v] || 'N/A' };
    const chips = FILTER_KEYS.map((k) => {
      const vals = [...new Set(pool.map((it) => it[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!vals.length) return '';
      const cur = state.filters[k];
      const opts = vals.map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc((display[k] || ((x) => x))(v))}</option>`).join('');
      return `<label class="chip ${cur ? 'is-active' : ''}"><span>${labelFor[k]}</span><select data-filter="${k}"><option value="">All</option>${opts}</select>
        <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></label>`;
    });
    const soldCount = state.items.filter((i) => i.status === 'sold').length;
    if (state.view === 'collection' && soldCount) {
      chips.push(`<button type="button" class="chip ${state.filters.showSold ? 'is-active' : ''}" data-toggle="showSold">Include sold (${soldCount})</button>`);
    }
    const any = FILTER_KEYS.some((k) => state.filters[k]) || state.q;
    if (any) chips.push('<button type="button" class="chip" data-clear>Clear <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>');
    $('#filters').innerHTML = chips.join('');
    $('#sortSelect').value = state.sort;
    $$('.seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.layout === state.layout));
  }

  function cardHtml(it) {
    const p = primaryPhoto(it);
    const media = p
      ? `<img src="${esc(p.src)}" alt="" loading="lazy" />`
      : `<div class="placeholder">${it.scale ? `<span class="mono">${esc(it.scale)}</span>` : '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M8 16l-1 4h10l-1-4"/></svg>'}<span>No photo yet</span></div>`;
    const eyebrow = [it.brand, CATEGORY[it.category]].filter(Boolean);
    const pills = [];
    if (DCC[it.dcc]) pills.push(`<span class="pill dcc">${DCC[it.dcc]}</span>`);
    if (it.condition) pills.push(`<span class="pill cond-${it.condition}">${CONDITION[it.condition]}</span>`);
    if (it.subtype) pills.push(`<span class="pill">${esc(it.subtype)}</span>`);
    if (it.original_box) pills.push('<span class="pill box">Boxed</span>');
    const sub = [
      it.catalog_number ? `<span class="mono">#${esc(it.catalog_number)}</span>` : '',
      it.road_number ? `<span>No. ${esc(it.road_number)}</span>` : '',
      it.location ? `<span>· ${esc(it.location)}</span>` : '',
    ].filter(Boolean).join('');
    const value = unitValue(it);
    return `<button type="button" class="card" data-id="${it.id}">
      <div class="card-media">${media}
        ${p && it.scale ? `<span class="badge-scale">${esc(it.scale)}</span>` : ''}
        ${it.status !== 'owned' ? `<span class="badge-status ${it.status}">${STATUS[it.status]}</span>` : ''}
        ${it.photos.length > 1 ? `<span class="photo-count"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 15 5-5 4 4 3-3 6 6"/></svg>${it.photos.length}</span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-main">
          <div class="card-eyebrow">${eyebrow.map(esc).join('<span class="dot"></span>')}</div>
          <div class="card-title">${esc(title(it))}</div>
          <div class="card-sub">${sub}</div>
        </div>
        ${pills.length ? `<div class="tagrow">${pills.join('')}</div>` : ''}
        <div class="card-foot">
          <span class="value">${value !== null && value !== undefined ? fmtMoney(value) : '<span class="muted" style="font-weight:500;font-size:13px">No value set</span>'}</span>
          <span class="qty">${it.quantity !== 1 ? `Qty ${it.quantity}` : it.status === 'sold' ? 'Sold' : ''}</span>
        </div>
      </div>
    </button>`;
  }

  function renderGrid() {
    const list = visibleItems();
    const grid = $('#itemGrid');
    const empty = $('#emptyState');
    grid.classList.toggle('is-list', state.layout === 'list');
    grid.innerHTML = list.map(cardHtml).join('');
    const total = state.items.filter((i) => i.status === (state.view === 'wishlist' ? 'wishlist' : 'owned')).length;
    $('#resultCount').textContent = total ? `${list.length === total ? total : `${list.length} of ${total}`} ${total === 1 ? 'item' : 'items'}` : '';
    empty.hidden = list.length > 0;
    if (!list.length) {
      const filtered = total > 0;
      empty.innerHTML = filtered
        ? `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><h2>Nothing matches</h2><p>Try a different search or clear the filters.</p><button type="button" class="btn" data-clear>Clear filters</button>`
        : state.view === 'wishlist'
          ? `<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg><h2>Your wishlist is empty</h2><p>Add the models you're hunting for and track what they'd cost.</p><button type="button" class="btn btn-primary" data-add="wishlist">Add to wishlist</button>`
          : `<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M9 20l-1.5 2M15 20l1.5 2M8 16l-1 4h10l-1-4"/></svg><h2>No trains yet</h2><p>Start your roster: add a locomotive, a car, or a whole set.</p><button type="button" class="btn btn-primary" data-add="owned">Add your first train</button>`;
    }
  }

  function renderDatalists() {
    const fill = (id, key) => {
      const vals = [...new Set(state.items.map((i) => i[key]).filter(Boolean))].sort();
      $(id).innerHTML = vals.map((v) => `<option value="${esc(v)}"></option>`).join('');
    };
    fill('#brandList', 'brand');
    fill('#roadList', 'road_name');
    fill('#locationList', 'location');
  }

  // ---------- render: insights ----------
  function renderInsights() {
    const s = state.stats;
    if (!s) return;
    const bars = (rows, { metric = 'items', money: isMoney = false, label = (k) => k, max = 8 } = {}) => {
      const top = rows.slice(0, max);
      const peak = Math.max(...top.map((r) => r[metric]), 1);
      if (!top.length) return '<p class="muted">Nothing to show yet.</p>';
      return `<div class="bars">${top
        .map((r) => `<div class="bar"><span class="bar-label" title="${esc(label(r.key))}">${esc(label(r.key))}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${(r[metric] / peak) * 100}%"></span></span>
          <span class="bar-num"><strong>${isMoney ? fmtMoney(r[metric]) : r[metric]}</strong>${isMoney ? '' : ` · ${fmtMoney(r.value)}`}</span></div>`)
        .join('')}</div>`;
    };
    const panel = (h, body, wide = false) => `<div class="panel ${wide ? 'wide' : ''}"><h3>${h}</h3>${body}</div>`;
    const recent = s.recent.length
      ? `<div class="mini-list">${s.recent.map((it) => `<button type="button" data-id="${it.id}"><span><span class="t">${esc(title(it))}</span><br><span class="s">${esc([it.brand, it.scale, it.catalog_number && '#' + it.catalog_number].filter(Boolean).join(' · '))}</span></span><span class="s">${fmtMoney(it.estimated_value)}</span></button>`).join('')}</div>`
      : '<p class="muted">Nothing added yet.</p>';
    const gain = s.estimated_value - s.invested;
    const summary = `<div class="stats" style="margin:0 0 4px">
      <div class="stat"><div class="stat-label">Estimated value</div><div class="stat-value">${fmtMoney(s.estimated_value)}</div><div class="stat-sub">${s.items} items · ${s.pieces} pieces</div></div>
      <div class="stat"><div class="stat-label">Invested</div><div class="stat-value">${fmtMoney(s.invested)}</div><div class="stat-sub">${gain >= 0 ? 'Up' : 'Down'} ${fmtMoney(Math.abs(gain))} on paper</div></div>
      <div class="stat"><div class="stat-label">Sold</div><div class="stat-value">${fmtMoney(s.sold_total)}</div><div class="stat-sub">${s.sold} ${s.sold === 1 ? 'item' : 'items'} moved on</div></div>
      <div class="stat"><div class="stat-label">Wishlist</div><div class="stat-value">${fmtMoney(s.wishlist_value)}</div><div class="stat-sub">${s.wishlist} ${s.wishlist === 1 ? 'item' : 'items'} wanted</div></div>
    </div>`;
    $('#insights').innerHTML = `${summary}<div class="insight-grid">
      ${panel('By brand', bars(s.by_brand))}
      ${panel('By scale', bars(s.by_scale))}
      ${panel('By category', bars(s.by_category, { label: (k) => CATEGORY[k] || k }))}
      ${panel('By railroad', bars(s.by_road))}
      ${panel('Value by brand', bars([...s.by_brand].sort((a, b) => b.value - a.value), { metric: 'value', money: true }))}
      ${panel('Control', bars(s.by_dcc, { label: (k) => DCC[k] || 'Not applicable' }))}
      ${panel('Recently added', recent, true)}
    </div>`;
  }

  // ---------- drawer ----------
  function openDrawer(id) {
    state.selectedId = id;
    state.heroIndex = 0;
    renderDrawer();
    $('#drawer').hidden = false;
    $('#drawerBackdrop').hidden = false;
    $('#drawer').scrollTop = 0;
  }
  function closeDrawer() {
    state.selectedId = null;
    $('#drawer').hidden = true;
    $('#drawerBackdrop').hidden = true;
  }
  function renderDrawer() {
    const it = state.items.find((i) => i.id === state.selectedId);
    if (!it) return closeDrawer();
    const photos = it.photos;
    const hero = photos[state.heroIndex] || photos[0];
    const kv = (label, val, cls = '') => (val === null || val === undefined || val === '' ? '' : `<div class="${cls}"><dt>${label}</dt><dd class="${cls}">${val}</dd></div>`);
    const paidTotal = it.purchase_price !== null ? it.purchase_price * it.quantity : null;
    const html = `
      <div class="drawer-hero ${hero ? '' : 'is-empty'}">
        ${hero ? `<img src="${esc(hero.src)}" alt="" />` : `<div class="placeholder"><svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M9 20l-1.5 2M15 20l1.5 2M8 16l-1 4h10l-1-4"/></svg></div>`}
        <button type="button" class="icon-btn drawer-close" data-close-drawer aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      ${photos.length > 1 ? `<div class="drawer-thumbs">${photos.map((p, i) => `<button type="button" class="${i === state.heroIndex ? 'is-active' : ''}" data-hero="${i}"><img src="${esc(p.src)}" alt="" /></button>`).join('')}</div>` : ''}
      <div class="drawer-body">
        <div class="drawer-eyebrow">
          ${it.scale ? `<span class="pill" style="font-family:var(--mono)">${esc(it.scale)}</span>` : ''}
          <span class="card-eyebrow">${[it.brand, CATEGORY[it.category], it.subtype].filter(Boolean).map(esc).join('<span class="dot"></span>')}</span>
          ${it.status !== 'owned' ? `<span class="pill" style="margin-left:auto">${STATUS[it.status]}</span>` : ''}
        </div>
        <h2 class="drawer-title">${esc(title(it))}</h2>
        <p class="drawer-sub">${[it.catalog_number && `Catalog #${it.catalog_number}`, it.road_number && `Road No. ${it.road_number}`].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</p>
        <div class="tagrow">
          ${DCC[it.dcc] ? `<span class="pill dcc">${DCC[it.dcc]}</span>` : ''}
          ${it.condition ? `<span class="pill cond-${it.condition}">${CONDITION[it.condition]}</span>` : ''}
          ${it.original_box ? '<span class="pill">Original box</span>' : ''}
          ${tags(it).map((t) => `<span class="pill">#${esc(t)}</span>`).join('')}
        </div>
        <div class="drawer-actions">
          <button type="button" class="btn btn-sm btn-primary" data-edit="${it.id}"><svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4"/></svg>Edit</button>
          ${it.status === 'wishlist' ? `<button type="button" class="btn btn-sm" data-move="owned">Got it! Move to collection</button>` : ''}
          ${it.status === 'owned' ? `<button type="button" class="btn btn-sm" data-move="wishlist">Move to wishlist</button><button type="button" class="btn btn-sm" data-move="sold">Mark sold</button>` : ''}
          ${it.status === 'sold' ? `<button type="button" class="btn btn-sm" data-move="owned">Back to collection</button>` : ''}
          <button type="button" class="btn btn-sm" data-duplicate="${it.id}">Duplicate</button>
          <button type="button" class="btn btn-sm btn-danger" data-delete="${it.id}" style="margin-left:auto">Delete</button>
        </div>
        <dl class="kv">
          ${kv('Estimated value', fmtMoney(it.estimated_value, true), 'big')}
          ${kv('Quantity', it.quantity, 'big')}
          ${kv('Paid', it.purchase_price !== null ? fmtMoney(it.purchase_price, true) + (it.quantity > 1 ? ` <span class="muted">(${fmtMoney(paidTotal, true)} total)</span>` : '') : null)}
          ${kv('Purchased', esc([it.purchase_date, it.purchased_from].filter(Boolean).join(' · ')))}
          ${it.status === 'sold' ? kv('Sold', esc([it.sold_price !== null ? fmtMoney(it.sold_price, true) : '', it.sold_date].filter(Boolean).join(' · '))) : ''}
          ${kv('Location', esc(it.location))}
          ${kv('Notes', esc(it.notes), 'wide notes-box')}
        </dl>
        <p class="drawer-meta">Added ${new Date(it.created_at).toLocaleDateString()} · Updated ${new Date(it.updated_at).toLocaleDateString()}</p>
      </div>`;
    $('#drawerContent').innerHTML = html;
  }

  // ---------- modal / form ----------
  const form = $('#itemForm');
  function openModal(item = null, { status = 'owned', duplicateOf = null } = {}) {
    const src = item || duplicateOf;
    state.edit = { id: item ? item.id : null, photos: item ? [...item.photos] : [], pending: [], pendingUrls: [] };
    form.reset();
    $('#formError').textContent = '';
    $('#modalTitle').textContent = item ? 'Edit train' : duplicateOf ? 'Duplicate train' : 'Add train';
    $('#modalSubtitle').textContent = item ? `Update the details for ${title(item)}.` : 'Only one identifying field is required. Fill in what you know.';
    $('#modalSave').textContent = item ? 'Save changes' : 'Save train';
    if (src) {
      for (const el of form.elements) {
        if (!el.name || !(el.name in src)) continue;
        if (el.type === 'checkbox') el.checked = !!src[el.name];
        else if (el.type === 'radio') el.checked = el.value === src[el.name];
        else el.value = src[el.name] ?? '';
      }
      if (duplicateOf) form.elements.road_number.value = '';
    } else {
      form.elements.status.value = status;
    }
    syncStatusClass();
    renderThumbs();
    $('#modalBackdrop').hidden = false;
    setTimeout(() => form.elements.brand.focus(), 30);
  }
  function closeModal() {
    if (state.edit) state.edit.pending.forEach((p) => URL.revokeObjectURL(p.preview));
    state.edit = null;
    $('#modalBackdrop').hidden = true;
  }
  function syncStatusClass() {
    form.classList.toggle('is-sold', form.elements.status.value === 'sold');
  }
  function renderThumbs() {
    const e = state.edit;
    const html = [
      ...e.photos.map((p) => `<div class="thumb ${p.is_primary ? 'is-primary' : ''}"><img src="${esc(p.src)}" alt="" />${p.is_primary ? '<span class="star">Cover</span>' : ''}
        <div class="thumb-actions">${p.is_primary ? '<span></span>' : `<button type="button" data-photo-primary="${p.id}">Set cover</button>`}<button type="button" data-photo-delete="${p.id}">Remove</button></div></div>`),
      ...e.pending.map((p, i) => `<div class="thumb"><img src="${p.preview}" alt="" /><span class="pending">Pending</span><div class="thumb-actions"><span></span><button type="button" data-pending-remove="${i}">Remove</button></div></div>`),
      ...e.pendingUrls.map((u, i) => `<div class="thumb"><img src="${esc(u)}" alt="" /><span class="pending">Pending</span><div class="thumb-actions"><span></span><button type="button" data-pending-url-remove="${i}">Remove</button></div></div>`),
    ];
    $('#photoThumbs').innerHTML = html.join('');
  }
  function formData() {
    const fd = new FormData(form);
    const data = Object.fromEntries(fd.entries());
    data.original_box = form.elements.original_box.checked;
    return data;
  }
  async function uploadFile(itemId, file) {
    return api('POST', `/api/items/${itemId}/photos`, file, { 'Content-Type': file.type || 'application/octet-stream' });
  }
  async function submitForm(ev) {
    ev.preventDefault();
    const btn = $('#modalSave');
    btn.disabled = true;
    $('#formError').textContent = '';
    try {
      const data = formData();
      const e = state.edit;
      const saved = e.id ? await api('PUT', `/api/items/${e.id}`, data) : await api('POST', '/api/items', data);
      let failed = 0;
      for (const p of e.pending) {
        try { await uploadFile(saved.id, p.file); } catch { failed += 1; }
      }
      for (const u of e.pendingUrls) {
        try { await api('POST', `/api/items/${saved.id}/photos/url`, { url: u }); } catch { failed += 1; }
      }
      closeModal();
      await load();
      if (state.selectedId === saved.id) renderDrawer();
      toast(e.id ? 'Changes saved' : `Added ${title(saved)}`);
      if (failed) toast(`${failed} photo${failed > 1 ? 's' : ''} failed to upload`, true);
      if (!e.id && saved.status !== (state.view === 'wishlist' ? 'wishlist' : 'owned') && state.view !== 'insights') {
        setView(saved.status === 'wishlist' ? 'wishlist' : 'collection');
      }
    } catch (err) {
      $('#formError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }
  async function addFiles(files) {
    const e = state.edit;
    const imgs = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (!imgs.length) return toast('Pick an image file', true);
    if (e.id) {
      for (const f of imgs) {
        try {
          const p = await uploadFile(e.id, f);
          e.photos.push(p);
          toast(`Uploaded ${f.name}`);
        } catch (err) {
          toast(err.message, true);
        }
      }
      renderThumbs();
      await load();
      if (state.selectedId === e.id) renderDrawer();
    } else {
      for (const f of imgs) e.pending.push({ file: f, preview: URL.createObjectURL(f) });
      renderThumbs();
    }
  }

  // ---------- actions ----------
  async function moveItem(id, status) {
    await api('PUT', `/api/items/${id}`, { status });
    await load();
    if (state.selectedId === id) renderDrawer();
    toast(status === 'owned' ? 'Moved to your collection' : status === 'wishlist' ? 'Moved to wishlist' : 'Marked as sold');
  }
  async function deleteItem(id) {
    const it = state.items.find((i) => i.id === id);
    if (!it || !confirm(`Delete "${title(it)}"? This also removes its photos and cannot be undone.`)) return;
    await api('DELETE', `/api/items/${id}`);
    closeDrawer();
    await load();
    toast('Deleted');
  }
  function setView(v) {
    state.view = v;
    if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
    render();
  }
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-error', isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isError ? 4500 : 2500);
  }
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ts.theme', theme);
    $('#themeLabel').textContent = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  }
  async function restoreBackup(file) {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      return toast('That file is not valid JSON', true);
    }
    const n = Array.isArray(payload?.items) ? payload.items.length : Array.isArray(payload) ? payload.length : 0;
    if (!n) return toast('No items found in that backup', true);
    const replace = confirm(`Restore ${n} items from backup.\n\nOK = REPLACE your current collection with the backup.\nCancel = MERGE the backup into what you have now.`);
    if (replace && !confirm('Really replace everything? Current items and uploaded photos will be deleted.')) return;
    try {
      const r = await api('POST', `/api/import?mode=${replace ? 'replace' : 'merge'}`, payload);
      await load();
      toast(`Restored ${r.imported} items${r.skipped ? `, skipped ${r.skipped}` : ''}`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- events ----------
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-view],[data-id],[data-edit],[data-move],[data-delete],[data-duplicate],[data-close-drawer],[data-hero],[data-clear],[data-add],[data-toggle],[data-photo-primary],[data-photo-delete],[data-pending-remove],[data-pending-url-remove],[data-action]');
    if (!t) {
      if (!ev.target.closest('#menu,#menuBtn')) $('#menu').hidden = true;
      return;
    }
    try {
      if (t.dataset.view) { ev.preventDefault(); return setView(t.dataset.view); }
      if (t.dataset.id) return openDrawer(Number(t.dataset.id));
      if (t.dataset.edit) return openModal(state.items.find((i) => i.id === Number(t.dataset.edit)));
      if (t.dataset.duplicate) return openModal(null, { duplicateOf: state.items.find((i) => i.id === Number(t.dataset.duplicate)) });
      if (t.dataset.move) return moveItem(state.selectedId, t.dataset.move);
      if (t.dataset.delete) return deleteItem(Number(t.dataset.delete));
      if (t.hasAttribute('data-close-drawer')) return closeDrawer();
      if (t.dataset.hero) { state.heroIndex = Number(t.dataset.hero); return renderDrawer(); }
      if (t.hasAttribute('data-clear')) {
        state.q = ''; $('#searchInput').value = '';
        for (const k of FILTER_KEYS) state.filters[k] = '';
        return render();
      }
      if (t.dataset.add) return openModal(null, { status: t.dataset.add });
      if (t.dataset.toggle) { state.filters[t.dataset.toggle] = !state.filters[t.dataset.toggle]; return render(); }
      if (t.dataset.photoPrimary) {
        await api('PUT', `/api/items/${state.edit.id}/photos/${t.dataset.photoPrimary}/primary`);
        state.edit.photos = state.edit.photos.map((p) => ({ ...p, is_primary: p.id === Number(t.dataset.photoPrimary) }));
        renderThumbs(); await load(); if (state.selectedId) renderDrawer();
        return;
      }
      if (t.dataset.photoDelete) {
        await api('DELETE', `/api/items/${state.edit.id}/photos/${t.dataset.photoDelete}`);
        state.edit.photos = state.edit.photos.filter((p) => p.id !== Number(t.dataset.photoDelete));
        if (state.edit.photos.length && !state.edit.photos.some((p) => p.is_primary)) state.edit.photos[0].is_primary = true;
        renderThumbs(); await load(); if (state.selectedId) renderDrawer();
        return;
      }
      if (t.dataset.pendingRemove) {
        const [p] = state.edit.pending.splice(Number(t.dataset.pendingRemove), 1);
        if (p) URL.revokeObjectURL(p.preview);
        return renderThumbs();
      }
      if (t.dataset.pendingUrlRemove) { state.edit.pendingUrls.splice(Number(t.dataset.pendingUrlRemove), 1); return renderThumbs(); }
      if (t.dataset.action === 'theme') { $('#menu').hidden = true; return applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'); }
      if (t.dataset.action === 'restore') { $('#menu').hidden = true; return $('#restoreFile').click(); }
      if (t.dataset.action === 'about') {
        $('#menu').hidden = true;
        $('#drawerContent').innerHTML = `<div class="drawer-body">${$('#aboutTpl').innerHTML}<button type="button" class="btn" data-close-drawer style="margin-top:12px">Close</button></div>`;
        $('#drawer').hidden = false; $('#drawerBackdrop').hidden = false;
        return;
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#menuBtn').addEventListener('click', () => { $('#menu').hidden = !$('#menu').hidden; });
  $('#addBtn').addEventListener('click', () => openModal(null, { status: state.view === 'wishlist' ? 'wishlist' : 'owned' }));
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalBackdrop').addEventListener('mousedown', (ev) => { if (ev.target === ev.currentTarget) closeModal(); });
  form.addEventListener('submit', submitForm);
  form.addEventListener('change', (ev) => { if (ev.target.name === 'status') syncStatusClass(); });
  $('#restoreFile').addEventListener('change', (ev) => { const f = ev.target.files[0]; ev.target.value = ''; if (f) restoreBackup(f); });

  let searchTimer;
  $('#searchInput').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = ev.target.value; if (state.view === 'insights') setView('collection'); else render(); }, 120);
  });
  $('#sortSelect').addEventListener('change', (ev) => { state.sort = ev.target.value; localStorage.setItem('ts.sort', state.sort); renderGrid(); });
  $$('.seg-btn').forEach((b) => b.addEventListener('click', () => { state.layout = b.dataset.layout; localStorage.setItem('ts.layout', state.layout); renderFilters(); renderGrid(); }));
  $('#filters').addEventListener('change', (ev) => { if (ev.target.dataset.filter) { state.filters[ev.target.dataset.filter] = ev.target.value; render(); } });

  // photos: file picker, drag & drop, URL
  $('#photoFiles').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; });
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((n) => dz.addEventListener(n, (ev) => { ev.preventDefault(); dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((n) => dz.addEventListener(n, (ev) => { ev.preventDefault(); dz.classList.remove('is-over'); }));
  dz.addEventListener('drop', (ev) => addFiles(ev.dataTransfer.files));
  async function addUrl() {
    const input = $('#photoUrl');
    const url = input.value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return toast('Paste a full http(s) image URL', true);
    input.value = '';
    if (state.edit.id) {
      try {
        state.edit.photos.push(await api('POST', `/api/items/${state.edit.id}/photos/url`, { url }));
        renderThumbs(); await load(); if (state.selectedId) renderDrawer();
      } catch (err) { toast(err.message, true); }
    } else {
      state.edit.pendingUrls.push(url);
      renderThumbs();
    }
  }
  $('#photoUrlAdd').addEventListener('click', addUrl);
  $('#photoUrl').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addUrl(); } });

  // keyboard
  document.addEventListener('keydown', (ev) => {
    const typing = /^(input|textarea|select)$/i.test(ev.target.tagName);
    if (ev.key === 'Escape') {
      if (!$('#modalBackdrop').hidden) return closeModal();
      if (!$('#drawer').hidden) return closeDrawer();
      if (!$('#menu').hidden) return ($('#menu').hidden = true);
      if (typing && ev.target.id === 'searchInput') { ev.target.value = ''; state.q = ''; render(); ev.target.blur(); }
      return;
    }
    if (typing) return;
    if (ev.key === '/') { ev.preventDefault(); $('#searchInput').focus(); }
    if (ev.key === 'n' && $('#modalBackdrop').hidden) { ev.preventDefault(); $('#addBtn').click(); }
  });
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (['collection', 'wishlist', 'insights'].includes(v)) setView(v); });

  // ---------- boot ----------
  applyTheme(localStorage.getItem('ts.theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  const initial = location.hash.slice(1);
  if (['collection', 'wishlist', 'insights'].includes(initial)) state.view = initial;
  load().catch((err) => toast(`Could not load collection: ${err.message}`, true));
})();

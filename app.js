'use strict';
/* Wayfare: offline travel planner + restaurant organiser.
   All data lives on the phone in IndexedDB (photos stored as compressed JPEG blobs). */

// ---------- storage ----------
const DB_NAME = 'wayfare', DB_VER = 1;
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['trips', 'restaurants', 'photos']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out; const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}
const all = s => tx(s, 'readonly', st => st.getAll());
const get = (s, id) => tx(s, 'readonly', st => st.get(id));
const put = (s, v) => tx(s, 'readwrite', st => st.put(v));
const del = (s, id) => tx(s, 'readwrite', st => st.delete(id));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 2200); }
const urlCache = new Map();
async function photoURL(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  const p = await get('photos', id);
  if (!p) return null;
  const u = URL.createObjectURL(p.blob); urlCache.set(id, u); return u;
}
async function hydrateImgs(root = app) {
  for (const img of root.querySelectorAll('img[data-pid]')) {
    const u = await photoURL(img.dataset.pid);
    if (u) img.src = u;
  }
}
function fmtDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00'); return d.toLocaleDateString(undefined, opts);
}
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function stars(n) { return n ? '<span class="stars">' + '★'.repeat(n) + '</span>' : ''; }
function splitList(s) { return String(s || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean); }
function safeUrl(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } }
function mapsHref(r) {
  const u = safeUrl(r.mapsUrl);
  if (u) return u;
  const q = [r.name, r.address, r.city].filter(Boolean).join(', ');
  return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : '';
}

// Shrink photos so hundreds fit comfortably on the phone.
async function compress(file, max = 1600, q = 0.82) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', q));
  } catch { return file; }
}
async function savePhotos(files, caption = '') {
  const ids = [];
  for (const f of files) {
    const id = uid();
    await put('photos', { id, blob: await compress(f), caption, created: Date.now() });
    ids.push(id);
  }
  return ids;
}
function pickFiles(multiple, capture) {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.multiple = !!multiple;
    if (capture) i.capture = 'environment';
    i.onchange = () => res([...i.files]); i.click();
  });
}

// ---------- chrome (header, tabs, sheets) ----------
function setHeader(title, { back = false, actions = '' } = {}) {
  $('#title').textContent = title;
  $('#back').hidden = !back;
  $('#actions').innerHTML = actions;
  document.title = title === 'Wayfare' ? 'Wayfare' : title + ' · Wayfare';
}
$('#back').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/trips');
function setTab(t) { document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === t)); }
function fab(onclick) { const b = document.createElement('button'); b.className = 'fab'; b.textContent = '+'; b.setAttribute('aria-label', 'Add'); b.onclick = onclick; app.append(b); }

function sheet(html, onMount) {
  const bg = document.createElement('div'); bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  document.body.append(bg);
  onMount && onMount(bg.firstElementChild, close);
  return close;
}
function viewer(pid, caption) {
  const v = document.createElement('div'); v.className = 'viewer';
  v.innerHTML = `<img data-pid="${esc(pid)}" alt=""><div class="cap">${esc(caption || '')}</div>`;
  v.onclick = () => v.remove(); document.body.append(v); hydrateImgs(v);
}

// ---------- router ----------
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
async function render() {
  const h = location.hash || '#/trips';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) { app.innerHTML = ''; window.scrollTo(0, 0); await fn(...m.slice(1).map(decodeURIComponent)); return; }
  }
  location.hash = '#/trips';
}
window.addEventListener('hashchange', render);

// ======================================================================
// TRIPS
// ======================================================================
route(/^#\/trips$/, async () => {
  setTab('trips'); setHeader('Wayfare');
  const trips = (await all('trips')).sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  if (!trips.length) {
    app.innerHTML = `<div class="empty"><div class="big">🧳</div><p><b>No trips yet</b><br>Add a trip to plan it day by day.</p></div>`;
  } else {
    const today = new Date().toISOString().slice(0, 10);
    app.innerHTML = trips.map(t => {
      const nDays = (t.days || []).length;
      const status = t.start && t.end ? (today < t.start ? 'Upcoming' : today > t.end ? 'Past' : 'Happening now') : '';
      return `<a class="card rcard" href="#/trip/${t.id}">
        <div class="thumb ph">✈️</div>
        <div class="grow"><h3>${esc(t.name)}</h3>
        <div class="muted small">${esc(t.destination || '')}</div>
        <div class="small">${t.start ? fmtDate(t.start) + ' – ' + fmtDate(t.end) : ''} · ${nDays} day${nDays === 1 ? '' : 's'}</div>
        ${status ? `<span class="tag">${status}</span>` : ''}</div></a>`;
    }).join('');
  }
  fab(() => editTrip());
});

function buildDays(start, end, existing = []) {
  if (!start || !end || end < start) return existing;
  const byDate = Object.fromEntries(existing.map(d => [d.date, d]));
  const out = [];
  for (let d = start, i = 0; d <= end && i < 120; d = addDays(d, 1), i++) out.push(byDate[d] || { id: uid(), date: d, title: '', items: [] });
  // keep days that fall outside the new range only if they have plans
  for (const d of existing) if ((d.date < start || d.date > end) && d.items.length) out.push(d);
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function editTrip(trip) {
  const t = trip || { id: uid(), name: '', destination: '', start: '', end: '', days: [], created: Date.now() };
  sheet(`<h2>${trip ? 'Edit trip' : 'New trip'}</h2>
    <label class="f">Trip name</label><input id="tn" value="${esc(t.name)}" placeholder="Japan, spring 2027">
    <label class="f">Destination(s)</label><input id="td" value="${esc(t.destination)}" placeholder="Tokyo, Kyoto, Osaka">
    <div class="row"><div class="grow"><label class="f">First day</label><input id="ts" type="date" value="${esc(t.start)}"></div>
    <div class="grow"><label class="f">Last day</label><input id="te" type="date" value="${esc(t.end)}"></div></div>
    <p class="small muted">A page is created for every day between these dates.</p>
    <div class="row" style="margin-top:16px">${trip ? '<button class="btn danger" id="tdel">Delete</button>' : ''}<span class="grow"></span><button class="btn primary" id="tsave">Save</button></div>`,
    (el, close) => {
      $('#tsave', el).onclick = async () => {
        t.name = $('#tn', el).value.trim() || 'Untitled trip';
        t.destination = $('#td', el).value.trim();
        t.start = $('#ts', el).value; t.end = $('#te', el).value || t.start;
        if (t.end < t.start) [t.start, t.end] = [t.end, t.start];
        t.days = buildDays(t.start, t.end, t.days);
        await put('trips', t); close();
        trip ? render() : (location.hash = '#/trip/' + t.id);
      };
      if (trip) $('#tdel', el).onclick = async () => {
        if (!confirm('Delete this trip and its day plans? Restaurants are kept.')) return;
        await del('trips', t.id); close(); location.hash = '#/trips';
      };
      if (!trip) $('#tn', el).focus();
    });
}

route(/^#\/trip\/([^/]+)$/, async id => {
  setTab('trips');
  const t = await get('trips', id);
  if (!t) return (location.hash = '#/trips');
  const rest = Object.fromEntries((await all('restaurants')).map(r => [r.id, r]));
  setHeader(t.name, { back: true, actions: '<button class="btn icon" id="edt" aria-label="Edit trip">✏️</button>' });
  $('#edt').onclick = () => editTrip(t);
  const today = new Date().toISOString().slice(0, 10);
  if (!t.days.length) {
    app.innerHTML = `<div class="empty"><div class="big">📅</div><p>Set the trip dates to get a page per day.</p></div>`;
    return;
  }
  app.innerHTML = `<p class="muted small">${esc(t.destination || '')}</p>` + t.days.map((d, i) => {
    const items = [...d.items].sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    return `<section class="card day" id="d-${d.id}">
      <div class="row"><div class="grow"><h3>Day ${i + 1} · ${fmtDate(d.date)} ${d.date === today ? '<span class="tag">Today</span>' : ''}</h3>
      <div class="muted small">${esc(d.title || '')}</div></div>
      <button class="btn icon" data-dayedit="${d.id}" aria-label="Rename day">✏️</button></div>
      ${items.map(it => {
        const r = it.restaurantId && rest[it.restaurantId];
        const href = r ? '#/r/' + r.id : '';
        const maps = r ? mapsHref(r) : safeUrl(it.mapsUrl) || (it.place ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(it.place) : '');
        return `<div class="item"><div class="t">${esc(it.time || '')}</div><div class="grow">
          <div><b>${r ? '🍽️ ' : ''}${esc(r ? r.name : it.title)}</b></div>
          ${it.place && !r ? `<div class="small muted">${esc(it.place)}</div>` : ''}
          ${it.notes ? `<div class="small">${esc(it.notes)}</div>` : ''}
          <div class="small" style="margin-top:4px">${href ? `<a class="link" href="${href}">Details</a> · ` : ''}${maps ? `<a class="link" href="${esc(maps)}" target="_blank" rel="noopener">Map</a> · ` : ''}<a class="link" href="#" data-itemedit="${d.id}|${it.id}">Edit</a></div>
        </div></div>`;
      }).join('')}
      <div class="row" style="margin-top:10px"><button class="btn grow" data-additem="${d.id}">+ Plan</button><button class="btn grow" data-addfood="${d.id}">+ Restaurant</button></div>
    </section>`;
  }).join('');
  app.onclick = e => {
    const b = e.target.closest('[data-additem],[data-addfood],[data-itemedit],[data-dayedit]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.additem) editItem(t, b.dataset.additem);
    if (b.dataset.addfood) pickRestaurantForDay(t, b.dataset.addfood);
    if (b.dataset.itemedit) { const [dId, iId] = b.dataset.itemedit.split('|'); editItem(t, dId, iId); }
    if (b.dataset.dayedit) {
      const d = t.days.find(x => x.id === b.dataset.dayedit);
      sheet(`<h2>Day title</h2><input id="dt" value="${esc(d.title)}" placeholder="e.g. Shibuya and Harajuku"><div class="row" style="margin-top:14px"><span class="grow"></span><button class="btn primary" id="ds">Save</button></div>`,
        (el, close) => { $('#dt', el).focus(); $('#ds', el).onclick = async () => { d.title = $('#dt', el).value.trim(); await put('trips', t); close(); render(); }; });
    }
  };
  const tday = t.days.find(d => d.date === today);
  if (tday) document.getElementById('d-' + tday.id)?.scrollIntoView();
});

function editItem(t, dayId, itemId) {
  const d = t.days.find(x => x.id === dayId);
  const it = d.items.find(x => x.id === itemId) || { id: uid(), time: '', title: '', place: '', mapsUrl: '', notes: '' };
  sheet(`<h2>${itemId ? 'Edit plan' : 'Add plan'} · ${fmtDate(d.date)}</h2>
    <div class="row"><div style="width:120px"><label class="f">Time</label><input id="it" type="time" value="${esc(it.time)}"></div>
    <div class="grow"><label class="f">What</label><input id="iw" value="${esc(it.title)}" placeholder="TeamLab Planets" ${it.restaurantId ? 'disabled' : ''}></div></div>
    ${it.restaurantId ? '' : `<label class="f">Place / address</label><input id="ip" value="${esc(it.place)}">
    <label class="f">Google Maps link (optional)</label><input id="im" value="${esc(it.mapsUrl)}" inputmode="url" placeholder="https://maps.app.goo.gl/…">`}
    <label class="f">Notes</label><textarea id="in" placeholder="Tickets booked, ref ABC123">${esc(it.notes)}</textarea>
    <label class="f">Move to day</label><select id="iday">${t.days.map((x, i) => `<option value="${x.id}" ${x.id === dayId ? 'selected' : ''}>Day ${i + 1} · ${fmtDate(x.date)}</option>`).join('')}</select>
    <div class="row" style="margin-top:16px">${itemId ? '<button class="btn danger" id="idel">Remove</button>' : ''}<span class="grow"></span><button class="btn primary" id="isave">Save</button></div>`,
    (el, close) => {
      if (!itemId) $('#iw', el).focus();
      $('#isave', el).onclick = async () => {
        it.time = $('#it', el).value;
        if (!it.restaurantId) { it.title = $('#iw', el).value.trim() || 'Plan'; it.place = $('#ip', el).value.trim(); it.mapsUrl = $('#im', el).value.trim(); }
        it.notes = $('#in', el).value.trim();
        d.items = d.items.filter(x => x.id !== it.id);
        t.days.find(x => x.id === $('#iday', el).value).items.push(it);
        await put('trips', t); close(); render();
      };
      if (itemId) $('#idel', el).onclick = async () => { d.items = d.items.filter(x => x.id !== it.id); await put('trips', t); close(); render(); };
    });
}

async function pickRestaurantForDay(t, dayId) {
  const list = (await all('restaurants')).sort((a, b) => a.name.localeCompare(b.name));
  sheet(`<h2>Add a restaurant to this day</h2>
    <div class="searchbar"><span>🔎</span><input id="ps" placeholder="Search your restaurants"></div>
    <div id="pl"></div>
    <button class="btn block" id="pnew" style="margin-top:10px">+ New restaurant</button>`,
    (el, close) => {
      const draw = () => {
        const q = $('#ps', el).value.toLowerCase();
        const f = list.filter(r => !q || [r.name, r.city, r.cuisine].join(' ').toLowerCase().includes(q));
        $('#pl', el).innerHTML = f.length ? `<ul class="list">${f.map(r => `<li data-id="${r.id}" style="cursor:pointer"><div class="grow"><b>${esc(r.name)}</b><div class="small muted">${esc([r.cuisine, r.city].filter(Boolean).join(' · '))}</div></div></li>`).join('')}</ul>` : '<p class="muted small">No matches.</p>';
      };
      draw(); $('#ps', el).oninput = draw;
      $('#pl', el).onclick = async e => {
        const li = e.target.closest('li[data-id]'); if (!li) return;
        t.days.find(x => x.id === dayId).items.push({ id: uid(), time: '', title: '', restaurantId: li.dataset.id, notes: '' });
        await put('trips', t); close(); render();
      };
      $('#pnew', el).onclick = () => { close(); location.hash = `#/r-new?trip=${t.id}&day=${dayId}`; };
    });
}

// ======================================================================
// RESTAURANTS
// ======================================================================
const foodState = { q: '', city: '', cuisine: '', show: 'all', sort: 'recent', trip: '' };
try { Object.assign(foodState, JSON.parse(localStorage.getItem('foodState') || '{}')); foodState.q = ''; } catch {}

route(/^#\/food$/, async () => {
  setTab('food'); setHeader('Restaurants');
  const [list, trips] = await Promise.all([all('restaurants'), all('trips')]);
  const tripOf = {};
  for (const t of trips) for (const d of t.days || []) for (const it of d.items) if (it.restaurantId) (tripOf[it.restaurantId] ||= new Set()).add(t.id);
  const cities = [...new Set(list.map(r => r.city).filter(Boolean))].sort();
  const cuisines = [...new Set(list.map(r => r.cuisine).filter(Boolean))].sort();

  app.innerHTML = `
    <div class="searchbar"><span>🔎</span><input id="q" type="search" placeholder="Search name, dish, city, tag, notes…" value="${esc(foodState.q)}"></div>
    <div class="chips" id="cities" style="margin-top:8px">
      <button class="chip ${!foodState.city ? 'on' : ''}" data-city="">All cities</button>
      ${cities.map(c => `<button class="chip ${foodState.city === c ? 'on' : ''}" data-city="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <div class="row" style="margin-top:6px">
      <select id="cui" class="grow"><option value="">Any cuisine</option>${cuisines.map(c => `<option ${foodState.cuisine === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="show" class="grow">
        <option value="all">All</option><option value="todo">Not visited</option><option value="visited">Visited</option><option value="fav">4★ and up</option>
      </select>
    </div>
    <div class="row" style="margin-top:6px">
      <select id="trip" class="grow"><option value="">Any trip</option>${trips.map(t => `<option value="${t.id}" ${foodState.trip === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <select id="sort" class="grow">
        <option value="recent">Newest first</option><option value="name">Name A–Z</option><option value="rating">Highest rated</option><option value="city">City</option>
      </select>
    </div>
    <div id="results"></div>`;
  $('#show').value = foodState.show; $('#sort').value = foodState.sort;

  const draw = () => {
    localStorage.setItem('foodState', JSON.stringify(foodState));
    const words = foodState.q.toLowerCase().split(/\s+/).filter(Boolean);
    let f = list.filter(r => {
      if (foodState.city && r.city !== foodState.city) return false;
      if (foodState.cuisine && r.cuisine !== foodState.cuisine) return false;
      if (foodState.show === 'todo' && r.visited) return false;
      if (foodState.show === 'visited' && !r.visited) return false;
      if (foodState.show === 'fav' && (r.rating || 0) < 4) return false;
      if (foodState.trip && !(tripOf[r.id]?.has(foodState.trip))) return false;
      if (words.length) {
        const hay = [r.name, r.city, r.cuisine, r.address, r.notes, ...(r.mustTry || []), ...(r.toOrder || []).map(x => x.text), ...(r.tags || [])].join(' ').toLowerCase();
        return words.every(w => hay.includes(w));
      }
      return true;
    });
    const by = {
      recent: (a, b) => (b.created || 0) - (a.created || 0),
      name: (a, b) => a.name.localeCompare(b.name),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || a.name.localeCompare(b.name),
      city: (a, b) => (a.city || '~').localeCompare(b.city || '~') || a.name.localeCompare(b.name),
    }[foodState.sort];
    f.sort(by);
    const box = $('#results');
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="big">🍽️</div><p><b>No restaurants yet</b><br>Tap + to add one, or share a place from Google Maps to Wayfare.</p></div>`;
      return;
    }
    box.innerHTML = `<p class="small muted">${f.length} of ${list.length}</p>` + f.map(r => `
      <a class="card rcard" href="#/r/${r.id}">
        ${r.frontPhotoId ? `<img class="thumb" data-pid="${r.frontPhotoId}" alt="">` : r.foodPhotoIds?.[0] ? `<img class="thumb" data-pid="${r.foodPhotoIds[0]}" alt="">` : '<div class="thumb ph">🍽️</div>'}
        <div class="grow"><h3>${esc(r.name)} ${r.visited ? '✅' : ''}</h3>
          <div class="small muted">${esc([r.cuisine, r.city].filter(Boolean).join(' · '))} ${r.price ? '· ' + '$'.repeat(r.price) : ''} ${stars(r.rating)}</div>
          ${r.mustTry?.length ? `<div class="small">⭐ ${esc(r.mustTry.slice(0, 3).join(', '))}${r.mustTry.length > 3 ? '…' : ''}</div>` : ''}
          ${(r.tags || []).map(x => `<span class="tag">${esc(x)}</span>`).join('')}
        </div></a>`).join('');
    hydrateImgs(box);
  };
  draw();
  $('#q').oninput = e => { foodState.q = e.target.value; draw(); };
  $('#cities').onclick = e => { const c = e.target.closest('[data-city]'); if (!c) return; foodState.city = c.dataset.city; document.querySelectorAll('#cities .chip').forEach(x => x.classList.toggle('on', x === c)); draw(); };
  $('#cui').onchange = e => { foodState.cuisine = e.target.value; draw(); };
  $('#show').onchange = e => { foodState.show = e.target.value; draw(); };
  $('#sort').onchange = e => { foodState.sort = e.target.value; draw(); };
  $('#trip').onchange = e => { foodState.trip = e.target.value; draw(); };
  fab(() => (location.hash = '#/r-new'));
});

// Restaurant detail
route(/^#\/r\/([^/]+)$/, async id => {
  setTab('food');
  const r = await get('restaurants', id);
  if (!r) return (location.hash = '#/food');
  setHeader(r.name, { back: true, actions: `<a class="btn icon" href="#/r-edit/${r.id}" aria-label="Edit">✏️</a>` });
  const maps = mapsHref(r);
  const trips = await all('trips');
  const onDays = [];
  for (const t of trips) (t.days || []).forEach((d, i) => { if (d.items.some(it => it.restaurantId === r.id)) onDays.push({ t, d, i }); });

  app.innerHTML = `
    ${r.frontPhotoId ? `<img class="hero" data-pid="${r.frontPhotoId}" alt="Restaurant front" id="hero">` : `<button class="btn block" id="addfront" style="padding:28px">📷 Add a photo of the front, so you can spot it on the street</button>`}
    <div style="margin-top:12px">
      <div class="small muted">${esc([r.cuisine, r.city].filter(Boolean).join(' · '))} ${r.price ? '· ' + '$'.repeat(r.price) : ''}</div>
      ${r.address ? `<div class="small">${esc(r.address)}</div>` : ''}
      <div style="margin-top:4px">${(r.tags || []).map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>
    </div>
    <div class="row" style="margin-top:12px">
      ${maps ? `<a class="btn primary grow" href="${esc(maps)}" target="_blank" rel="noopener">📍 Open in Maps</a>` : ''}
      <button class="btn grow" id="visit">${r.visited ? '✅ Visited' : 'Mark visited'}</button>
    </div>
    ${r.visited || r.rating ? `<div class="card"><div class="small muted">Your rating</div><div class="starpick" id="sp">${[1, 2, 3, 4, 5].map(n => `<button data-n="${n}" class="${n <= (r.rating || 0) ? 'on' : ''}">★</button>`).join('')}</div></div>` : ''}

    <h2>Must try</h2>
    <div class="card">${r.mustTry?.length ? `<ul class="list">${r.mustTry.map(x => `<li>⭐ <span class="grow">${esc(x)}</span></li>`).join('')}</ul>` : '<span class="muted small">Nothing yet. Tap ✏️ to add what people recommend.</span>'}</div>

    <h2>My order</h2>
    <div class="card">${r.toOrder?.length ? `<ul class="list" id="ord">${r.toOrder.map((x, i) => `<li><input type="checkbox" data-i="${i}" ${x.done ? 'checked' : ''}><span class="grow ${x.done ? 'done' : ''}">${esc(x.text)}</span></li>`).join('')}</ul><p class="small muted" style="margin:8px 0 0">Tick dishes off as you order them.</p>` : '<span class="muted small">Nothing yet. Tap ✏️ to plan your order.</span>'}</div>

    <h2>Food photos</h2>
    <div class="gallery" id="gal">${(r.foodPhotoIds || []).map(p => `<div class="g"><img data-pid="${p}" alt="" data-view="${p}"></div>`).join('')}</div>
    <div class="row" style="margin-top:8px"><button class="btn grow" id="addfood">🖼️ Add from gallery</button><button class="btn grow" id="snapfood">📷 Camera</button></div>
    <p class="small muted">Tip: screenshot dishes from Google Maps reviews or Instagram, then add them here.</p>

    ${r.notes ? `<h2>Notes</h2><div class="card" style="white-space:pre-wrap">${esc(r.notes)}</div>` : ''}
    ${onDays.length ? `<h2>In your itinerary</h2><div class="card">${onDays.map(({ t, d, i }) => `<div><a class="link" href="#/trip/${t.id}">${esc(t.name)}: Day ${i + 1}, ${fmtDate(d.date)}</a></div>`).join('')}</div>` : ''}
    ${r.frontPhotoId ? `<p style="margin-top:16px"><button class="btn" id="changefront">Change front photo</button></p>` : ''}
  `;
  hydrateImgs();

  const save = async () => { r.updated = Date.now(); await put('restaurants', r); };
  const addFront = async () => { const f = await pickFiles(false); if (!f.length) return; const [pid] = await savePhotos(f, 'Front'); if (r.frontPhotoId) await del('photos', r.frontPhotoId); r.frontPhotoId = pid; await save(); render(); };
  $('#addfront') && ($('#addfront').onclick = addFront);
  $('#changefront') && ($('#changefront').onclick = addFront);
  $('#hero') && ($('#hero').onclick = () => viewer(r.frontPhotoId, r.name));
  $('#visit').onclick = async () => { r.visited = !r.visited; await save(); render(); };
  $('#sp') && ($('#sp').onclick = async e => { const b = e.target.closest('[data-n]'); if (!b) return; const n = +b.dataset.n; r.rating = r.rating === n ? 0 : n; await save(); render(); });
  $('#ord') && ($('#ord').onchange = async e => { const i = +e.target.dataset.i; r.toOrder[i].done = e.target.checked; await save(); e.target.nextElementSibling.classList.toggle('done', e.target.checked); });
  const addFood = async cam => { const f = await pickFiles(!cam, cam); if (!f.length) return; toast('Saving photos…'); r.foodPhotoIds = [...(r.foodPhotoIds || []), ...(await savePhotos(f))]; await save(); render(); };
  $('#addfood').onclick = () => addFood(false);
  $('#snapfood').onclick = () => addFood(true);
  $('#gal').onclick = e => { const v = e.target.closest('[data-view]'); if (v) viewer(v.dataset.view); };
});

// Restaurant add/edit form
route(/^#\/r-new(?:\?(.*))?$/, async qs => restaurantForm(null, new URLSearchParams(qs || '')));
route(/^#\/r-edit\/([^/]+)$/, async id => restaurantForm(await get('restaurants', id)));

function listEditor(id, items, placeholder) {
  return `<div class="listedit" id="${id}">${[...items, ''].map(v => `<div class="li"><input value="${esc(v)}" placeholder="${esc(placeholder)}"></div>`).join('')}</div>`;
}
function wireListEditor(el, placeholder) {
  el.addEventListener('input', () => {
    const inputs = [...el.querySelectorAll('input')];
    if (inputs[inputs.length - 1].value.trim()) {
      const d = document.createElement('div'); d.className = 'li'; d.innerHTML = `<input placeholder="${esc(placeholder)}">`; el.append(d);
    }
  });
}
const readList = el => [...el.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);

// Parse what Google Maps sends when you tap Share on a place.
function parseShare(p) {
  const text = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join('\n');
  const url = (text.match(/https?:\/\/\S+/) || [''])[0];
  let name = (p.get('title') || '').trim();
  if (!name) name = text.replace(url, '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  return { name: name.replace(/https?:\/\/\S+/, '').trim(), mapsUrl: url };
}

async function restaurantForm(existing, params = new URLSearchParams()) {
  setTab('food');
  const shared = params.get('share') ? parseShare(params) : {};
  const r = existing || { id: uid(), name: shared.name || '', city: '', cuisine: '', address: '', mapsUrl: shared.mapsUrl || '', mustTry: [], toOrder: [], tags: [], notes: '', price: 0, rating: 0, visited: false, frontPhotoId: null, foodPhotoIds: [], created: Date.now() };
  setHeader(existing ? 'Edit restaurant' : 'New restaurant', { back: true });
  const all_ = await all('restaurants');
  const cities = [...new Set(all_.map(x => x.city).filter(Boolean))];
  const cuisines = [...new Set(all_.map(x => x.cuisine).filter(Boolean))];
  let pendingFront = null, pendingFood = [];

  app.innerHTML = `
    ${shared.mapsUrl ? '<div class="card small">📍 Added from Google Maps. Check the name, then fill in the rest.</div>' : ''}
    <label class="f">Name</label><input id="n" value="${esc(r.name)}" placeholder="Ichiran Shibuya">
    <label class="f">Google Maps link</label><input id="m" value="${esc(r.mapsUrl)}" inputmode="url" placeholder="Paste from Maps → Share → Copy link">
    <div class="row"><div class="grow"><label class="f">City</label><input id="c" list="cl" value="${esc(r.city)}" placeholder="Tokyo"></div>
    <div class="grow"><label class="f">Cuisine</label><input id="cu" list="cul" value="${esc(r.cuisine)}" placeholder="Ramen"></div></div>
    <datalist id="cl">${cities.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="cul">${cuisines.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <label class="f">Area / address (optional)</label><input id="a" value="${esc(r.address)}" placeholder="Near Shibuya station, B1 floor">
    <label class="f">Price</label><select id="pr"><option value="0">Not set</option>${[1, 2, 3, 4].map(n => `<option value="${n}" ${r.price === n ? 'selected' : ''}>${'$'.repeat(n)}</option>`).join('')}</select>

    <label class="f">Must-try dishes (what people recommend)</label>${listEditor('mt', r.mustTry || [], 'Add a dish')}
    <label class="f">What I want to order</label>${listEditor('to', (r.toOrder || []).map(x => x.text), 'Add a dish')}
    <label class="f">Tags (comma separated)</label><input id="tg" value="${esc((r.tags || []).join(', '))}" placeholder="late night, vegetarian, needs booking">
    <label class="f">Notes</label><textarea id="no" placeholder="Opening hours, queue tips, cash only…">${esc(r.notes)}</textarea>

    ${existing ? '' : `<label class="f">Photos</label>
      <div class="row"><button class="btn grow" id="pf">📷 Front of restaurant</button><button class="btn grow" id="pfd">🖼️ Food photos</button></div>
      <p class="small muted" id="pinfo"></p>`}
    <div class="row" style="margin-top:18px">${existing ? '<button class="btn danger" id="del">Delete</button>' : ''}<span class="grow"></span><button class="btn primary" id="save">Save</button></div>`;

  wireListEditor($('#mt'), 'Add a dish'); wireListEditor($('#to'), 'Add a dish');
  if (!existing) {
    const info = () => { $('#pinfo').textContent = [pendingFront ? 'Front photo added' : '', pendingFood.length ? pendingFood.length + ' food photo(s) added' : ''].filter(Boolean).join(' · '); };
    $('#pf').onclick = async () => { const f = await pickFiles(false); if (f.length) { pendingFront = f[0]; info(); } };
    $('#pfd').onclick = async () => { const f = await pickFiles(true); pendingFood.push(...f); info(); };
    if (!r.name) $('#n').focus();
  }
  $('#save').onclick = async () => {
    const name = $('#n').value.trim();
    if (!name) { toast('Give it a name first'); $('#n').focus(); return; }
    const prevOrder = Object.fromEntries((r.toOrder || []).map(x => [x.text, x.done]));
    Object.assign(r, {
      name, mapsUrl: $('#m').value.trim(), city: $('#c').value.trim(), cuisine: $('#cu').value.trim(),
      address: $('#a').value.trim(), price: +$('#pr').value, mustTry: readList($('#mt')),
      toOrder: readList($('#to')).map(text => ({ text, done: !!prevOrder[text] })),
      tags: splitList($('#tg').value), notes: $('#no').value.trim(), updated: Date.now(),
    });
    $('#save').disabled = true;
    if (pendingFront) r.frontPhotoId = (await savePhotos([pendingFront], 'Front'))[0];
    if (pendingFood.length) r.foodPhotoIds = [...r.foodPhotoIds, ...(await savePhotos(pendingFood))];
    await put('restaurants', r);
    const tripId = params.get('trip'), dayId = params.get('day');
    if (tripId && dayId) {
      const t = await get('trips', tripId);
      const d = t?.days.find(x => x.id === dayId);
      if (d) { d.items.push({ id: uid(), time: '', title: '', restaurantId: r.id, notes: '' }); await put('trips', t); }
      history.replaceState(null, '', '#/trip/' + tripId); render(); return;
    }
    history.replaceState(null, '', '#/r/' + r.id); render();
  };
  if (existing) $('#del').onclick = async () => {
    if (!confirm(`Delete ${r.name} and its photos?`)) return;
    for (const p of [r.frontPhotoId, ...(r.foodPhotoIds || [])]) if (p) await del('photos', p);
    for (const t of await all('trips')) {
      let changed = false;
      for (const d of t.days || []) { const n = d.items.length; d.items = d.items.filter(i => i.restaurantId !== r.id); changed ||= n !== d.items.length; }
      if (changed) await put('trips', t);
    }
    await del('restaurants', r.id);
    history.replaceState(null, '', '#/food'); render();
  };
}

// ======================================================================
// BACKUP / SETTINGS
// ======================================================================
const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
const dataURLToBlob = async u => (await fetch(u)).blob();

route(/^#\/settings$/, async () => {
  setTab('settings'); setHeader('Backup');
  const [trips, rests, photos] = await Promise.all([all('trips'), all('restaurants'), tx('photos', 'readonly', s => s.count())]);
  let usage = '';
  if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); usage = `${(e.usage / 1048576).toFixed(1)} MB used`; }
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  const last = localStorage.getItem('lastBackup');
  app.innerHTML = `
    <div class="card"><b>On this phone</b><div class="small muted">${trips.length} trips · ${rests.length} restaurants · ${photos} photos ${usage ? '· ' + usage : ''}</div>
      <div class="small" style="margin-top:6px">${persisted ? '🔒 Protected from automatic clean-up' : '⚠️ Not yet protected from automatic clean-up.'}</div>
      ${persisted ? '' : '<button class="btn" id="persist" style="margin-top:8px">Protect my data</button>'}</div>
    <div class="card"><b>Back up</b><p class="small muted">Saves everything, photos included, into one file. Keep it in Google Drive so you can restore it on a new phone.${last ? '<br>Last backup: ' + new Date(+last).toLocaleString() : ''}</p>
      <button class="btn primary block" id="exp">⬇️ Save backup file</button></div>
    <div class="card"><b>Restore</b><p class="small muted">Load a backup file. Matching items are updated; nothing else is deleted.</p>
      <button class="btn block" id="imp">⬆️ Restore from file</button></div>
    <div class="card"><b>Install on your phone</b><p class="small muted">In Chrome, tap ⋮ then "Add to Home screen" (or "Install app"). After that, open Wayfare from its icon; it works with no internet. Once installed, you can tap Share on any place in Google Maps and choose Wayfare to save it.</p></div>
    <p class="small muted" style="text-align:center">Wayfare v0.1</p>`;
  $('#persist') && ($('#persist').onclick = async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Protected' : 'Chrome declined. Install the app first, then try again.'); render(); });
  $('#exp').onclick = async () => {
    toast('Preparing backup…');
    const ph = await all('photos');
    const data = { app: 'wayfare', version: 1, exported: new Date().toISOString(), trips: await all('trips'), restaurants: await all('restaurants'),
      photos: await Promise.all(ph.map(async p => ({ id: p.id, caption: p.caption, created: p.created, data: await blobToDataURL(p.blob) }))) };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const name = `wayfare-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); localStorage.setItem('lastBackup', Date.now()); render(); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    localStorage.setItem('lastBackup', Date.now()); setTimeout(render, 500);
  };
  $('#imp').onclick = () => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'application/json,.json';
    i.onchange = async () => {
      try {
        const data = JSON.parse(await i.files[0].text());
        if (data.app !== 'wayfare') throw new Error('Not a Wayfare backup');
        for (const p of data.photos || []) await put('photos', { id: p.id, caption: p.caption, created: p.created, blob: await dataURLToBlob(p.data) });
        for (const r of data.restaurants || []) await put('restaurants', r);
        for (const t of data.trips || []) await put('trips', t);
        toast(`Restored ${data.restaurants?.length || 0} restaurants, ${data.trips?.length || 0} trips`); render();
      } catch (e) { toast('Could not read that file: ' + e.message); }
    };
    i.click();
  };
});

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
render();

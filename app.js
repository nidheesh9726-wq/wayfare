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
// Date maths is done in UTC so it gives the same answer in every time zone (e.g. India, UTC+5:30).
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function todayISO() { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10); }
// Repairs trips saved by v0.2 in time zones east of UTC, where every day got the same date.
function repairDays(t) {
  const seen = {}, out = [];
  for (const d of t.days || []) { if (seen[d.date]) seen[d.date].items.push(...d.items); else { seen[d.date] = d; out.push(d); } }
  if (out.length === (t.days || []).length) return false;
  t.days = buildDays(t.start, t.end, out); return true;
}
const priceText = r => r.price === -1 ? '· Free' : r.price > 0 ? '· ' + '$'.repeat(r.price) : '';
function stars(n) { return n ? '<span class="stars">' + '★'.repeat(n) + '</span>' : ''; }
function splitList(s) { return String(s || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean); }
function safeUrl(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } }
// Opens Google Maps turn-by-turn directions from where you are now. Uses exact coordinates when saved,
// otherwise the name and city (short shared links can't be turned into directions).
const mapsPoint = r => typeof r.lat === 'number' && typeof r.lng === 'number' ? `${r.lat},${r.lng}` : [r.name, r.address, r.city].filter(Boolean).join(', ');
function navHref(r, mode) {
  const dest = mapsPoint(r);
  if (!dest) return '';
  return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(dest) + (mode ? '&travelmode=' + mode : '') + '&dir_action=navigate';
}
// Route between two saved spots (not from where you are now).
function routeHref(from, to, mode) {
  return 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(mapsPoint(from)) + '&destination=' + encodeURIComponent(mapsPoint(to)) + (mode ? '&travelmode=' + mode : '');
}
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


// ---------- locations ----------
// Full Google Maps links carry coordinates; short maps.app.goo.gl links don't (and a web app can't open them to find out).
function coordsFromText(t) {
  t = decodeURIComponent(String(t || ''));
  const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /[?&](?:q|query|ll|center|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/];
  for (const p of pats) { const m = t.match(p); if (m) { const lat = +m[1], lng = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }; } }
  return null;
}
const hasLoc = r => typeof r.lat === 'number' && typeof r.lng === 'number';
function distKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtDist(km) {
  const walk = Math.round(km * 1.3 / 0.08); // ~80 m a minute, streets ~30% longer than a straight line
  const d = km < 1 ? Math.round(km * 1000 / 10) * 10 + ' m' : km.toFixed(km < 10 ? 1 : 0) + ' km';
  return d + (km <= 3 ? ` · ~${Math.max(1, walk)} min walk` : '');
}
function myPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Location is not available on this device'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
      e => rej(new Error(e.code === 1 ? 'Location permission was declined' : 'Could not get your location')), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}
// Look a name up on OpenStreetMap (needs internet; sends only the name and city you typed).
async function nominatim(q) {
  const res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Lookup failed');
  return (await res.json()).map(x => ({ lat: +x.lat, lng: +x.lon, label: x.display_name }));
}
// Photon searches the same map data but copes better with partial and misspelt names.
async function photon(q) {
  const res = await fetch('https://photon.komoot.io/api/?limit=5&q=' + encodeURIComponent(q));
  if (!res.ok) throw new Error('Lookup failed');
  return ((await res.json()).features || []).map(f => {
    const p = f.properties || {};
    return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: [p.name, p.street && [p.housenumber, p.street].filter(Boolean).join(' '), p.district, p.city, p.country].filter(Boolean).join(', ') };
  });
}
async function lookupPlace(q) {
  const tries = [() => nominatim(q), () => photon(q)];
  let found = [], failures = 0;
  for (const t of tries) {
    try { for (const x of await t()) if (!found.some(y => Math.abs(y.lat - x.lat) < 1e-4 && Math.abs(y.lng - x.lng) < 1e-4)) found.push(x); }
    catch { failures++; }
    if (found.length >= 3) break;
  }
  if (!found.length && failures === tries.length) throw new Error('offline');
  return found.slice(0, 6);
}
// Location block used on the form and the detail page. onSet({lat,lng,src}) is called when a location is chosen.
function locationBlock(el, r, getQuery, onSet) {
  const draw = () => {
    el.innerHTML = `<div class="small">${hasLoc(r) ? `📍 Location saved <span class="muted">(${esc({ link: 'from the Maps link', gps: 'from your phone’s GPS', lookup: 'looked up by name', typed: 'pasted coordinates' }[r.locSrc] || 'saved')})</span> · <a class="link" href="#" data-loc="clear">Remove</a>`
      : '<span class="muted">No location yet. Add one to see what’s nearby.</span>'}</div>
      <div class="row" style="margin-top:6px;flex-wrap:wrap"><button type="button" class="btn grow" data-loc="lookup">🔎 Look up by name</button><button type="button" class="btn grow" data-loc="paste">📋 Paste coordinates</button><button type="button" class="btn grow" data-loc="gps">📡 I’m here now</button></div>
      <div id="locres"></div>`;
  };
  draw();
  el.onclick = async e => {
    const b = e.target.closest('[data-loc],[data-pick]'); if (!b) return;
    e.preventDefault();
    const set = (lat, lng, src) => { Object.assign(r, { lat, lng, locSrc: src }); onSet && onSet(); draw(); toast('Location saved'); };
    if (b.dataset.loc === 'clear') { delete r.lat; delete r.lng; delete r.locSrc; onSet && onSet(); draw(); }
    if (b.dataset.loc === 'paste') {
      const box = $('#locres', el);
      box.innerHTML = `<div class="card small" style="margin:8px 0 0">
        <b>Get the coordinates from Google Maps</b>
        <ol style="margin:6px 0;padding-left:20px"><li>Find the spot in Google Maps.</li><li><b>Press and hold</b> on its exact spot until a red pin drops.</li><li>The numbers appear in the search bar at the top, like <code>13.7527, 100.5048</code>. Tap them and copy.</li></ol>
        <div class="row"><input id="coordin" class="grow" inputmode="decimal" placeholder="13.7527, 100.5048">${navigator.clipboard?.readText ? '<button type="button" class="btn" data-loc="clip">Paste</button>' : ''}</div>
        <p class="muted" id="coordmsg" style="margin:6px 0 0">A full Google Maps link works here too.</p></div>`;
      const inp = $('#coordin', el);
      inp.oninput = () => { const c = coordsFromText(inp.value); if (c) set(c.lat, c.lng, 'typed'); else if (inp.value.trim()) $('#coordmsg', el).textContent = 'That doesn’t look like coordinates yet. They should look like 13.7527, 100.5048'; };
      inp.focus();
    }
    if (b.dataset.loc === 'clip') {
      try { const t = await navigator.clipboard.readText(); const c = coordsFromText(t); if (c) set(c.lat, c.lng, 'typed'); else toast('Copied text isn’t coordinates. Copy the numbers from Google Maps first.'); }
      catch { toast('Couldn’t read the clipboard. Long-press the box and choose Paste.'); }
    }
    if (b.dataset.loc === 'gps') { try { toast('Finding you…'); const p = await myPosition(); set(p.lat, p.lng, 'gps'); } catch (err) { toast(err.message); } }
    if (b.dataset.loc === 'lookup') {
      const q = getQuery(); if (!q.trim()) { toast('Add a name first'); return; }
      const box = $('#locres', el); box.innerHTML = '<p class="small muted">Looking up…</p>';
      try {
        let found = await lookupPlace(q);
        const name = q.split(',')[0];
        if (!found.length && name !== q) found = await lookupPlace(name);
        box.innerHTML = found.length ? `<p class="small muted" style="margin:8px 0 4px">Tap the right one:</p><ul class="list">${found.map((x, i) => `<li data-pick="${i}" style="cursor:pointer"><span class="small">${esc(x.label)}</span></li>`).join('')}</ul>`
          : '<p class="small muted">Nothing found. Small restaurants often aren’t on these free maps. Use 📋 Paste coordinates instead. It takes about 10 seconds.</p>';
        box.dataset.found = JSON.stringify(found);
      } catch { box.innerHTML = '<p class="small muted">Couldn’t look it up. Check your internet connection, or use 📋 Paste coordinates.</p>'; }
    }
    if (b.dataset.pick !== undefined) { const x = JSON.parse($('#locres', el).dataset.found)[+b.dataset.pick]; set(x.lat, x.lng, 'lookup'); }
  };
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
  for (const t of trips) if (repairDays(t)) await put('trips', t);
  if (!trips.length) {
    app.innerHTML = `<div class="empty"><div class="big">🧳</div><p><b>No trips yet</b><br>Add a trip to plan it day by day.</p></div>`;
  } else {
    const today = todayISO();
    app.innerHTML = trips.map(t => {
      const nDays = (t.days || []).length;
      const status = t.start && t.end ? (today < t.start ? 'Upcoming' : today > t.end ? 'Past' : 'Happening now') : '';
      return `<a class="card rcard" href="#/trip/${t.id}">
        <div class="thumb ph">✈️</div>
        <div class="grow"><h3>${esc(t.name)}</h3>
        <div class="muted small">${esc(stopsSummary(t))}</div>
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

// A trip is split into destinations (stops), each with a number of days.
// Days are handed out in order from the first day: Tokyo 3, Kyoto 2 → days 1–3 Tokyo, 4–5 Kyoto.
function tripStops(t) {
  if (!t.stops) t.stops = splitList(t.destination).map(city => ({ id: uid(), city, days: 0 }));
  return t.stops;
}
function dayCount(start, end) {
  if (!start || !end || end < start) return 0;
  return Math.round((new Date(end + 'T00:00:00') - new Date(start + 'T00:00:00')) / 864e5) + 1;
}
function stopByDay(t) {
  const out = {}, inRange = (t.days || []).filter(d => d.date >= t.start && d.date <= t.end);
  let i = 0;
  for (const s of tripStops(t)) for (let k = 0; k < s.days && i < inRange.length; k++) out[inRange[i++].id] = s;
  return out;
}
const stopsSummary = t => tripStops(t).map(s => s.city).filter(Boolean).join(' → ') || t.destination || '';

function editTrip(trip) {
  const t = trip || { id: uid(), name: '', destination: '', stops: [], start: '', end: '', days: [], created: Date.now() };
  let stops = tripStops(t).map(s => ({ ...s }));
  if (!stops.length) stops.push({ id: uid(), city: '', days: 1 });
  sheet(`<h2>${trip ? 'Edit trip' : 'New trip'}</h2>
    <label class="f">Trip name</label><input id="tn" value="${esc(t.name)}" placeholder="Japan, spring 2027">
    <div class="row"><div class="grow"><label class="f">First day</label><input id="ts" type="date" value="${esc(t.start)}"></div>
    <div class="grow"><label class="f">Last day</label><input id="te" type="date" value="${esc(t.end)}"></div></div>
    <label class="f">Destinations, in order</label>
    <div id="stops"></div>
    <button class="btn block" id="addstop" style="margin-top:6px">+ Add destination</button>
    <p class="small" id="stopinfo"></p>
    <div class="row" style="margin-top:16px">${trip ? '<button class="btn danger" id="tdel">Delete</button>' : ''}<span class="grow"></span><button class="btn primary" id="tsave">Save</button></div>`,
    (el, close) => {
      const box = $('#stops', el), info = $('#stopinfo', el);
      const total = () => dayCount($('#ts', el).value, $('#te', el).value);
      const used = () => stops.reduce((n, s) => n + (s.days || 0), 0);
      const drawInfo = () => {
        const T = total(), U = used(), start = $('#ts', el).value;
        if (!T && start && U) info.innerHTML = `<span class="muted">Last day will be set to ${fmtDate(addDays(start, U - 1))} (${U} days).</span>`;
        else if (!T) info.innerHTML = '<span class="muted">Pick the trip dates, then share the days out between destinations.</span>';
        else if (U > T) info.innerHTML = `<b style="color:var(--danger)">${U} of ${T} days assigned: ${U - T} too many.</b> Remove some days or move the last day later.`;
        else info.innerHTML = `<b>${U} of ${T} days assigned</b>${U < T ? ` <span class="muted">· ${T - U} left to assign</span>` : ' ✓'}`;
      };
      const draw = () => {
        box.innerHTML = stops.map((s, i) => `<div class="stop" data-i="${i}">
          <input class="grow" data-k="city" value="${esc(s.city)}" placeholder="${['Tokyo', 'Kyoto', 'Osaka', 'Nara'][i % 4]}">
          <div class="stepper"><button class="btn icon" data-act="minus" aria-label="Fewer days">−</button><span><b>${s.days || 0}</b><small>day${s.days === 1 ? '' : 's'}</small></span><button class="btn icon" data-act="plus" aria-label="More days">+</button></div>
          ${i > 0 ? `<button class="btn icon" data-act="up" aria-label="Move up">↑</button>` : ''}
          <button class="btn icon" data-act="remove" aria-label="Remove">✕</button></div>`).join('');
        drawInfo();
      };
      draw();
      box.addEventListener('input', e => { const i = +e.target.closest('.stop').dataset.i; stops[i].city = e.target.value; });
      box.addEventListener('click', e => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        const i = +b.closest('.stop').dataset.i, s = stops[i], T = total();
        if (b.dataset.act === 'plus') { if (T && used() >= T) { toast(`All ${T} days are already assigned`); return; } s.days = (s.days || 0) + 1; }
        if (b.dataset.act === 'minus') s.days = Math.max(0, (s.days || 0) - 1);
        if (b.dataset.act === 'up') [stops[i - 1], stops[i]] = [stops[i], stops[i - 1]];
        if (b.dataset.act === 'remove') stops.splice(i, 1);
        draw();
      });
      $('#addstop', el).onclick = () => {
        const T = total(), left = T ? Math.max(0, T - used()) : 1;
        stops.push({ id: uid(), city: '', days: left }); draw();
        box.lastElementChild.querySelector('input').focus();
      };
      $('#ts', el).onchange = $('#te', el).onchange = drawInfo;
      $('#tsave', el).onclick = async () => {
        let start = $('#ts', el).value, end = $('#te', el).value;
        if (start && end && end < start) [start, end] = [end, start];
        const cleaned = stops.filter(s => s.city.trim()).map(s => ({ ...s, city: s.city.trim() }));
        const U = cleaned.reduce((n, s) => n + s.days, 0);
        if (start && !end) end = addDays(start, Math.max(U, 1) - 1);
        const T = dayCount(start, end);
        if (T && U > T) { toast(`That's ${U - T} day(s) more than the trip has`); return; }
        t.name = $('#tn', el).value.trim() || 'Untitled trip';
        t.start = start; t.end = end; t.stops = cleaned;
        t.destination = cleaned.map(s => s.city).join(', ');
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
  if (repairDays(t)) await put('trips', t);
  const rest = Object.fromEntries((await all('restaurants')).map(r => [r.id, r]));
  setHeader(t.name, { back: true, actions: '<button class="btn icon" id="edt" aria-label="Edit trip">✏️</button>' });
  $('#edt').onclick = () => editTrip(t);
  const today = todayISO();
  if (!t.days.length) {
    app.innerHTML = `<div class="empty"><div class="big">📅</div><p>Set the trip dates to get a page per day.</p></div>`;
    return;
  }
  const sbd = stopByDay(t);
  const stopDates = {};
  for (const d of t.days) { const s = sbd[d.id]; if (s) (stopDates[s.id] ||= []).push(d.date); }
  const unassigned = t.days.filter(d => !sbd[d.id] && d.date >= t.start && d.date <= t.end).length;
  let prevStop;
  app.innerHTML = `<p class="muted small">${esc(stopsSummary(t))}${unassigned && tripStops(t).length ? ` · <a class="link" href="#" id="assign">${unassigned} day${unassigned === 1 ? '' : 's'} not assigned to a city</a>` : ''}</p>` + t.days.map((d, i) => {
    const s = sbd[d.id];
    let head = '';
    if ((s && s !== prevStop) || (!s && prevStop)) {
      const ds = s && stopDates[s.id];
      head = s ? `<div class="stophead"><span>📍 ${esc(s.city)}</span><span class="muted small">${ds.length} day${ds.length === 1 ? '' : 's'} · ${fmtDate(ds[0], { day: 'numeric', month: 'short' })}${ds.length > 1 ? ' – ' + fmtDate(ds[ds.length - 1], { day: 'numeric', month: 'short' }) : ''}</span></div>`
        : `<div class="stophead"><span class="muted">No city set</span></div>`;
    }
    prevStop = s;
    const items = [...d.items].sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    return head + `<section class="card day" id="d-${d.id}">
      <div class="row"><div class="grow"><h3>Day ${i + 1} · ${fmtDate(d.date)} ${d.date === today ? '<span class="tag">Today</span>' : ''}</h3>
      <div class="muted small">${esc(d.title || '')}</div></div>
      <button class="btn icon" data-dayedit="${d.id}" aria-label="Rename day">✏️</button></div>
      ${items.map(it => {
        const r = it.restaurantId && rest[it.restaurantId];
        const href = r ? '#/r/' + r.id : '';
        const maps = r ? mapsHref(r) : safeUrl(it.mapsUrl) || (it.place ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(it.place) : '');
        return `<div class="item"><div class="t">${esc(it.time || '')}</div><div class="grow">
          <div><b>${r ? chipIcon(r) + ' ' : ''}${esc(r ? r.name : it.title)}</b></div>
          ${it.place && !r ? `<div class="small muted">${esc(it.place)}</div>` : ''}
          ${it.notes ? `<div class="small">${esc(it.notes)}</div>` : ''}
          <div class="small" style="margin-top:4px">${href ? `<a class="link" href="${href}">Details</a> · ` : ''}${maps ? `<a class="link" href="${esc(maps)}" target="_blank" rel="noopener">Map</a> · ` : ''}${(r || it.place) ? `<a class="link" href="${esc(navHref(r || { name: it.place }))}" target="_blank" rel="noopener">Navigate</a> · ` : ''}<a class="link" href="#" data-itemedit="${d.id}|${it.id}">Edit</a></div>
        </div></div>`;
      }).join('')}
      <div class="row dayadd" style="margin-top:10px"><button class="btn grow" data-additem="${d.id}">+ Plan</button><button class="btn grow" data-addfood="${d.id}">+ Restaurant</button><button class="btn grow" data-addplace="${d.id}">+ Place</button></div>
    </section>`;
  }).join('');
  $('#assign') && ($('#assign').onclick = e => { e.preventDefault(); editTrip(t); });
  app.onclick = e => {
    const b = e.target.closest('[data-additem],[data-addfood],[data-addplace],[data-itemedit],[data-dayedit]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.additem) editItem(t, b.dataset.additem);
    if (b.dataset.addfood) pickForDay(t, b.dataset.addfood, 'food');
    if (b.dataset.addplace) pickForDay(t, b.dataset.addplace, 'place');
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

// ======================================================================
// RESTAURANTS AND PLACES
// Both live in the same store; places have kind: 'place'. Older records have no kind and are restaurants.
// ======================================================================
// Meal types: a restaurant can have more than one (e.g. a café for breakfast and dessert).
const MEALS = [['breakfast', '🍳', 'Breakfast'], ['main', '🍽️', 'Lunch / dinner'], ['dessert', '🍰', 'Dessert']];
const CATS = [['sight', '🏛️', 'Sight / landmark'], ['shop', '🛍️', 'Shop / market'], ['building', '🏙️', 'Building'], ['museum', '🖼️', 'Museum / gallery'], ['nature', '🌳', 'Park / nature'], ['activity', '🎟️', 'Activity'], ['other', '📌', 'Other']];
const KINDS = {
  food: {
    tab: 'food', list: '#/food', newHash: '#/r-new', title: 'Restaurants', one: 'restaurant', icon: '🍽️',
    chips: MEALS, field: 'meals', chipsLabel: 'Meal', anyChip: 'Any meal',
    namePh: 'Ichiran Shibuya', addrPh: 'Near Shibuya station, B1 floor', notesPh: 'Opening hours, queue tips, cash only…', tagsPh: 'late night, vegetarian, needs booking',
    frontBtn: '📷 Front of restaurant', frontPrompt: '📷 Add a photo of the front, so you can spot it on the street', changeFront: 'Change front photo',
    galleryTitle: 'Food photos', galleryBtn: '🖼️ Food photos', galleryTip: 'Tip: screenshot dishes from Google Maps reviews or Instagram, then add them here.',
    listA: 'Must try', listAForm: 'Must-try dishes (what people recommend)', listAEmpty: 'Nothing yet. Tap ✏️ to add what people recommend.', itemPh: 'Add a dish',
    listB: 'My order', listBForm: 'What I want to order', listBEmpty: 'Nothing yet. Tap ✏️ to plan your order.', listBTip: 'Tick dishes off as you order them.',
    searchPh: 'Search name, dish, city, tag, notes…', emptyTitle: 'No restaurants yet',
  },
  place: {
    tab: 'places', list: '#/places', newHash: '#/p-new', title: 'Places', one: 'place', icon: '📍',
    chips: CATS, field: 'cats', chipsLabel: 'Type of place', anyChip: 'Any type',
    namePh: 'Wat Arun', addrPh: 'Near Tha Tien pier', notesPh: 'Opening hours, tickets, dress code, best time to go…', tagsPh: 'sunset, free entry, rainy day',
    frontBtn: '📷 Main photo', frontPrompt: '📷 Add a photo so you can recognise it when you get there', changeFront: 'Change main photo',
    galleryTitle: 'Photos', galleryBtn: '🖼️ More photos', galleryTip: 'Tip: save screenshots from Google Maps or Instagram, then add them here.',
    listA: 'Highlights', listAForm: "Highlights (what not to miss)", listAEmpty: 'Nothing yet. Tap ✏️ to add what not to miss.', itemPh: 'Add something',
    listB: 'My to-do list', listBForm: 'Things I want to do or buy here', listBEmpty: 'Nothing yet. Tap ✏️ to add things to do or buy.', listBTip: 'Tick things off as you go.',
    searchPh: 'Search name, highlight, city, tag, notes…', emptyTitle: 'No places yet',
  },
};
const kindOf = r => (r && r.kind === 'place' ? 'place' : 'food');
const chipTags = r => { const K = KINDS[kindOf(r)]; return K.chips.filter(([k]) => (r[K.field] || []).includes(k)).map(([, ic, l]) => `<span class="tag">${ic} ${l}</span>`).join(''); };
const chipNames = r => { const K = KINDS[kindOf(r)]; return K.chips.filter(([k]) => (r[K.field] || []).includes(k)).map(m => m[2]); };
const chipIcon = r => { const K = KINDS[kindOf(r)]; return (K.chips.find(([k]) => (r[K.field] || []).includes(k)) || [, K.icon])[1]; };
const ofKind = (list, kind) => list.filter(r => kindOf(r) === kind);

async function pickForDay(t, dayId, kind) {
  const K = KINDS[kind];
  const city = stopByDay(t)[dayId]?.city || '';
  const same = r => city && (r.city || '').toLowerCase() === city.toLowerCase() ? 0 : 1;
  const list = ofKind(await all('restaurants'), kind).sort((a, b) => same(a) - same(b) || a.name.localeCompare(b.name));
  sheet(`<h2>Add a ${K.one} to this day</h2>
    <div class="searchbar"><span>🔎</span><input id="ps" placeholder="Search your ${K.title.toLowerCase()}"></div>
    <div id="pl"></div>
    <button class="btn block" id="pnew" style="margin-top:10px">+ New ${K.one}</button>`,
    (el, close) => {
      const draw = () => {
        const q = $('#ps', el).value.toLowerCase();
        const f = list.filter(r => !q || [r.name, r.city, r.cuisine, ...chipNames(r)].join(' ').toLowerCase().includes(q));
        $('#pl', el).innerHTML = f.length ? `<ul class="list">${f.map(r => `<li data-id="${r.id}" style="cursor:pointer"><div class="grow"><b>${chipIcon(r)} ${esc(r.name)}</b><div class="small muted">${esc([r.cuisine, ...chipNames(r).slice(0, 1), r.city].filter(Boolean).join(' · '))}</div></div></li>`).join('')}</ul>` : '<p class="muted small">No matches.</p>';
      };
      draw(); $('#ps', el).oninput = draw;
      $('#pl', el).onclick = async e => {
        const li = e.target.closest('li[data-id]'); if (!li) return;
        t.days.find(x => x.id === dayId).items.push({ id: uid(), time: '', title: '', restaurantId: li.dataset.id, notes: '' });
        await put('trips', t); close(); render();
      };
      $('#pnew', el).onclick = () => { close(); location.hash = `${K.newHash}?trip=${t.id}&day=${dayId}&city=${encodeURIComponent(city)}`; };
    });
}

// Cities for the dropdown: each trip's destinations first, then any other city already used.
async function cityOptions(extra) {
  const seen = new Map(), groups = [];
  const add = (list, label) => {
    const fresh = [];
    for (const c of list) { const k = (c || '').trim().toLowerCase(); if (k && !seen.has(k)) { seen.set(k, c.trim()); fresh.push(c.trim()); } }
    if (fresh.length) groups.push([label, fresh]);
  };
  const trips = (await all('trips')).sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  for (const t of trips) add(tripStops(t).map(s => s.city), t.name);
  add([...(await all('restaurants')).map(r => r.city), extra].sort(), 'Other cities');
  return { groups, canonical: c => seen.get((c || '').trim().toLowerCase()) || (c || '').trim() };
}

const listStates = {};
for (const kind of ['food', 'place']) {
  const st = { q: '', city: '', cuisine: '', show: 'all', sort: 'recent', trip: '', chip: '' };
  try { Object.assign(st, JSON.parse(localStorage.getItem(kind + 'State') || '{}')); st.q = ''; if (st.meal && !st.chip) st.chip = st.meal; } catch {}
  listStates[kind] = st;
}
const saveState = kind => { try { localStorage.setItem(kind + 'State', JSON.stringify(listStates[kind])); } catch {} };

route(/^#\/food$/, () => listView('food'));
route(/^#\/places$/, () => listView('place'));

async function listView(kind) {
  const K = KINDS[kind], st = listStates[kind];
  setTab(K.tab); setHeader(K.title);
  const [everything, trips] = await Promise.all([all('restaurants'), all('trips')]);
  const list = ofKind(everything, kind);
  const tripOf = {};
  for (const t of trips) for (const d of t.days || []) for (const it of d.items) if (it.restaurantId) (tripOf[it.restaurantId] ||= new Set()).add(t.id);
  // Something belongs to a trip if it's on one of its days OR it's in one of the trip's cities.
  const tripCities = Object.fromEntries(trips.map(t => [t.id, new Set(tripStops(t).map(s => s.city.toLowerCase()))]));
  if (st.trip && !tripCities[st.trip]) st.trip = ''; // trip was deleted
  const cities = [...new Map(list.filter(r => r.city).map(r => [r.city.toLowerCase(), r.city])).values()].sort();
  const cuisines = [...new Set(list.map(r => r.cuisine).filter(Boolean))].sort();

  app.innerHTML = `
    <div class="searchbar"><span>🔎</span><input id="q" type="search" placeholder="${esc(K.searchPh)}" value="${esc(st.q)}"></div>
    <div class="chips" id="cities" style="margin-top:8px">
      <button class="chip ${!st.city ? 'on' : ''}" data-city="">All cities</button>
      ${cities.map(c => `<button class="chip ${st.city === c ? 'on' : ''}" data-city="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <div class="chips" id="chipf" style="flex-wrap:wrap">
      <button class="chip ${!st.chip ? 'on' : ''}" data-chip="">${K.anyChip}</button>
      ${K.chips.map(([k, ic, l]) => `<button class="chip ${st.chip === k ? 'on' : ''}" data-chip="${k}">${ic} ${l}</button>`).join('')}
    </div>
    <div class="row" style="margin-top:6px">
      ${kind === 'food' ? `<select id="cui" class="grow"><option value="">Any cuisine</option>${cuisines.map(c => `<option ${st.cuisine === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : ''}
      <select id="show" class="grow">
        <option value="all">All</option><option value="todo">Not visited</option><option value="visited">Visited</option><option value="fav">4★ and up</option>
      </select>
    </div>
    <div class="row" style="margin-top:6px">
      <select id="trip" class="grow"><option value="">Any trip</option>${trips.map(t => `<option value="${t.id}" ${st.trip === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <select id="sort" class="grow">
        <option value="recent">Newest first</option><option value="name">Name A–Z</option><option value="rating">Highest rated</option><option value="city">City</option><option value="near">Nearest to me</option>
      </select>
    </div>
    <div id="results"></div>`;
  $('#show').value = st.show; $('#sort').value = st.sort;
  if (kind !== 'food') st.cuisine = '';

  let here = null;
  const clear = () => { Object.assign(st, { q: '', city: '', cuisine: '', chip: '', trip: '', show: 'all' }); saveState(kind); render(); };
  const draw = () => {
    saveState(kind);
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    let f = list.filter(r => {
      if (st.city && (r.city || '').toLowerCase() !== st.city.toLowerCase()) return false;
      if (st.cuisine && r.cuisine !== st.cuisine) return false;
      if (st.chip && !(r[K.field] || []).includes(st.chip)) return false;
      if (st.show === 'todo' && r.visited) return false;
      if (st.show === 'visited' && !r.visited) return false;
      if (st.show === 'fav' && (r.rating || 0) < 4) return false;
      if (st.trip && !(tripOf[r.id]?.has(st.trip)) && !tripCities[st.trip].has((r.city || '').toLowerCase())) return false;
      if (words.length) {
        const hay = [r.name, r.city, r.cuisine, r.address, r.notes, ...(r.mustTry || []), ...(r.toOrder || []).map(x => x.text), ...(r.tags || []), ...chipNames(r)].join(' ').toLowerCase();
        return words.every(w => hay.includes(w));
      }
      return true;
    });
    const by = {
      recent: (a, b) => (b.created || 0) - (a.created || 0),
      name: (a, b) => a.name.localeCompare(b.name),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || a.name.localeCompare(b.name),
      city: (a, b) => (a.city || '~').localeCompare(b.city || '~') || a.name.localeCompare(b.name),
      near: (a, b) => (hasLoc(a) && here ? distKm(here, a) : 1e9) - (hasLoc(b) && here ? distKm(here, b) : 1e9) || a.name.localeCompare(b.name),
    }[st.sort];
    f.sort(by);
    const box = $('#results');
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="big">${K.icon}</div><p><b>${K.emptyTitle}</b><br>Tap + to add one, or share a place from Google Maps to Wayfare.</p></div>`;
      return;
    }
    const filtered = st.q || st.city || st.cuisine || st.chip || st.trip || st.show !== 'all';
    if (!f.length) {
      box.innerHTML = `<div class="empty"><div class="big">🔍</div><p><b>No ${K.title.toLowerCase()} match these filters</b><br>You have ${list.length} saved.</p><button class="btn primary" id="clearf">Clear filters</button></div>`;
      $('#clearf').onclick = clear;
      return;
    }
    box.innerHTML = `<p class="small muted row"><span class="grow">${f.length} of ${list.length}</span>${filtered ? '<a class="link" href="#" id="clearf">Clear filters</a>' : ''}</p>` + f.map(r => `
      <a class="card rcard" href="#/r/${r.id}">
        ${r.frontPhotoId ? `<img class="thumb" data-pid="${r.frontPhotoId}" alt="">` : r.foodPhotoIds?.[0] ? `<img class="thumb" data-pid="${r.foodPhotoIds[0]}" alt="">` : `<div class="thumb ph">${chipIcon(r)}</div>`}
        <div class="grow"><h3>${esc(r.name)} ${r.visited ? '✅' : ''}</h3>
          <div class="small muted">${esc([r.cuisine, r.city].filter(Boolean).join(' · '))} ${priceText(r)} ${stars(r.rating)}</div>
          ${st.sort === 'near' && here && hasLoc(r) ? `<div class="small">📍 ${fmtDist(distKm(here, r))}</div>` : ''}
          ${r.mustTry?.length ? `<div class="small">⭐ ${esc(r.mustTry.slice(0, 3).join(', '))}${r.mustTry.length > 3 ? '…' : ''}</div>` : ''}
          ${chipTags(r)}${(r.tags || []).map(x => `<span class="tag">${esc(x)}</span>`).join('')}
        </div></a>`).join('');
    $('#clearf') && ($('#clearf').onclick = e => { e.preventDefault(); clear(); });
    hydrateImgs(box);
  };
  draw();
  $('#q').oninput = e => { st.q = e.target.value; draw(); };
  $('#cities').onclick = e => { const c = e.target.closest('[data-city]'); if (!c) return; st.city = c.dataset.city; document.querySelectorAll('#cities .chip').forEach(x => x.classList.toggle('on', x === c)); draw(); };
  $('#chipf').onclick = e => { const c = e.target.closest('[data-chip]'); if (!c) return; st.chip = c.dataset.chip; document.querySelectorAll('#chipf .chip').forEach(x => x.classList.toggle('on', x === c)); draw(); };
  $('#cui') && ($('#cui').onchange = e => { st.cuisine = e.target.value; draw(); });
  $('#show').onchange = e => { st.show = e.target.value; draw(); };
  $('#sort').onchange = async e => {
    st.sort = e.target.value;
    if (st.sort === 'near' && !here) { try { toast('Finding you…'); here = await myPosition(); } catch (err) { toast(err.message); } }
    draw();
  };
  if (st.sort === 'near' && !here) myPosition().then(p => { here = p; draw(); }).catch(() => {});
  $('#trip').onchange = e => { st.trip = e.target.value; draw(); };
  fab(() => (location.hash = K.newHash));
}

// Detail page (restaurant or place)
route(/^#\/r\/([^/]+)$/, async id => {
  const r = await get('restaurants', id);
  if (!r) return (location.hash = '#/food');
  const K = KINDS[kindOf(r)];
  setTab(K.tab);
  setHeader(r.name, { back: true, actions: `<a class="btn icon" href="#/r-edit/${r.id}" aria-label="Edit">✏️</a>` });
  const maps = mapsHref(r);
  const trips = await all('trips');
  const onDays = [];
  for (const t of trips) (t.days || []).forEach((d, i) => { if (d.items.some(it => it.restaurantId === r.id)) onDays.push({ t, d, i }); });

  app.innerHTML = `
    ${r.frontPhotoId ? `<img class="hero" data-pid="${r.frontPhotoId}" alt="" id="hero">` : `<button class="btn block" id="addfront" style="padding:28px">${K.frontPrompt}</button>`}
    <div style="margin-top:12px">
      <div class="small muted">${esc([r.cuisine, r.city].filter(Boolean).join(' · '))} ${priceText(r)}</div>
      ${r.address ? `<div class="small">${esc(r.address)}</div>` : ''}
      <div style="margin-top:4px">${chipTags(r)}${(r.tags || []).map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>
    </div>
    <div class="row" style="margin-top:12px">
      ${navHref(r) ? `<a class="btn primary grow" href="${esc(navHref(r))}" target="_blank" rel="noopener">🧭 Navigate</a>` : ''}
      ${maps ? `<a class="btn grow" href="${esc(maps)}" target="_blank" rel="noopener">📍 Maps</a>` : ''}
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn grow" id="visit">${r.visited ? '✅ Visited' : 'Mark visited'}</button>
    </div>
    ${r.visited || r.rating ? `<div class="card"><div class="small muted">Your rating</div><div class="starpick" id="sp">${[1, 2, 3, 4, 5].map(n => `<button data-n="${n}" class="${n <= (r.rating || 0) ? 'on' : ''}">★</button>`).join('')}</div></div>` : ''}

    <h2>${K.listA}</h2>
    <div class="card">${r.mustTry?.length ? `<ul class="list">${r.mustTry.map(x => `<li>⭐ <span class="grow">${esc(x)}</span></li>`).join('')}</ul>` : `<span class="muted small">${K.listAEmpty}</span>`}</div>

    <h2>${K.listB}</h2>
    <div class="card">${r.toOrder?.length ? `<ul class="list" id="ord">${r.toOrder.map((x, i) => `<li><input type="checkbox" data-i="${i}" ${x.done ? 'checked' : ''}><span class="grow ${x.done ? 'done' : ''}">${esc(x.text)}</span></li>`).join('')}</ul><p class="small muted" style="margin:8px 0 0">${K.listBTip}</p>` : `<span class="muted small">${K.listBEmpty}</span>`}</div>

    <h2>${K.galleryTitle}</h2>
    <div class="gallery" id="gal">${(r.foodPhotoIds || []).map(p => `<div class="g"><img data-pid="${p}" alt="" data-view="${p}"></div>`).join('')}</div>
    <div class="row" style="margin-top:8px"><button class="btn grow" id="addfood">🖼️ Add from gallery</button><button class="btn grow" id="snapfood">📷 Camera</button></div>
    <p class="small muted">${K.galleryTip}</p>

    ${r.notes ? `<h2>Notes</h2><div class="card" style="white-space:pre-wrap">${esc(r.notes)}</div>` : ''}
    <h2>Nearby</h2>
    <div class="card" id="nearby"></div>
    ${onDays.length ? `<h2>In your itinerary</h2><div class="card">${onDays.map(({ t, d, i }) => `<div><a class="link" href="#/trip/${t.id}">${esc(t.name)}: Day ${i + 1}, ${fmtDate(d.date)}</a></div>`).join('')}</div>` : ''}
    ${r.frontPhotoId ? `<p style="margin-top:16px"><button class="btn" id="changefront">${K.changeFront}</button></p>` : ''}
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

  // Nearby: closest restaurants (and places) to this one, by straight-line distance.
  const everything = (await all('restaurants')).filter(x => x.id !== r.id);
  let nearKind = kindOf(r) === 'place' ? 'food' : 'place';
  const drawNearby = () => {
    const box = $('#nearby');
    if (!hasLoc(r)) { box.innerHTML = '<div id="locblk"></div>'; locationBlock($('#locblk'), r, () => [r.name, r.city].filter(Boolean).join(', '), async () => { await save(); drawNearby(); }); return; }
    const cands = ofKind(everything, nearKind);
    const withLoc = cands.filter(hasLoc).map(x => ({ x, km: distKm(r, x) })).sort((a, b) => a.km - b.km);
    const shown = withLoc.slice(0, 8), missing = cands.length - withLoc.length;
    box.innerHTML = `<div class="chips" id="nk" style="margin-bottom:6px">
        <button class="chip ${nearKind === 'food' ? 'on' : ''}" data-nk="food">🍽️ Restaurants</button><button class="chip ${nearKind === 'place' ? 'on' : ''}" data-nk="place">📍 Places</button></div>
      ${shown.length ? `<ul class="list">${shown.map(({ x, km }) => `<li style="align-items:center"><a class="rcard grow" href="#/r/${x.id}" style="align-items:center">
          ${x.frontPhotoId ? `<img class="thumb" style="width:52px;height:52px" data-pid="${x.frontPhotoId}" alt="">` : `<div class="thumb ph" style="width:52px;height:52px;font-size:22px">${chipIcon(x)}</div>`}
          <div class="grow"><b>${esc(x.name)}</b> ${x.visited ? '✅' : ''}<div class="small muted">${fmtDist(km)}</div><div>${chipTags(x)}</div></div></a>
          <a class="btn icon" style="flex:none;font-size:14px" href="${esc(routeHref(r, x, km <= 2 ? 'walking' : ''))}" target="_blank" rel="noopener" aria-label="Route from ${esc(r.name)} to ${esc(x.name)}">↪️ Route</a></li>`).join('')}</ul>`
        : `<p class="small muted">No ${KINDS[nearKind].title.toLowerCase()} with a location yet.</p>`}
      ${missing ? `<p class="small muted" style="margin:8px 0 0">${missing} other ${missing === 1 ? KINDS[nearKind].one : KINDS[nearKind].title.toLowerCase()} ${missing === 1 ? 'has' : 'have'} no location yet, so ${missing === 1 ? 'it isn’t' : 'they aren’t'} included.</p>` : ''}
      <p class="small muted" style="margin:8px 0 0">↪️ Route shows the way from ${esc(r.name)} to that spot.</p>
      <p class="small muted" style="margin:8px 0 0">📍 This ${KINDS[kindOf(r)].one}’s location: ${esc({ link: 'from the Maps link', gps: 'from your phone’s GPS', lookup: 'looked up by name', typed: 'pasted coordinates' }[r.locSrc] || 'saved')}. Change it with ✏️.</p>`;
    hydrateImgs(box);
    $('#nk').onclick = e => { const c = e.target.closest('[data-nk]'); if (c) { nearKind = c.dataset.nk; drawNearby(); } };
  };
  drawNearby();
});

// Add/edit form
route(/^#\/r-new(?:\?(.*))?$/, async qs => itemForm('food', null, new URLSearchParams(qs || '')));
route(/^#\/p-new(?:\?(.*))?$/, async qs => itemForm('place', null, new URLSearchParams(qs || '')));
route(/^#\/r-edit\/([^/]+)$/, async id => { const r = await get('restaurants', id); itemForm(kindOf(r), r); });

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

async function itemForm(kind, existing, params = new URLSearchParams()) {
  const K = KINDS[kind];
  setTab(K.tab);
  const shared = params.get('share') ? parseShare(params) : {};
  const r = existing || { id: uid(), kind: kind === 'place' ? 'place' : undefined, name: shared.name || '', city: params.get('city') || '', [K.field]: [], cuisine: '', address: '', mapsUrl: shared.mapsUrl || '', mustTry: [], toOrder: [], tags: [], notes: '', price: 0, rating: 0, visited: false, frontPhotoId: null, foodPhotoIds: [], created: Date.now() };
  setHeader(existing ? `Edit ${K.one}` : `New ${K.one}`, { back: true });
  const all_ = ofKind(await all('restaurants'), 'food');
  const co = await cityOptions(r.city);
  const curCity = co.canonical(r.city);
  const cuisines = [...new Set(all_.map(x => x.cuisine).filter(Boolean))];
  let pendingFront = null, pendingFood = [];
  const otherKind = kind === 'food' ? 'place' : 'food';

  app.innerHTML = `
    ${!existing ? `<div class="chips" style="margin-bottom:4px"><span class="small muted" style="align-self:center">Save as</span>
      <button class="chip ${kind === 'food' ? 'on' : ''}" data-kind="food">🍽️ Restaurant</button><button class="chip ${kind === 'place' ? 'on' : ''}" data-kind="place">📍 Place</button></div>` : ''}
    ${shared.mapsUrl ? '<div class="card small">📍 Added from Google Maps. Check the name, then fill in the rest.</div>' : ''}
    <label class="f">Name</label><input id="n" value="${esc(r.name)}" placeholder="${esc(K.namePh)}">
    <label class="f">Google Maps link</label><input id="m" value="${esc(r.mapsUrl)}" inputmode="url" placeholder="Paste from Maps → Share → Copy link">
    <label class="f">Location (for “nearby”)</label><div id="loc"></div>
    <label class="f">City</label>
    <select id="c"><option value="">Choose a city</option>
      ${co.groups.map(([label, cs]) => `<optgroup label="${esc(label)}">${cs.map(c => `<option ${c === curCity ? 'selected' : ''}>${esc(c)}</option>`).join('')}</optgroup>`).join('')}
      <option value="__new">＋ Type a new city…</option></select>
    <input id="cnew" placeholder="City name" hidden style="margin-top:6px">
    <label class="f">${K.chipsLabel}</label>
    <div class="chips" id="kchips" style="flex-wrap:wrap">${K.chips.map(([k, ic, l]) => `<button type="button" class="chip ${(r[K.field] || []).includes(k) ? 'on' : ''}" data-chip="${k}">${ic} ${l}</button>`).join('')}</div>
    ${kind === 'food' ? `<label class="f">Cuisine</label><input id="cu" list="cul" value="${esc(r.cuisine)}" placeholder="Ramen">
    <datalist id="cul">${cuisines.map(c => `<option value="${esc(c)}">`).join('')}</datalist>` : ''}
    <label class="f">Area / address (optional)</label><input id="a" value="${esc(r.address)}" placeholder="${esc(K.addrPh)}">
    <label class="f">Price</label><select id="pr"><option value="0">Not set</option>${kind === 'place' ? '<option value="-1" ' + (r.price === -1 ? 'selected' : '') + '>Free</option>' : ''}${[1, 2, 3, 4].map(n => `<option value="${n}" ${r.price === n ? 'selected' : ''}>${'$'.repeat(n)}</option>`).join('')}</select>

    <label class="f">${K.listAForm}</label>${listEditor('mt', r.mustTry || [], K.itemPh)}
    <label class="f">${K.listBForm}</label>${listEditor('to', (r.toOrder || []).map(x => x.text), K.itemPh)}
    <label class="f">Tags (comma separated)</label><input id="tg" value="${esc((r.tags || []).join(', '))}" placeholder="${esc(K.tagsPh)}">
    <label class="f">Notes</label><textarea id="no" placeholder="${esc(K.notesPh)}">${esc(r.notes)}</textarea>

    ${existing ? '' : `<label class="f">Photos</label>
      <div class="row"><button class="btn grow" id="pf">${K.frontBtn}</button><button class="btn grow" id="pfd">${K.galleryBtn}</button></div>
      <p class="small muted" id="pinfo"></p>`}
    <div class="row" style="margin-top:18px">${existing ? '<button class="btn danger" id="del">Delete</button>' : ''}<span class="grow"></span><button class="btn primary" id="save">Save</button></div>`;

  // Switch between restaurant and place while adding, keeping what's typed in the name and link.
  app.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    if (b.dataset.kind === kind) return;
    const p = new URLSearchParams(params); p.delete('share'); p.delete('title'); p.delete('text'); p.delete('url');
    p.set('name', $('#n').value); p.set('maps', $('#m').value);
    history.replaceState(null, '', KINDS[otherKind].newHash + '?' + p.toString()); render();
  });
  if (!existing && params.get('name') !== null) { $('#n').value = params.get('name'); $('#m').value = params.get('maps') || ''; }
  // Location: taken from a full Maps link automatically, or set by GPS / name lookup.
  const fromLink = () => { const c = coordsFromText($('#m').value); if (c && !(hasLoc(r) && r.locSrc !== 'link')) { Object.assign(r, c, { locSrc: 'link' }); drawLoc(); } };
  const cityVal = () => $('#c').value === '__new' ? $('#cnew').value : ($('#c').value || '');
  const drawLoc = () => locationBlock($('#loc'), r, () => [$('#n').value, cityVal()].filter(Boolean).join(', '));
  drawLoc(); fromLink(); $('#m').addEventListener('input', fromLink);
  wireListEditor($('#mt'), K.itemPh); wireListEditor($('#to'), K.itemPh);
  if (!co.groups.length) { $('#c').value = '__new'; $('#cnew').hidden = false; }
  $('#c').onchange = e => { const isNew = e.target.value === '__new'; $('#cnew').hidden = !isNew; if (isNew) $('#cnew').focus(); };
  $('#kchips').onclick = e => { const c = e.target.closest('[data-chip]'); if (c) c.classList.toggle('on'); };
  if (!existing) {
    const info = () => { $('#pinfo').textContent = [pendingFront ? 'Main photo added' : '', pendingFood.length ? pendingFood.length + ' photo(s) added' : ''].filter(Boolean).join(' · '); };
    $('#pf').onclick = async () => { const f = await pickFiles(false); if (f.length) { pendingFront = f[0]; info(); } };
    $('#pfd').onclick = async () => { const f = await pickFiles(true); pendingFood.push(...f); info(); };
    if (!$('#n').value) $('#n').focus();
  }
  $('#save').onclick = async () => {
    const name = $('#n').value.trim();
    if (!name) { toast('Give it a name first'); $('#n').focus(); return; }
    const prevOrder = Object.fromEntries((r.toOrder || []).map(x => [x.text, x.done]));
    Object.assign(r, {
      name, mapsUrl: $('#m').value.trim(), city: $('#c').value === '__new' ? co.canonical($('#cnew').value) : $('#c').value,
      [K.field]: [...document.querySelectorAll('#kchips .chip.on')].map(c => c.dataset.chip), cuisine: $('#cu') ? $('#cu').value.trim() : '',
      address: $('#a').value.trim(), price: +$('#pr').value, mustTry: readList($('#mt')),
      toOrder: readList($('#to')).map(text => ({ text, done: !!prevOrder[text] })),
      tags: splitList($('#tg').value), notes: $('#no').value.trim(), updated: Date.now(),
    });
    if (kind === 'place') r.kind = 'place'; else delete r.kind;
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
    history.replaceState(null, '', K.list); render();
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
    <div class="card"><b>On this phone</b><div class="small muted">${trips.length} trips · ${ofKind(rests, 'food').length} restaurants · ${ofKind(rests, 'place').length} places · ${photos} photos ${usage ? '· ' + usage : ''}</div>
      <div class="small" style="margin-top:6px">${persisted ? '🔒 Protected from automatic clean-up' : '⚠️ Not yet protected from automatic clean-up.'}</div>
      ${persisted ? '' : '<button class="btn" id="persist" style="margin-top:8px">Protect my data</button>'}</div>
    <div class="card"><b>Back up</b><p class="small muted">Saves everything, photos included, into one file. Keep it in Google Drive so you can restore it on a new phone.${last ? '<br>Last backup: ' + new Date(+last).toLocaleString() : ''}</p>
      <button class="btn primary block" id="exp">⬇️ Save backup file</button></div>
    <div class="card"><b>Restore</b><p class="small muted">Load a backup file. Matching items are updated; nothing else is deleted.</p>
      <button class="btn block" id="imp">⬆️ Restore from file</button></div>
    <div class="card"><b>Install on your phone</b><p class="small muted">In Chrome, tap ⋮ then "Add to Home screen" (or "Install app"). After that, open Wayfare from its icon; it works with no internet. Once installed, you can tap Share on any place in Google Maps and choose Wayfare to save it.</p></div>
    <p class="small muted" style="text-align:center">Wayfare v0.11 · <a class="link" href="#" id="upd">Check for updates</a></p>`;
  $('#upd').onclick = async e => {
    e.preventDefault();
    if (!window.swReg) { toast('Updates aren’t available here'); return; }
    toast('Checking…');
    try {
      await window.swReg.update();
      const w = window.swReg.installing || window.swReg.waiting;
      if (w) toast('Updating, the app will reload in a moment'); else toast('You have the latest version');
    } catch { toast('Couldn’t check. Are you online?'); }
  };
  $('#persist') && ($('#persist').onclick = async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Protected' : 'Chrome declined. Install the app first, then try again.'); render(); });
  $('#exp').onclick = async () => {
    toast('Preparing backup…');
    const ph = await all('photos');
    const data = { app: 'wayfare', version: 1, exported: new Date().toISOString(), trips: await all('trips'), restaurants: await all('restaurants'),
      photos: await Promise.all(ph.map(async p => ({ id: p.id, caption: p.caption, created: p.created, data: await blobToDataURL(p.blob) }))) };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const name = `wayfare-backup-${todayISO()}.json`;
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
        toast(`Restored ${data.restaurants?.length || 0} restaurants and places, ${data.trips?.length || 0} trips`); render();
      } catch (e) { toast('Could not read that file: ' + e.message); }
    };
    i.click();
  };
});

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  // updateViaCache 'none' makes the phone always ask the website for the newest version.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    window.swReg = reg;
    // Check for a new version whenever the app comes back on screen, not only on a fresh start.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  });
  // When a new version is installed, reload once so it shows straight away.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !document.querySelector('.sheet-bg')) location.reload(); });
}
render();

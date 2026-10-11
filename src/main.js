import * as maplibregl from 'maplibre-gl';
import { LngLat } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import { CITIES } from './cities.js';
import { landmarksLayer } from './landmarks.js';
import { style, MODES, applyMode, registerFacades } from './mapstyle.js';
import { wikiIntro, cityGuide, nearbyShops, SHOP_KINDS, distance } from './api.js';
import { createPano } from './pano.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEG = Math.PI / 180;
const body = document.body.classList;

maplibregl.setWorkerUrl(workerUrl); // let Vite bundle the worker; MapLibre's own lookup breaks under bundling
const map = new maplibregl.Map({
  container: 'map', style, center: [112, 26], zoom: 1.7,
  maxPitch: 85, centerClampedToGround: false,
  canvasContextAttributes: { antialias: true },
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.on('error', e => console.warn('[map]', e.error?.message ?? e));
const landmarks = landmarksLayer();

// ---------- state ----------

const state = { city: null, mode: 'day', run: 0, markers: [], spot: null, pano: false, hd: false, shopReq: 0 };
const pano = createPano($('#pano canvas'));

function setMode(name) {
  state.mode = name;
  applyMode(map, name);
  landmarks.setMode(name);
  $('#btn-time').textContent = MODES[name].label;
}

const setLabels = on => {
  for (const id of ['label-road', 'label-place', 'label-water']) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
};

function toast(text, ms = 3200) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- camera helpers ----------

const offset = ([lng, lat], east, north) => [lng + east / (111320 * Math.cos(lat * DEG)), lat + north / 110574];
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const ground = ll => (map.getTerrain() && map.queryTerrainElevation(ll)) || 0;
const lookFrom = (cam, look) => map.calculateCameraOptionsFromTo(new LngLat(cam[0], cam[1]), cam[2], new LngLat(look[0], look[1]), look[2]);
const moveEnd = () => new Promise(r => map.once('moveend', r));

async function tilesReady(ms) {
  for (const t0 = performance.now(); !map.areTilesLoaded() && performance.now() - t0 < ms;) await sleep(100);
}

// Camera for a tour shot at progress t (0..1). Orbit bearings are measured from the target to the camera.
// g: ground elevation added to all altitudes; roll: dutch angle that swells mid-shot.
function shotCamera(s, t, g = 0) {
  const e = 0.5 - Math.cos(Math.PI * t) / 2;
  let opts;
  if (s.orbit) {
    const [lng, lat, targetAlt, r, camAlt, b0, b1] = s.orbit, b = (b0 + (b1 - b0) * e) * DEG;
    opts = lookFrom([...offset([lng, lat], r * Math.sin(b), r * Math.cos(b)), camAlt + g], [lng, lat, targetAlt + g]);
  } else {
    const c = lerp(s.cam[0], s.cam[1], e), l = lerp(s.look[0], s.look[1], e);
    opts = lookFrom([c[0], c[1], c[2] + g], [l[0], l[1], l[2] + g]);
  }
  return { ...opts, roll: (s.roll ?? 0) * Math.sin(Math.PI * t) };
}

// A pleasant three-quarter view of a spot, camera placed behind the current bearing.
function spotView(s, r = Math.max(420, s.h * 1.9)) {
  const g = ground(s.ll), b = (map.getBearing() + 180) * DEG;
  return lookFrom([...offset(s.ll, r * Math.sin(b), r * Math.cos(b)), g + r * 0.55 + s.h * 0.3], [...s.ll, g + s.h * 0.4]);
}

// Each city's promo has its own look: colour grade, title treatment, letterbox, pacing, cuts and time-of-day arc.
// grade: CSS filter on the map; pace: shot length factor; roll: dutch angle (deg); fade: [colour, out ms, in ms].
const FILMS = {
  gold: { name: '海派金调', modes: ['day', 'dusk', 'night'], grade: 'contrast(1.06) saturate(1.12) sepia(.08)', accent: '#f2c36b', bar: 11 },
  ink: { name: '水墨', modes: ['day', 'day', 'dusk'], grade: 'saturate(.72) sepia(.22) contrast(1.1)', accent: '#c8322a', bar: 9, pace: 1.1, fade: ['#f1ece2', 700, 900] },
  jade: { name: '烟雨', modes: ['day', 'day', 'dusk'], grade: 'saturate(.9) hue-rotate(-8deg) brightness(1.05) contrast(.96)', accent: '#8fd6b4', bar: 10, pace: 1.15, fade: ['#eef4f0', 800, 1000] },
  bloom: { name: '花城暖调', modes: ['dusk', 'dusk', 'night'], grade: 'saturate(1.2) contrast(1.05) sepia(.06)', accent: '#ff8a5b', bar: 11 },
  neon: { name: '霓虹', modes: ['dusk', 'night', 'night'], grade: 'contrast(1.12) saturate(1.2)', accent: '#35d0ff', bar: 12, pace: 0.9 },
  cyber: { name: '赛博 8D', modes: ['night'], grade: 'contrast(1.14) saturate(1.3) hue-rotate(-8deg)', accent: '#ff3d6e', bar: 12, pace: 0.8, roll: 7, fade: ['#000', 120, 260] },
  sakura: { name: '和风', modes: ['day', 'dusk', 'night'], grade: 'saturate(1.08) contrast(1.04) brightness(1.03)', accent: '#ff86a8', bar: 11 },
  steel: { name: '钢铁森林', modes: ['day', 'dusk', 'night'], grade: 'contrast(1.18) saturate(.75)', accent: '#ffd23f', bar: 13, english: true, pace: 0.9 },
  rose: { name: '玫瑰金', modes: ['dusk', 'dusk', 'night'], grade: 'sepia(.18) saturate(1.1) brightness(1.03)', accent: '#f1c7a1', bar: 11, pace: 1.1, fade: ['#1a0f0a', 600, 900] },
};
const filmOf = city => FILMS[city.film] ?? FILMS.gold;

// Shots are chosen by what the subject is: towers get a rising crane, mid-height sights a lateral fly-by,
// low sights a descending reveal, alternating with orbits so no two neighbouring shots move alike.
function autoTour(city, film) {
  const v = city.view, n = city.spots.length, pace = film.pace ?? 1;
  const mode = i => film.modes[Math.min(film.modes.length - 1, Math.floor(i / (n + 1) * film.modes.length))];
  const shots = city.spots.map((s, i) => {
    const b = (v.bearing + 180 + i * 71) % 360, h = s.h, at = (r, deg, alt) => [...offset(s.ll, r * Math.sin(deg * DEG), r * Math.cos(deg * DEG)), alt];
    let move;
    if (h >= 200 && i % 2 === 0) { // crane up the tower
      const r = Math.max(480, h * 1.3);
      move = { cam: [at(r, b, h * 0.5), at(r * 1.1, b + 20, h * 1.2)], look: [[...s.ll, h * 0.35], [...s.ll, h * 0.85]] };
    } else if (h >= 50 && h < 200 && i % 2 === 0) { // fly past
      const r = Math.max(380, h * 2.2), alt = r * 0.35 + h * 0.5;
      move = { cam: [at(r, b - 35, alt), at(r, b + 35, alt)], look: [[...s.ll, h * 0.5], [...s.ll, h * 0.5]] };
    } else if (h < 50 && i % 2 === 0) { // descend from above
      move = { cam: [at(150, b, 700), at(520, b + 25, 280)], look: [[...s.ll, 0], [...s.ll, h * 0.3]] };
    } else {
      const r = Math.max(380, h * 1.7), sweep = i % 4 === 1 ? 55 : -55;
      move = { orbit: [...s.ll, h * 0.45, r, r * 0.45 + h * 0.35, b, b + sweep] };
    }
    return {
      title: s.name, sub: s.en.toUpperCase(), spot: s.id, dur: 8 * pace, ground: true, mode: mode(i + 1),
      roll: film.roll ? (i % 2 ? film.roll : -film.roll) : 0, ...move,
    };
  });
  shots.push({
    title: city.name, sub: `${city.en.toUpperCase()} · ${city.tagline}`, dur: 12 * pace, mode: film.modes.at(-1), ground: true,
    orbit: [...v.center, 80, 2600, 1100, v.bearing + 160, v.bearing + 215],
  });
  return shots;
}

// ---------- cinematic tour ----------

const fader = $('#fader');
async function fade(on, ms) {
  fader.style.transitionDuration = ms + 'ms';
  fader.style.opacity = on ? 1 : 0;
  await sleep(ms);
}

function stopTour() {
  state.run++;
  map.stop();
  return state.run;
}

function animateShot(s, token, onTick) {
  return new Promise(resolve => {
    const g = s.ground ? ground(s.orbit ? s.orbit.slice(0, 2) : s.look[0]) : 0;
    const t0 = performance.now();
    const step = now => {
      if (token !== state.run) return resolve();
      const t = Math.min((now - t0) / (s.dur * 1000), 1);
      map.jumpTo(shotCamera(s, t, g));
      onTick(t);
      t < 1 ? requestAnimationFrame(step) : resolve();
    };
    requestAnimationFrame(step);
  });
}

async function playTour(city = state.city, token = stopTour()) {
  closeDrawers();
  body.remove('explore');
  body.add('cinema');
  setLabels(false);
  map.jumpTo({ padding: { top: 0, right: 0, bottom: 0, left: 0 } });
  const film = filmOf(city), [fadeColor, fadeOut, fadeIn] = film.fade ?? ['#000', 450, 700];
  document.body.dataset.film = city.film ?? 'gold';
  document.body.style.setProperty('--accent', film.accent);
  document.body.style.setProperty('--grade', film.grade);
  document.body.style.setProperty('--film-bar', film.bar + 'vh');
  fader.style.background = fadeColor;
  const shots = city.tour ?? autoTour(city, film);
  const total = shots.reduce((sum, s) => sum + s.dur, 0);
  let elapsed = 0;
  const progress = t => { $('#cin-progress').style.width = `${Math.min(100, t * 100)}%`; };
  progress(0);

  setMode(shots[0].mode);
  const card = $('#title-card');
  card.querySelector('h1').textContent = film.english ? city.en.toUpperCase() : city.name;
  card.querySelector('p').textContent = `${film.english ? city.name : city.en.toUpperCase()} · ${city.tagline}`;
  card.querySelector('.seal').textContent = city.name;
  card.classList.add('in');

  // Establishing flight (from space when arriving from the globe).
  const far = map.getZoom() < 9;
  const g0 = shots[0].ground ? ground(shots[0].orbit?.slice(0, 2) ?? shots[0].look[0]) : 0;
  map.flyTo({ ...shotCamera(shots[0], 0, g0), duration: far ? 9000 : 4500, curve: 1.5, essential: true });
  await moveEnd();
  await tilesReady(2500);
  card.classList.remove('in');
  if (token !== state.run) return;

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (i > 0) {
      await fade(true, fadeOut);
      if (token !== state.run) return fade(false, 300);
      setMode(s.mode);
      map.jumpTo(shotCamera(s, 0, s.ground ? ground(s.orbit?.slice(0, 2) ?? s.look[0]) : 0));
      await tilesReady(2500);
      fade(false, fadeIn);
    }
    showCaption(s, i, shots.length);
    highlight(s.spot);
    await animateShot(s, token, t => progress((elapsed + t * s.dur) / total));
    elapsed += s.dur;
    if (token !== state.run) return;
  }
  $('#caption').classList.remove('in');
  highlight(null);
  explore();
  toast('宣传片结束 · 点击景点标记查看介绍，或拖动地图自由探索');
}

function showCaption(s, i, n) {
  const c = $('#caption');
  c.classList.remove('in');
  void c.offsetWidth; // restart the CSS animation
  c.querySelector('.idx').textContent = `${String(i + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
  c.querySelector('h2').textContent = s.title;
  c.querySelector('p').textContent = s.sub;
  c.classList.add('in');
}

function explore() {
  body.remove('cinema');
  body.add('explore');
  $('#title-card').classList.remove('in');
  $('#caption').classList.remove('in');
  fade(false, 300);
  setLabels(true);
  highlight(null);
  if (map.getRoll()) map.jumpTo({ roll: 0 });
}

// Any direct interaction during the promo hands control to the viewer.
for (const ev of ['pointerdown', 'wheel', 'touchstart']) {
  map.getCanvasContainer().addEventListener(ev, () => { if (body.contains('cinema')) { stopTour(); explore(); } }, { passive: true });
}

// ---------- cities & markers ----------

function enterCity(city) {
  hidePicker();
  state.city = city;
  $('#city-name').textContent = city.name;
  history.replaceState(null, '', '#' + city.id);
  clearShops();
  map.setTerrain(city.terrain ? { source: 'dem', exaggeration: 1 } : null);
  for (const m of state.markers) m.remove();
  state.markers = city.spots.map((s, i) => {
    const el = document.createElement('div');
    el.className = 'poi';
    el.dataset.id = s.id;
    el.innerHTML = `<button class="pin" aria-label="${esc(s.name)}">${i + 1}</button><span class="name">${esc(s.name)}</span>
      <div class="hint"><b>${esc(s.name)}</b><small>${esc(s.en)}</small>
        <span><button data-act="info">查看介绍</button><button data-act="enter">${s.pano ? '进入 360° 实景' : '进入景点'}</button></span></div>`;
    el.addEventListener('click', e => {
      e.stopPropagation();
      e.target.dataset.act === 'enter' ? enterSpot(s) : openSpot(s);
    });
    return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(s.ll).addTo(map);
  });
  $('#spots').innerHTML = `<h3>${esc(city.name)} · 精选景点</h3><ol>${city.spots.map(s =>
    `<li><button data-id="${s.id}"><b>${esc(s.name)}</b><small>${esc(s.en)}</small>${s.pano ? '<i>360°</i>' : ''}</button></li>`).join('')}</ol>`;
  playTour(city);
}

// Hide marker names that would overlap an earlier (higher-priority) one.
function declutter() {
  const placed = [];
  for (const m of state.markers) {
    const el = m.getElement(), p = map.project(m.getLngLat());
    const box = [p.x + 18, p.y - 44, p.x + 22 + (el.nameWidth ||= el.querySelector('.name').offsetWidth), p.y - 22];
    const hit = placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    el.classList.toggle('crowded', hit);
    if (!hit) placed.push(box);
  }
}
map.on('render', () => { if (state.markers.length && !declutter.queued) declutter.queued = requestAnimationFrame(() => { declutter.queued = 0; declutter(); }); });

function highlight(id) {
  for (const m of state.markers) m.getElement().classList.toggle('active', m.getElement().dataset.id === id);
}

$('#spots').addEventListener('click', e => {
  const id = e.target.closest('button[data-id]')?.dataset.id;
  const s = id && state.city.spots.find(x => x.id === id);
  if (s) openSpot(s);
});

// ---------- city picker ----------

let countdownTimer;
function showPicker(autostart) {
  body.add('picking');
  body.remove('explore', 'cinema');
  $('#picker').hidden = false;
  $('#city-grid').innerHTML = CITIES.map((c, i) => `
    <button class="city-card" data-id="${c.id}" style="--c:${c.color}">
      ${i === 0 ? '<span class="badge">默认</span>' : ''}
      <b>${esc(c.name)}</b><small>${esc(c.en)}</small><span>${esc(c.tagline)}</span>
      <em>${c.spots.length} 个景点 · ${filmOf(c).name}宣传片${c.spots.some(s => s.pano) ? ' · 360°' : ''}</em>
    </button>`).join('');
  clearInterval(countdownTimer);
  const cd = $('#countdown');
  cd.textContent = '';
  if (autostart) {
    let n = 8;
    const tick = () => {
      cd.innerHTML = `<b>${n}</b> 秒后自动进入 <b>${CITIES[0].name}</b> · 点击任意城市立即出发`;
      if (n-- <= 0) { clearInterval(countdownTimer); enterCity(CITIES[0]); }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }
  spinGlobe();
}

function hidePicker() {
  clearInterval(countdownTimer);
  body.remove('picking');
  $('#picker').hidden = true;
}

function spinGlobe() {
  if (!body.contains('picking')) return;
  if (!map.isMoving()) map.setCenter([map.getCenter().lng + 0.035, map.getCenter().lat]);
  requestAnimationFrame(spinGlobe);
}

$('#city-grid').addEventListener('click', e => {
  const id = e.target.closest('.city-card')?.dataset.id;
  if (id) enterCity(CITIES.find(c => c.id === id));
});
$('#picker').addEventListener('pointerdown', e => {
  if (e.target.closest('.city-card')) return;
  clearInterval(countdownTimer);
  $('#countdown').textContent = '请选择想去的城市';
});
$('#city-btn').addEventListener('click', () => {
  stopTour();
  closeDrawers();
  showPicker(false);
  map.flyTo({ center: map.getCenter(), zoom: 2.2, pitch: 0, bearing: 0, duration: 3500, essential: true });
});

// ---------- spot panel ----------

function closeDrawers() {
  $('#panel').hidden = true;
  $('#guide').hidden = true;
  body.remove('drawer-open');
}

function openDrawer(el) {
  closeDrawers();
  el.hidden = false;
  el.scrollTop = 0;
  body.add('drawer-open');
}

const drawerPadding = () => innerWidth > 760 ? { top: 60, left: 0, bottom: 0, right: 420 } : { top: 60, left: 0, right: 0, bottom: innerHeight * 0.55 };

function openSpot(s) {
  stopTour();
  explore();
  state.spot = s;
  highlight(s.id);
  map.flyTo({ ...spotView(s), padding: drawerPadding(), duration: 2600, essential: true });
  const p = $('#panel');
  p.innerHTML = `
    <button class="close" aria-label="关闭">✕</button>
    <div class="hero"><div class="shimmer"></div></div>
    <p class="eyebrow">${esc(state.city.name)} · ${esc(s.en)}</p>
    <h2>${esc(s.name)}</h2>
    <div class="actions">
      <button class="primary" data-act="enter">${s.pano ? '进入 360° 实景' : '进入景点 · 近景环绕'}</button>
      <button data-act="tab-shops">附近美食与店铺</button>
    </div>
    <div class="tabs"><button class="on" data-tab="info">景点介绍</button><button data-tab="shops">附近店铺</button></div>
    <section data-pane="info">
      <p class="desc">${esc(s.desc)}</p>
      <ul class="tips">${s.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="wiki"><p class="muted">正在从维基百科获取更多介绍…</p></div>
    </section>
    <section data-pane="shops" hidden></section>`;
  openDrawer(p);
  p.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('close')) { closeDrawers(); clearShops(); highlight(null); }
    else if (b.dataset.act === 'enter') enterSpot(s);
    else if (b.dataset.act === 'tab-shops' || b.dataset.tab) showTab(p, s, b.dataset.tab ?? 'shops');
    else if (b.dataset.ll) {
      const ll = JSON.parse(b.dataset.ll);
      map.flyTo({ center: ll, zoom: 17.5, pitch: 60, padding: drawerPadding(), duration: 1800, essential: true });
    }
  };
  wikiIntro(s.wiki).then(w => {
    if (state.spot !== s) return;
    if (w.img) p.querySelector('.hero').innerHTML = `<img src="${esc(w.img)}" alt="${esc(s.name)}" referrerpolicy="no-referrer">`;
    else p.querySelector('.hero').remove();
    p.querySelector('.wiki').innerHTML = `<h4>百科</h4><p>${esc(w.text)}</p><a href="${esc(w.url)}" target="_blank" rel="noopener">来源：维基百科 · 阅读全文 ↗</a>`;
  }).catch(() => {
    if (state.spot !== s) return;
    p.querySelector('.hero')?.remove();
    p.querySelector('.wiki').innerHTML = '<p class="muted">维基百科暂时无法访问，已显示本地精选介绍。</p>';
  });
}

function showTab(p, s, tab) {
  p.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  p.querySelectorAll('[data-pane]').forEach(el => { el.hidden = el.dataset.pane !== tab; });
  if (tab === 'shops' && !p.querySelector('[data-pane=shops]').childElementCount) loadShops(s, p.querySelector('[data-pane=shops]'));
  if (tab === 'shops') p.querySelector('.tabs').scrollIntoView({ behavior: 'smooth' });
}

// ---------- nearby shops ----------

function tileShops(ll, radius = 600) {
  const seen = new Set();
  return map.querySourceFeatures('ofm', { sourceLayer: 'poi' }).flatMap(f => {
    const p = f.properties, kind = SHOP_KINDS[p.class], name = p['name:zh-Hans'] ?? p['name:zh'] ?? p.name;
    if (!kind || !name || seen.has(name)) return [];
    const at = f.geometry.coordinates, dist = distance(ll, at);
    if (dist > radius) return [];
    seen.add(name);
    return [{ name, en: p['name:en'], label: kind[0], icon: kind[1], ll: at, dist }];
  }).sort((a, b) => a.dist - b.dist);
}

async function loadShops(s, box) {
  const req = ++state.shopReq;
  box.innerHTML = '<p class="muted">正在搜索 600 米内的餐厅、咖啡与商店…</p>';
  const quick = tileShops(s.ll);
  if (quick.length) renderShops(box, quick, 'OpenFreeMap 矢量瓦片（OpenStreetMap 数据）', true);
  try {
    const items = await nearbyShops(s.ll);
    if (req === state.shopReq && items.length) renderShops(box, items, 'Overpass API（OpenStreetMap 实时数据）');
    else if (req === state.shopReq && !quick.length) box.innerHTML = '<p class="muted">附近暂无收录的店铺。</p>';
  } catch {
    if (req === state.shopReq && !quick.length) box.innerHTML = '<p class="muted">店铺数据服务繁忙，请稍后重试。</p>';
    else if (req === state.shopReq) box.querySelector('.source').textContent += ' · 实时接口繁忙，已显示缓存数据';
  }
}

function renderShops(box, items, source, pending = false) {
  items = items.slice(0, 80);
  const groups = [...new Set(items.map(i => i.label))];
  box.innerHTML = `
    <p class="source">共 ${items.length} 家 · 数据来源：${esc(source)}${pending ? ' · 正在获取实时详情…' : ''}</p>
    <div class="chips"><button class="on" data-filter="">全部</button>${groups.map(g => `<button data-filter="${esc(g)}">${esc(g)}</button>`).join('')}</div>
    <ul class="shops">${items.map(i => `
      <li data-label="${esc(i.label)}"><button data-ll="${esc(JSON.stringify(i.ll))}">
        <span class="ico">${i.icon}</span>
        <span><b>${esc(i.name)}</b>${i.en && i.en !== i.name ? `<small>${esc(i.en)}</small>` : ''}
          <em>${esc(i.label)} · ${Math.round(i.dist)} m${i.extra ? ' · ' + esc(i.extra) : ''}</em></span>
      </button>${/^https?:\/\//.test(i.web ?? '') ? `<a href="${esc(i.web)}" target="_blank" rel="noopener nofollow">官网 ↗</a>` : ''}</li>`).join('')}</ul>`;
  box.querySelector('.chips').onclick = e => {
    const f = e.target.dataset.filter;
    if (f === undefined) return;
    box.querySelectorAll('.chips button').forEach(b => b.classList.toggle('on', b === e.target));
    box.querySelectorAll('.shops li').forEach(li => { li.hidden = f && li.dataset.label !== f; });
  };
  map.getSource('shops').setData({
    type: 'FeatureCollection',
    features: items.map(i => ({ type: 'Feature', properties: { name: i.name }, geometry: { type: 'Point', coordinates: i.ll } })),
  });
}

const clearShops = () => map.getSource('shops')?.setData({ type: 'FeatureCollection', features: [] });

// ---------- enter a spot: fly in, then 360° panorama or a slow orbit ----------

async function enterSpot(s) {
  const token = stopTour();
  explore();
  closeDrawers();
  highlight(s.id);
  map.flyTo({ ...spotView(s, Math.max(260, s.h * 1.25)), padding: { top: 0, right: 0, bottom: 0, left: 0 }, duration: 3200, essential: true });
  await moveEnd();
  if (token !== state.run) return;
  if (s.pano) return openPano(s);
  toast(`已抵达 ${s.name} · 近景环绕中，拖动地图即可接管`);
  map.easeTo({ bearing: map.getBearing() + 100, duration: 36000, easing: t => t });
}

async function openPano(s) {
  const el = $('#pano');
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  $('#pano-title').textContent = `${s.name} · 360° 实景`;
  $('#pano-credit').textContent = `全景摄影：${s.pano.credit}`;
  $('#pano-loading').hidden = false;
  state.pano = true;
  try {
    await pano.open(s.pano.url, s.pano.yaw);
  } catch {
    toast('全景图加载失败，请检查网络后重试');
    return closePano();
  }
  $('#pano-loading').hidden = true;
}

function closePano() {
  state.pano = false;
  const el = $('#pano');
  el.classList.remove('show');
  setTimeout(() => { if (!state.pano) { el.hidden = true; pano.close(); } }, 700);
}
$('#pano-close').addEventListener('click', closePano);

// ---------- city guide (Wikivoyage) ----------

async function openGuide() {
  const city = state.city;
  if (!city) return;
  stopTour();
  explore();
  const g = $('#guide');
  g.innerHTML = `<button class="close" aria-label="关闭">✕</button><p class="eyebrow">TRAVEL GUIDE · ${esc(city.en.toUpperCase())}</p>
    <h2>${esc(city.name)}旅游攻略</h2><div class="guide-body"><p class="muted">正在从维基导游获取攻略…</p></div>`;
  openDrawer(g);
  g.querySelector('.close').onclick = closeDrawers;
  try {
    const { sections, url } = await cityGuide(city.name);
    if (state.city !== city) return;
    g.querySelector('.guide-body').innerHTML = sections.map((s, i) => `
      <details ${i < 2 ? 'open' : ''}><summary>${esc(s.title)}</summary>${s.text.split(/\n+/).map(line => {
        const h = line.match(/^=+\s*(.*?)\s*=+$/);
        return h ? `<h4>${esc(h[1])}</h4>` : `<p>${esc(line)}</p>`;
      }).join('')}</details>`).join('') +
      `<a class="src" href="${esc(url)}" target="_blank" rel="noopener">来源：维基导游 Wikivoyage（CC BY-SA）· 查看原文 ↗</a>`;
  } catch {
    g.querySelector('.guide-body').innerHTML = '<p class="muted">攻略服务暂时无法访问，请检查网络后重试。</p>';
  }
}

// ---------- toolbar, keyboard ----------

$('#skip').addEventListener('click', () => { stopTour(); explore(); toast('已进入自由探索 · WASD 飞行，点击景点查看介绍'); });
$('#btn-tour').addEventListener('click', () => state.city && playTour());
$('#btn-guide').addEventListener('click', openGuide);
$('#btn-time').addEventListener('click', () => setMode({ day: 'dusk', dusk: 'night', night: 'day' }[state.mode]));
$('#btn-4k').addEventListener('click', () => {
  state.hd = !state.hd;
  map.setPixelRatio(state.hd ? Math.max(devicePixelRatio, 3840 / innerWidth) : devicePixelRatio);
  $('#btn-4k').classList.toggle('on', state.hd);
  const c = map.getCanvas();
  toast(state.hd ? `4K 超清渲染已开启 · ${c.width}×${c.height}` : '已恢复标准分辨率');
});

const keys = new Set();
function flyLoop() {
  if (!keys.size) return;
  const has = k => +keys.has(k), v = 10;
  const dx = (has('d') - has('a')) * v, dy = (has('s') - has('w')) * v;
  if (dx || dy) map.panBy([dx, dy], { duration: 0 });
  const rot = (has('e') - has('q')) * 0.9, tilt = (has('r') - has('f')) * 0.6;
  if (rot || tilt) map.jumpTo({ bearing: map.getBearing() + rot, pitch: Math.min(85, Math.max(0, map.getPitch() + tilt)) });
  requestAnimationFrame(flyLoop);
}
addEventListener('keydown', e => {
  if (e.target.closest?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') return state.pano ? closePano() : closeDrawers();
  const k = e.key.toLowerCase();
  if (state.pano || body.contains('picking') || !'wasdqerf'.includes(k) || k.length !== 1) return;
  if (body.contains('cinema')) { stopTour(); explore(); }
  if (!keys.size) requestAnimationFrame(flyLoop);
  keys.add(k);
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

// ---------- boot ----------

map.on('load', () => {
  registerFacades(map);
  map.addLayer(landmarks, 'shops-dot');
  setMode('day');
  $('#loader').classList.add('done');
  const fromHash = CITIES.find(c => location.hash === '#' + c.id);
  fromHash ? enterCity(fromHash) : showPicker(true);
});

// Handy for debugging in the console.
Object.assign(window, { map, state, CITIES, enterCity, playTour, setMode });

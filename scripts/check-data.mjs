// Usage: node scripts/check-data.mjs [--net]
// Offline: structure of CITIES. --net: wiki titles resolve, coordinates not in water (Overpass).
import { CITIES } from '../src/cities.js';
import { distance, nearbyShops } from '../src/api.js';

const net = process.argv.includes('--net');
const errors = [], warns = [];
const err = m => errors.push(m), warn = m => warns.push(m);
// Spots that really are on water (or a waterside area mapped as water); excluded from the water check.
// bund / stars: waterfront promenades whose OSM water polygon overlaps the walkway (Nominatim reverse geocodes both to the promenade).
const ON_WATER = new Set(['xihu', 'santan', 'harbour', 'duanqiao', 'bund', 'stars']);
const lngLat = ll => Array.isArray(ll) && ll.length >= 2 && Math.abs(ll[0]) <= 180 && Math.abs(ll[1]) <= 90;

const cityIds = new Set();
for (const c of CITIES) {
  const at = `[${c.id}]`;
  if (cityIds.has(c.id)) err(`${at} duplicate city id`);
  cityIds.add(c.id);
  for (const k of ['name', 'en', 'tagline', 'color']) if (!c[k]) err(`${at} missing ${k}`);
  if (!lngLat(c.view?.center) || !c.view.zoom) err(`${at} bad view`);
  const ids = new Set();
  for (const s of c.spots) {
    const p = `${at}/${s.id}`;
    if (ids.has(s.id)) err(`${p} duplicate spot id`);
    ids.add(s.id);
    for (const k of ['name', 'en', 'wiki', 'desc']) if (!s[k]) err(`${p} missing ${k}`);
    if (!lngLat(s.ll)) { err(`${p} bad ll`); continue; }
    if (!(s.h > 0 && s.h < 1000)) err(`${p} implausible h=${s.h}`);
    if (!Array.isArray(s.tips) || !s.tips.length) err(`${p} missing tips`);
    const d = distance(c.view.center, s.ll);
    if (d > 40000) err(`${p} is ${(d / 1000).toFixed(0)} km from city center`);
    if (s.pano && !(s.pano.url && typeof s.pano.yaw === 'number' && s.pano.credit)) err(`${p} bad pano`);
    // Never invent prices / opening hours: flag currency amounts in prose.
    if (/[¥￥$€]\s?\d|\d+\s?元(?!人民币)|票价/.test(s.desc + (s.tips ?? []).join(''))) warn(`${p} mentions a price; verify`);
  }
  for (const [i, t] of (c.tour ?? []).entries()) {
    const p = `${at}/tour[${i}]`;
    if (t.spot && !ids.has(t.spot)) err(`${p} unknown spot ${t.spot}`);
    if (!(t.dur > 0) || !t.title) err(`${p} bad dur/title`);
    if (t.orbit) {
      const [lng, lat, ta, r, ca] = t.orbit;
      if (!lngLat([lng, lat]) || !(r > 0)) err(`${p} bad orbit`);
      if (ca < ta) err(`${p} camera altitude ${ca} below target ${ta}`);
    } else if (t.cam && t.look) {
      for (let j = 0; j < 2; j++) {
        if (!lngLat(t.cam[j]) || !lngLat(t.look[j])) err(`${p} bad cam/look`);
        else if (t.cam[j][2] < t.look[j][2]) err(`${p} camera ${j} altitude ${t.cam[j][2]} below target ${t.look[j][2]}`);
      }
    } else err(`${p} needs orbit or cam+look`);
  }
}

// nearbyShops must survive one mirror answering with an HTML error page and elements without coordinates.
{
  const realFetch = globalThis.fetch;
  const ok = { elements: [{ lon: 121.4867, lat: 31.2389, tags: { name: 'A', amenity: 'cafe' } }, { tags: { name: 'no coordinates', shop: 'gift' } }] };
  globalThis.fetch = async url => String(url).includes('overpass-api.de') ? new Response('<html>busy</html>') : Response.json(ok);
  const got = await nearbyShops([121.48665, 31.2388]).catch(e => e);
  if (!(Array.isArray(got) && got.length === 1 && got[0].label === '咖啡')) err(`nearbyShops fallback broken: ${got?.message ?? JSON.stringify(got)}`);
  globalThis.fetch = async () => new Response('gateway timeout', { status: 504 });
  if (!((await nearbyShops([0, 0]).catch(e => e)) instanceof Error)) err('nearbyShops should reject when every mirror fails');
  globalThis.fetch = realFetch;
}

if (net) {
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  const overpass = async q => {
    let last;
    for (const u of OVERPASS) for (let i = 0; i < 1; i++) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'User-Agent': 'yunyou-check/1.0', Accept: '*/*' }, body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(70000) });
        return JSON.parse(await r.text());
      } catch (e) { last = e; await new Promise(r => setTimeout(r, 2000)); }
    }
    throw last;
  };
  // One batched request (Wikipedia rate-limits bursts); redirects/variants are resolved server-side.
  try {
    const titles = [...new Set(CITIES.flatMap(c => c.spots.map(s => s.wiki)))];
    for (let i = 0; i < titles.length; i += 50) {
      const q = new URLSearchParams({ action: 'query', format: 'json', redirects: 1, converttitles: 1, variant: 'zh-cn', titles: titles.slice(i, i + 50).join('|') });
      const j = await (await fetch(`https://zh.wikipedia.org/w/api.php?${q}`, { headers: { 'User-Agent': 'yunyou-check/1.0' }, signal: AbortSignal.timeout(20000) })).json();
      for (const pg of Object.values(j.query.pages)) if ('missing' in pg) err(`wiki title "${pg.title}" not found`);
    }
  } catch (e) { warn(`wiki check failed: ${e.message}`); }
  // One request per city (the public servers throttle bursts): each spot contributes one `out count`, in order.
  for (const c of CITIES) {
    const spots = c.spots.filter(s => !ON_WATER.has(s.id));
    try {
      const j = await overpass('[out:json][timeout:60];' + spots.map(s =>
        `is_in(${s.ll[1]},${s.ll[0]})->.a;(area.a["natural"~"^(water|bay|strait)$"];area.a["place"="sea"];);out count;`).join(''));
      if (j.elements?.length !== spots.length) throw new Error(`expected ${spots.length} counts, got ${j.elements?.length}`);
      j.elements.forEach((e, i) => { if (+e.tags.total) err(`[${c.id}/${spots[i].id}] coordinate is inside a water area`); });
    } catch (e) { warn(`[${c.id}] water check failed: ${e.message}`); }
  }
}

const n = CITIES.reduce((a, c) => a + c.spots.length, 0);
console.log(`${CITIES.length} cities, ${n} spots${net ? ' (net checks on)' : ''}`);
warns.forEach(m => console.log('WARN ', m));
errors.forEach(m => console.log('ERROR', m));
process.exit(errors.length ? 1 : 0);

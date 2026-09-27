// Keyless, CORS-enabled third-party APIs:
//   Wikipedia  – attraction intros + photos
//   Wikivoyage – city travel guides
//   Overpass   – nearby shops & restaurants from OpenStreetMap

async function mediawiki(host, params) {
  const q = new URLSearchParams({
    format: 'json', origin: '*', redirects: 1, converttitles: 1, variant: 'zh-cn', ...params,
  });
  const r = await fetch(`https://${host}/w/api.php?${q}`, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${host} ${r.status}`);
  const page = Object.values((await r.json()).query?.pages ?? {})[0];
  if (!page || 'missing' in page) throw new Error(`${host}: ${params.titles} not found`);
  return page;
}

export async function wikiIntro(title) {
  const p = await mediawiki('zh.wikipedia.org', {
    action: 'query', prop: 'extracts|pageimages|info', exintro: 1, explaintext: 1,
    piprop: 'thumbnail', pithumbsize: 960, inprop: 'url', titles: title,
  });
  return { text: p.extract, img: p.thumbnail?.source, url: p.fullurl };
}

export async function cityGuide(title) {
  const p = await mediawiki('zh.wikivoyage.org', {
    action: 'query', prop: 'extracts|info', explaintext: 1, exsectionformat: 'wiki', inprop: 'url', titles: title,
  });
  // Split on level-2 headings ("== 交通 =="); deeper headings stay inside the section text.
  const parts = p.extract.split(/^==([^=].*?)==\s*$/m);
  const sections = [{ title: '概览', text: parts[0].trim() }];
  for (let i = 1; i < parts.length; i += 2) sections.push({ title: parts[i].trim(), text: parts[i + 1].trim() });
  return { sections: sections.filter(s => s.text), url: p.fullurl };
}

// [label, icon] per OSM amenity/shop value; also used for the vector-tile POI classes.
export const SHOP_KINDS = {
  restaurant: ['餐厅', '🍜'], food_court: ['美食广场', '🍱'], fast_food: ['快餐', '🍔'], cafe: ['咖啡', '☕'],
  bar: ['酒吧', '🍸'], pub: ['酒馆', '🍺'], beer: ['酒馆', '🍺'], ice_cream: ['甜品', '🍦'], bakery: ['烘焙', '🥐'],
  mall: ['商场', '🏬'], department_store: ['百货', '🏬'], supermarket: ['超市', '🛒'], convenience: ['便利店', '🏪'],
  grocery: ['食品', '🛒'], clothes: ['服饰', '👗'], clothing_store: ['服饰', '👗'], shoes: ['鞋履', '👟'],
  jewelry: ['珠宝', '💍'], gift: ['礼品', '🎁'], souvenir: ['纪念品', '🎁'], books: ['书店', '📚'], tea: ['茶叶', '🍵'],
  alcohol: ['酒类', '🍷'], alcohol_shop: ['酒类', '🍷'], cosmetics: ['美妆', '💄'], art: ['艺术', '🎨'], shop: ['商店', '🛍️'],
};

export const distance = ([a, b], [c, d]) =>
  Math.hypot((c - a) * Math.cos(((b + d) / 2) * Math.PI / 180), d - b) * 111320;

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

export async function nearbyShops(ll, radius = 600) {
  const [lng, lat] = ll, around = `(around:${radius},${lat},${lng})`;
  const query = `[out:json][timeout:15];(nwr${around}["name"]["shop"];` +
    `nwr${around}["name"]["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|food_court)$"];);out center 150;`;
  let lastError;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(9000) });
      if (!r.ok) throw new Error(`overpass ${r.status}`);
      const items = (await r.json()).elements.map(e => {
        const t = e.tags, kind = t.amenity ?? t.shop;
        const [label, icon] = SHOP_KINDS[kind] ?? SHOP_KINDS.shop;
        const at = [e.lon ?? e.center.lon, e.lat ?? e.center.lat];
        const extra = [t.cuisine && `菜系：${t.cuisine.replaceAll(';', ' / ')}`, t.opening_hours && `营业：${t.opening_hours}`].filter(Boolean).join(' · ');
        return { name: t['name:zh'] ?? t.name, en: t['name:en'], label, icon, ll: at, dist: distance(ll, at), extra, web: t.website ?? t['contact:website'] };
      });
      return items.sort((a, b) => a.dist - b.dist);
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

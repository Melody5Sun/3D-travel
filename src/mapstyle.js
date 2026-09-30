import { hideLandmarkBuildings } from './landmarks.js';

// MapLibre style: OpenFreeMap vector tiles + Esri imagery + terrain, restyled per time of day.
const NAME = ['coalesce', ['get', 'name:zh-Hans'], ['get', 'name:zh'], ['get', 'name']];
const FONT = ['Noto Sans Regular'];
const LABEL_PAINT = { 'text-color': '#f3f5fa', 'text-halo-color': 'rgba(8,12,22,0.85)', 'text-halo-width': 1.4 };
const MAJOR_ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];

export const MODES = {
  day: {
    label: '白天', sat: [1, 0.05], water: 0, roads: 0, roof: ['#cfc6b8', '#a9b1b8'],
    sky: { 'sky-color': '#76aee9', 'horizon-color': '#eef2f6', 'fog-color': '#e4ebf3' },
    light: { anchor: 'map', color: '#fff3e2', intensity: 0.4, position: [1.4, 215, 40] },
  },
  dusk: {
    label: '黄昏', sat: [0.62, -0.1], water: 0.25, roads: 0.45, roof: ['#8c7468', '#6f6570'],
    sky: { 'sky-color': '#2b3370', 'horizon-color': '#ff8a4c', 'fog-color': '#f0976a' },
    light: { anchor: 'map', color: '#ffb07a', intensity: 0.5, position: [1.4, 265, 72] },
  },
  night: {
    label: '夜景', sat: [0.2, -0.5], water: 0.6, roads: 1, roof: ['#1a1b20', '#16181e'],
    sky: { 'sky-color': '#030814', 'horizon-color': '#1c2d52', 'fog-color': '#101a31' },
    light: { anchor: 'map', color: '#a8b8ff', intensity: 0.35, position: [1.4, 200, 30] },
  },
};
const SKY_BASE = {
  'sky-horizon-blend': 0.55, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.6,
  'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 8, 1, 11, 0],
};

export const style = {
  version: 8,
  projection: { type: 'globe' },
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sky: { ...SKY_BASE, ...MODES.day.sky },
  light: MODES.day.light,
  transition: { duration: 2500, delay: 0 },
  sources: {
    ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    sat: {
      type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    },
    dem: {
      type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: 'Terrain: Mapzen / AWS Open Data',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    },
    shops: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0a0f1a' } },
    { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 150 } },
    { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': '#08172e', 'fill-opacity': 0 } },
    {
      id: 'roads-glow', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 10,
      filter: ['in', ['get', 'class'], ['literal', MAJOR_ROADS]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ff9f3d', 'line-blur': 4, 'line-opacity': 0,
        'line-width': ['interpolate', ['exponential', 1.7], ['zoom'], 10, 1.5, 15, 9, 19, 60],
      },
    },
    {
      id: 'roads-core', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 10,
      filter: ['in', ['get', 'class'], ['literal', [...MAJOR_ROADS, 'minor', 'service']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffd9a0', 'line-opacity': 0,
        'line-width': ['interpolate', ['exponential', 1.7], ['zoom'], 10, 0.4, 15, 1.6, 19, 10],
      },
    },
    {
      id: 'buildings', type: 'fill-extrusion', source: 'ofm', 'source-layer': 'building', minzoom: 12.5,
      filter: ['all', ['!=', ['get', 'hide_3d'], true], hideLandmarkBuildings],
      paint: {
        'fill-extrusion-color': '#d9d3c7', // until the facade patterns are registered
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.5, ['get', 'render_height']],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.5, ['get', 'render_min_height']],
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      // Patterns also cover the tops, so cap every building with a thin solid roof slab.
      id: 'roofs', type: 'fill-extrusion', source: 'ofm', 'source-layer': 'building', minzoom: 12.5,
      filter: ['all', ['!=', ['get', 'hide_3d'], true], hideLandmarkBuildings],
      paint: {
        'fill-extrusion-color': '#c9c3b8',
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.5, ['+', ['get', 'render_height'], 0.15]],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.5, ['max', ['get', 'render_min_height'], ['-', ['get', 'render_height'], 0.6]]],
      },
    },
    {
      id: 'shops-dot', type: 'circle', source: 'shops',
      paint: { 'circle-radius': 5, 'circle-color': '#f2c36b', 'circle-stroke-color': '#1a1206', 'circle-stroke-width': 1.5, 'circle-pitch-alignment': 'map' },
    },
    {
      id: 'shops-label', type: 'symbol', source: 'shops', minzoom: 15.5,
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top' },
      paint: { 'text-color': '#ffe3ad', 'text-halo-color': 'rgba(10,8,4,0.9)', 'text-halo-width': 1.2 },
    },
    {
      id: 'label-water', type: 'symbol', source: 'ofm', 'source-layer': 'water_name',
      layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 13, 'text-letter-spacing': 0.2 },
      paint: { ...LABEL_PAINT, 'text-color': '#bfe0ff' },
    },
    {
      id: 'label-road', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 14,
      filter: ['in', ['get', 'class'], ['literal', MAJOR_ROADS]],
      layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 11.5, 'symbol-placement': 'line' },
      paint: LABEL_PAINT,
    },
    {
      id: 'label-place', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 3,
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'quarter', 'neighbourhood']]],
      layout: {
        'text-field': NAME, 'text-font': FONT,
        'text-size': ['match', ['get', 'class'], 'city', 17, 'town', 14, 12.5],
      },
      paint: LABEL_PAINT,
    },
  ],
};

// Procedural facades for the OSM buildings: towers get ribbon glazing (one glass band per floor), low buildings
// punched windows. At night lights come on in runs along a floor and some floors stay dark.
function facade(mode, tall) {
  const S = 96, fh = 12, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let s = tall ? 7 : 3; // seeded, so the city looks the same on every visit
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = { day: tall ? '#b7c0c7' : '#d9d0c1', dusk: tall ? '#7d7076' : '#9e8878', night: tall ? '#0f1116' : '#17181c' }[mode];
  g.fillRect(0, 0, S, S);
  const light = hue => `hsla(${hue}, 90%, ${68 + rnd() * 16}%, ${0.6 + rnd() * 0.35})`;
  for (let y = 0; y < S; y += fh) {
    const floorLit = mode === 'day' ? 0 : (rnd() < 0.5 ? 0.7 : 0.06) * (mode === 'dusk' ? 0.45 : 1);
    let on = rnd() < floorLit, hue = 28 + rnd() * 18;
    const switchRun = () => { if (rnd() < 0.25) { on = rnd() < floorLit; hue = 28 + rnd() * 18; } };
    if (tall) {
      const k = 148 + rnd() * 45; // reflections change floor by floor
      g.fillStyle = mode === 'day' ? `rgb(${k * 0.72},${k * 0.86},${k * 1.04})`
        : mode === 'dusk' ? `rgb(${150 + rnd() * 35},${100 + rnd() * 25},${92 + rnd() * 20})` : '#1b1e26';
      g.fillRect(0, y + 3, S, fh - 5);
      for (let x = 0; x < S; x += 6) {
        switchRun();
        if (on) { g.fillStyle = light(hue); g.fillRect(x, y + 3, 6, fh - 5); }
        g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(x, y + 3, 1, fh - 5); // mullion
      }
    } else {
      for (let x = 2; x < S; x += 8) {
        switchRun();
        const k = 78 + rnd() * 30;
        g.fillStyle = on ? light(hue) : { day: `rgb(${k - 22},${k - 12},${k})`, dusk: '#4b434a', night: '#20222a' }[mode];
        g.fillRect(x, y + 3, 4, fh - 6);
      }
    }
  }
  return g.getImageData(0, 0, S, S);
}

export function registerFacades(map) {
  for (const m of Object.keys(MODES)) for (const tall of [false, true]) map.addImage(`${tall ? 'tall' : 'low'}-${m}`, facade(m, tall), { pixelRatio: 2 });
}

// Day / dusk / night for the MapLibre layers; the three.js landmarks follow via landmarks.setMode.
export function applyMode(map, name) {
  const m = MODES[name];
  map.setSky({ ...SKY_BASE, ...m.sky });
  map.setLight(m.light);
  map.setPaintProperty('sat', 'raster-brightness-max', m.sat[0]);
  map.setPaintProperty('sat', 'raster-saturation', m.sat[1]);
  map.setPaintProperty('water', 'fill-opacity', m.water);
  map.setPaintProperty('roads-glow', 'line-opacity', m.roads * 0.55);
  map.setPaintProperty('roads-core', 'line-opacity', m.roads * 0.8);
  map.setPaintProperty('roofs', 'fill-extrusion-color', ['case', ['>=', ['get', 'render_height'], 60], m.roof[1], m.roof[0]]);
  map.setPaintProperty('buildings', 'fill-extrusion-pattern', ['case', ['>=', ['get', 'render_height'], 60], `tall-${name}`, `low-${name}`]);
}

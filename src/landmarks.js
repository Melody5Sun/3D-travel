import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';

// Hand-built landmark models, drawn by three.js inside MapLibre's WebGL context.
// Each city is its own scene group with a local origin (keeps float32 precise); only the city near the camera is drawn.
// Scene units are metres: +X east, +Y up, +Z south.
const DEG = Math.PI / 180;
const toLocal = ([lng, lat], [lng0, lat0]) => [
  (lng - lng0) * 111320 * Math.cos(lat0 * DEG),
  -(lat - lat0) * 110574,
];

// Positions are the centres of the OSM footprints. `hide`: radius (m) of OSM buildings the model replaces.
const LANDMARKS = [
  { city: 'shanghai', ll: [121.49527, 31.2419], hide: 72, build: pearl },
  { city: 'shanghai', ll: [121.5013, 31.23558], hide: 58, build: shanghaiTower },
  { city: 'shanghai', ll: [121.50304, 31.23658], hide: 44, build: swfc },
  { city: 'shanghai', ll: [121.50141, 31.23725], hide: 50, build: jinmao },
  { city: 'beijing', ll: [116.40662, 39.88225], hide: 18, build: qinianDian },
  { city: 'beijing', ll: [116.46014, 39.91157], hide: 30, build: citicTower },
  { city: 'hangzhou', ll: [120.145, 30.23386], hide: 26, build: leifeng },
  { city: 'guangzhou', ll: [113.31914, 23.10901], hide: 40, build: cantonTower },
  { city: 'hongkong', ll: [114.16155, 22.27929], hide: 30, build: bocTower },
  { city: 'hongkong', ll: [114.16023, 22.30338], hide: 30, build: icc }, // OSM only maps its 110 m base wedges as 3D parts
  { city: 'tokyo', ll: [139.74545, 35.65859], hide: 60, build: tokyoTower },
  { city: 'tokyo', ll: [139.81071, 35.71005], hide: 40, build: skytree },
  { city: 'newyork', ll: [-74.01319, 40.713], hide: 30, build: oneWtc },
  { city: 'newyork', ll: [-73.98566, 40.74843], hide: 30, build: empireState },
  { city: 'paris', ll: [2.29451, 48.85826], hide: 70, build: eiffel },
];

export const hideLandmarkBuildings = ['all', ...LANDMARKS.map(l =>
  ['>', ['distance', { type: 'Point', coordinates: l.ll }], l.hide])];

// Lighting per time of day; the layer eases towards these values.
const MODES = {
  day: { sun: 2.6, sunColor: 0xfff1dc, sunDir: [-0.45, 0.8, 0.4], hemi: 1.1, env: 1.0, glow: 0 },
  dusk: { sun: 1.7, sunColor: 0xff9050, sunDir: [-0.9, 0.3, 0.1], hemi: 0.6, env: 0.65, glow: 0.45 },
  night: { sun: 0.25, sunColor: 0x8aa0ff, sunDir: [0.3, 0.9, 0.2], hemi: 0.22, env: 0.28, glow: 1 },
};

export function landmarksLayer() {
  let map, renderer, scene, camera, sun, hemi, env, materials, cities, glows = [];
  const cur = { ...MODES.day }, target = { ...MODES.day };

  return {
    id: 'landmarks', type: 'custom', renderingMode: '3d',

    setMode(name) { Object.assign(target, MODES[name]); map?.triggerRepaint(); },

    onAdd(m, gl) {
      map = m;
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera();
      sun = new THREE.DirectionalLight(0xffffff, 2);
      hemi = new THREE.HemisphereLight(0xcfe2ff, 0x4a4036, 1);
      scene.add(sun, sun.target, hemi);
      materials = makeMaterials();
      cities = [...new Set(LANDMARKS.map(l => l.city))].map(city => {
        const list = LANDMARKS.filter(l => l.city === city), origin = list[0].ll, group = new THREE.Group();
        const models = list.map(l => {
          const g = l.build(materials, glows);
          const [x, z] = toLocal(l.ll, origin);
          g.position.set(x, 0, z);
          group.add(g);
          return { g, ll: l.ll };
        });
        scene.add(group);
        const mc = MercatorCoordinate.fromLngLat(origin, 0), s = mc.meterInMercatorCoordinateUnits();
        // Y-up metres -> mercator (x east, y south, z up)
        const matrix = new THREE.Matrix4().makeTranslation(mc.x, mc.y, mc.z)
          .scale(new THREE.Vector3(s, -s, s))
          .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        return { origin, group, models, matrix };
      });
      scene.traverse(o => { o.frustumCulled = false; });
    },

    render(gl, args) {
      if (map.getZoom() < 12.5) return; // far away (or still on the globe): nothing to see
      const c = map.getCenter();
      const near = cities.find(k => Math.hypot((c.lng - k.origin[0]) * Math.cos(c.lat * DEG), c.lat - k.origin[1]) < 0.3);
      for (const k of cities) k.group.visible = k === near;
      if (!near) return;
      if (!env) env = makeEnvironment(renderer, materials); // lazily: PMREM needs a render pass
      const terrain = map.getTerrain();
      for (const { g, ll } of near.models) g.position.y = (terrain && map.queryTerrainElevation(ll)) || 0;

      // Ease lighting towards the target mode.
      let moving = false;
      for (const k of ['sun', 'hemi', 'env', 'glow']) {
        const d = target[k] - cur[k];
        if (Math.abs(d) > 0.002) { cur[k] += d * 0.04; moving = true; } else cur[k] = target[k];
      }
      sun.color.lerp(new THREE.Color(target.sunColor), 0.04);
      cur.sunDir = cur.sunDir.map((v, i) => v + (target.sunDir[i] - v) * 0.04);
      sun.intensity = cur.sun;
      sun.position.set(...cur.sunDir);
      hemi.intensity = cur.hemi;
      for (const m of materials.lit) { m.envMapIntensity = cur.env; m.emissiveIntensity = cur.glow; }
      for (const m of glows) m.uniforms.intensity.value = cur.glow;
      for (const m of glows) m.visible = cur.glow > 0.01;

      // three.js needs the camera position for correct specular/reflections, so split MapLibre's
      // view-projection into (projection · translate(camera)) and a translation-only view.
      const pm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix).multiply(near.matrix);
      const eye = new THREE.Vector4(0, 0, 1, 0).applyMatrix4(pm.clone().invert());
      camera.position.set(eye.x / eye.w, eye.y / eye.w, eye.z / eye.w);
      camera.updateMatrixWorld(true);
      camera.projectionMatrix.copy(pm).multiply(camera.matrixWorld);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      renderer.resetState();
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.render(scene, camera);
      if (moving) map.triggerRepaint();
    },
  };
}

// ---------- materials ----------

const texture = (c, srgb = true) => {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};

// Window grid for glass towers. `band`: ribbon windows between spandrels. At night whole runs of a floor light up
// together (offices), and some floors stay dark, instead of uniform salt-and-pepper.
function facadeTextures({ cols, rows, lit, warm, seed, frame = '#d5dbe0', band = false, pane = [0.82, 0.94, 1.08] }) {
  const W = 512, H = 1024, cw = W / cols, ch = H / rows;
  const day = document.createElement('canvas'), night = document.createElement('canvas');
  day.width = night.width = W; day.height = night.height = H;
  const d = day.getContext('2d'), n = night.getContext('2d');
  d.fillStyle = frame; d.fillRect(0, 0, W, H); // mullions / spandrels
  n.fillStyle = '#000'; n.fillRect(0, 0, W, H);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let r = 0; r < rows; r++) {
    const floorOn = rnd() < 0.6 ? Math.min(0.95, lit * (0.8 + rnd() * 1.4)) : lit * 0.1;
    const tone = 150 + rnd() * 40; // reflections vary floor by floor
    let on = rnd() < floorOn, cool = rnd() > warm;
    for (let c = 0; c < cols; c++) {
      if (rnd() < 0.22) { on = rnd() < floorOn; cool = rnd() > warm; }
      const x = c * cw + (band ? 0.6 : 1.5), w = cw - (band ? 1.2 : 3);
      const y = r * ch + (band ? ch * 0.3 : 2), h = band ? ch * 0.62 : ch - 4;
      const g = tone + rnd() * (band ? 8 : 40);
      d.fillStyle = `rgb(${g * pane[0]},${g * pane[1]},${Math.min(255, g * pane[2])})`;
      d.fillRect(x, y, w, h);
      if (on) {
        const k = 0.45 + rnd() * 0.35;
        n.fillStyle = cool ? `rgba(205,225,255,${k})` : `rgba(255,${196 + rnd() * 30},${130 + rnd() * 40},${k})`;
        n.fillRect(x, y, w, h);
      }
    }
  }
  return { map: texture(day), emissiveMap: texture(night) };
}

// Steel lattice as an alpha mask: frame + X bracing per cell.
function latticeMask(cells = 1) {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.strokeStyle = '#fff';
  g.lineWidth = 14; g.strokeRect(0, 0, S, S);
  g.lineWidth = 7;
  for (let i = 0; i < cells; i++) {
    const y0 = i * S / cells, y1 = y0 + S / cells;
    g.beginPath(); g.moveTo(0, y0); g.lineTo(S, y1); g.moveTo(S, y0); g.lineTo(0, y1); g.stroke();
  }
  g.lineWidth = 4; g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
  return texture(c, false);
}

function makeMaterials() {
  const lit = [];
  const std = p => { const m = new THREE.MeshStandardMaterial(p); lit.push(m); return m; };
  // Glass tower. [u, v] = how many texture tiles per texture-coordinate unit.
  const glass = (color, opts, [u, v], extra) => {
    const m = std({ color, metalness: 0.85, roughness: 0.18, emissive: 0xffffff, emissiveIntensity: 0, ...facadeTextures(opts), ...extra });
    m.map.repeat.set(u, v);
    m.emissiveMap.repeat.set(u, v);
    return m;
  };
  // Open steel lattice: alpha-tested so the structure behind shows through.
  const lattice = (color, emissive, [u, v], cells = 1, extra) => {
    const alphaMap = latticeMask(cells);
    alphaMap.repeat.set(u, v);
    return std({ color, emissive, emissiveIntensity: 0, alphaMap, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.45, flatShading: true, ...extra });
  };
  const M = {
    std, glass, lattice, lit,
    concrete: std({ color: 0xd9d4cc, roughness: 0.75, metalness: 0.05 }),
    metal: std({ color: 0xc7ccd2, roughness: 0.35, metalness: 0.9 }),
    pearl: std({ color: 0xc2336a, roughness: 0.22, metalness: 0.55, emissive: 0xff2d7c, emissiveIntensity: 0 }),
    pearlRing: std({ color: 0xe8e2e6, roughness: 0.3, metalness: 0.8, emissive: 0xb6a0ff, emissiveIntensity: 0 }),
    // One texture = 48 floors of ~4.4 m; columns ~2 m wide.
    shtower: glass(0xb4d0dc, { cols: 24, rows: 48, lit: 0.26, warm: 0.35, seed: 7, band: true, frame: '#c9d3da' }, [6, 1 / 211]),
    swfc: glass(0xbccfdd, { cols: 28, rows: 48, lit: 0.24, warm: 0.5, seed: 11 }, [4, 1 / 211]),
    jinmao: glass(0xc9c6bd, { cols: 20, rows: 48, lit: 0.32, warm: 0.85, seed: 23 }, [5, 1 / 202]),
    trim: std({ color: 0xdcdcd8, roughness: 0.3, metalness: 0.9, emissive: 0xffb54a, emissiveIntensity: 0 }),
    led: std({ color: 0xdfefff, roughness: 0.4, metalness: 0.2, emissive: 0x8fd8ff, emissiveIntensity: 0 }),
    gold: std({ color: 0xe0b24a, roughness: 0.25, metalness: 1, emissive: 0xffc35a, emissiveIntensity: 0 }),
  };
  return M;
}

// Soft sky gradient, prefiltered for PBR reflections.
function makeEnvironment(renderer, materials) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: `varying vec3 p; void main(){
      float h = normalize(p).y;
      vec3 sky = mix(vec3(1.0, 0.86, 0.72), vec3(0.32, 0.52, 0.86), smoothstep(0.0, 0.55, h));
      vec3 ground = mix(vec3(0.22, 0.21, 0.2), vec3(0.5, 0.47, 0.44), smoothstep(-0.4, 0.0, h));
      gl_FragColor = vec4(h > 0.0 ? sky : ground, 1.0); }`,
  })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(s, 0.02).texture;
  pmrem.dispose();
  for (const m of materials.lit) { m.envMap = env; m.needsUpdate = true; }
  return env;
}

// Additive halo around a lit sphere (night only).
function glowSphere(r, color, glows, y) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, intensity: { value: 0 } },
    vertexShader: `varying vec3 n; varying vec3 v; void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.); n = normalize(normalMatrix * normal); v = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 color; uniform float intensity; varying vec3 n; varying vec3 v; void main(){
      float f = pow(max(-dot(n, v), 0.0), 2.5); gl_FragColor = vec4(color * f * intensity * 0.9, 1.0); }`,
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  glows.push(mat);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16), mat);
  mesh.position.y = y;
  return mesh;
}

// ---------- geometry helpers ----------

// Loft a skin through rings. ring(j, u) -> [x, z] or [x, z, y]; ys[j] is the default height of ring j.
function skin(ys, seg, ring, uScale = 1) {
  const pos = [], uv = [], idx = [];
  ys.forEach((y, j) => {
    for (let i = 0; i <= seg; i++) {
      const [x, z, yy = y] = ring(j, (i % seg) / seg);
      pos.push(x, yy, z);
      uv.push(i / seg * uScale, yy);
    }
  });
  const flip = signedArea(Array.from({ length: seg }, (_, i) => ring(0, i / seg))) < 0; // keep faces pointing outwards
  for (let j = 0; j < ys.length - 1; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + seg + 1;
    flip ? idx.push(a, a + 1, b, b, a + 1, b + 1) : idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Flat cap over a ring of [x, z] points at height y (facing up, or down if `down`).
function cap(points, y, down = false) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length, cz = points.reduce((s, p) => s + p[1], 0) / points.length;
  const pos = [cx, y, cz, ...points.flatMap(([x, z]) => [x, y, z])], idx = [];
  const flip = (signedArea(points) < 0) !== down;
  for (let i = 1; i <= points.length; i++) {
    const j = i % points.length + 1;
    flip ? idx.push(0, i, j) : idx.push(0, j, i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Straight walls over a polygon of [x, z] points, flat-shaded, uv in metres (u along the perimeter).
// top: a height, or one height per vertex for sloped roofs.
function prism(poly, y0, top) {
  const tops = typeof top === 'number' ? poly.map(() => top) : top;
  let pts = poly.map((p, i) => [...p, tops[i]]);
  if (signedArea(poly) < 0) pts = pts.reverse();
  const pos = [], uv = [];
  let u = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const v = [[p[0], y0, p[1], u], [p[0], p[2], p[1], u], [q[0], y0, q[1], u + len], [q[0], q[2], q[1], u + len]];
    for (const k of [0, 1, 2, 1, 3, 2]) { pos.push(v[k][0], v[k][1], v[k][2]); uv.push(v[k][3], v[k][1]); }
    u += len;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// > 0 when a ring of [x, z] points runs clockwise seen from above (north up).
const signedArea = pts => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);

// Bearing-based polar point: b in radians clockwise from north.
const polar = (r, b) => [r * Math.sin(b), -r * Math.cos(b)];

// Building axes -> local x/z: p runs along compass bearing `deg`, q along bearing deg + 90.
const axes = deg => {
  const s = Math.sin(deg * DEG), c = Math.cos(deg * DEG);
  return (p, q) => [p * s + q * c, -p * c + q * s];
};
const rect = (P, hp, hq, cp = 0, cq = 0) => [[cp - hp, cq - hq], [cp + hp, cq - hq], [cp + hp, cq + hq], [cp - hp, cq + hq]].map(([p, q]) => P(p, q));
const ngon = (n, r, rot = 0) => Array.from({ length: n }, (_, i) => polar(r, rot + i / n * Math.PI * 2));

// Piecewise-linear lookup in [[x, y], ...].
const table = pts => x => {
  const i = Math.max(1, pts.findIndex(p => p[0] >= x));
  const [x0, y0] = pts[i - 1] ?? pts[0], [x1, y1] = pts[Math.min(i, pts.length - 1)];
  return x1 === x0 ? y0 : y0 + (y1 - y0) * Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
};

function strut(a, b, r, mat, seg = 16) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, A.distanceTo(B), seg), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.sub(A).normalize());
  return m;
}

// Resample a closed polygon to n points evenly spaced along its perimeter (keeps lofts consistent).
function resample(poly, n) {
  const segs = poly.map((p, i) => { const q = poly[(i + 1) % poly.length]; return [p, q, Math.hypot(q[0] - p[0], q[1] - p[1])]; });
  const total = segs.reduce((s, x) => s + x[2], 0), out = [];
  let k = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    const d = i / n * total;
    while (k < segs.length - 1 && acc + segs[k][2] < d) acc += segs[k++][2];
    const [p, q, len] = segs[k], t = len ? (d - acc) / len : 0;
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  return out;
}

// Keep the part of a convex polygon where dot(p, dir) >= c.
function clip(poly, dir, c) {
  const out = [], f = p => p[0] * dir[0] + p[1] * dir[1] - c;
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length], fp = f(p), fq = f(q);
    if (fp >= 0) out.push(p);
    if (fp * fq < 0) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  });
  return out;
}

const mesh = (g, geo, mat, y = 0, [x, z] = [0, 0]) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); g.add(o); return o; };

// ---------- Shanghai ----------

// 东方明珠 468 m: three columns, three raking legs, 11 spheres, mast.
function pearl(M, glows) {
  const g = new THREE.Group();
  const add = (geo, mat, y = 0, x = 0, z = 0) => mesh(g, geo, mat, y, [x, z]);
  add(new THREE.CylinderGeometry(44, 50, 12, 48), M.concrete, 6);
  for (let k = 0; k < 3; k++) {
    const [x, z] = polar(8, k * 2.0944);
    add(new THREE.CylinderGeometry(4.5, 4.5, 296, 24), M.concrete, 148, x, z);
    const [lx, lz] = polar(52, (k + 0.5) * 2.0944), [tx, tz] = polar(11, (k + 0.5) * 2.0944);
    g.add(strut([lx, 0, lz], [tx, 76, tz], 3.6, M.concrete));
    const [bx, bz] = polar(40, (k + 0.5) * 2.0944); // small base spheres between the legs
    add(new THREE.SphereGeometry(7, 24, 16), M.pearl, 10, bx, bz);
  }
  const sphere = (r, y) => {
    add(new THREE.SphereGeometry(r, 64, 40), M.pearl, y);
    for (const dy of [-0.35, 0, 0.35]) { // bright bands
      const rr = Math.sqrt(r * r - (dy * r) ** 2) + 0.4;
      add(new THREE.CylinderGeometry(rr, rr, 1.4, 64, 1, true), M.pearlRing, y + dy * r);
    }
    g.add(glowSphere(r * 1.9, 0xff3d8c, glows, y));
  };
  sphere(25, 93);
  sphere(22.5, 272);
  for (let i = 0; i < 5; i++) add(new THREE.SphereGeometry(6.5, 32, 20), M.pearl, 136 + i * 23);
  add(new THREE.CylinderGeometry(5.2, 6.5, 48, 24), M.concrete, 318);
  add(new THREE.SphereGeometry(8, 40, 24), M.pearl, 344);
  g.add(glowSphere(15, 0xff5fa2, glows, 344));
  add(new THREE.CylinderGeometry(0.7, 3.4, 118, 16), M.metal, 351 + 59);
  for (let i = 0; i < 6; i++) add(new THREE.CylinderGeometry(3.6 - i * 0.45, 3.6 - i * 0.45, 1.5, 16), M.pearlRing, 362 + i * 17);
  return g;
}

// 上海中心大厦 632 m: rounded triangle twisting 120°, tapering, with a notch and a sloped crown.
function shanghaiTower(M) {
  const g = new THREE.Group();
  const H = 580, L = 90, SEG = 144, twist = Math.PI * 2 / 3, notch0 = 240 * DEG;
  const radius = (t, a) => {
    const th = notch0 + t * twist, R = 46 + (26 - 46) * t;
    const d = Math.atan2(Math.sin(a - th), Math.cos(a - th));
    return R * (1 + 0.12 * Math.cos(3 * (a - th))) * (1 - 0.075 * Math.exp(-((d / 0.045) ** 2)));
  };
  const ys = Array.from({ length: L + 1 }, (_, j) => j / L * H);
  // Crown: the facade keeps rising past the roof, highest above the notch.
  const topY = a => H + 52 * (0.5 + 0.5 * Math.cos(a - notch0 - twist));
  const ring = (j, u) => {
    const a = u * Math.PI * 2;
    if (j > L) return [...polar(radius(1, a), a), topY(a)];
    return polar(radius(j / L, a), a);
  };
  g.add(new THREE.Mesh(skin(ys, SEG, ring), M.shtower));
  const crown = new THREE.Mesh(skin([H, H], SEG, (j, u) => ring(L + j, u)), M.shtower.clone());
  crown.material.side = THREE.DoubleSide;
  M.lit.push(crown.material);
  g.add(crown);
  // Crown light: a glowing rim along the sloped top edge.
  const rim = Array.from({ length: 97 }, (_, i) => { const a = i / 96 * Math.PI * 2, [x, z] = polar(radius(1, a) + 0.4, a); return new THREE.Vector3(x, topY(a), z); });
  g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rim, true), 192, 0.9, 6, true), M.led));
  const roof = Array.from({ length: SEG }, (_, i) => polar(radius(1, i / SEG * Math.PI * 2) * 0.97, i / SEG * Math.PI * 2));
  g.add(new THREE.Mesh(cap(roof, H - 4), M.metal));
  // Refuge-floor bands every zone.
  for (let z = 1; z <= 8; z++) {
    const y0 = z / 9 * H;
    g.add(new THREE.Mesh(skin([y0 - 1.6, y0 + 1.6], SEG, (_, u) => polar(radius(y0 / H, u * Math.PI * 2) * 1.012, u * Math.PI * 2)), M.trim));
  }
  // LED strip up the notch.
  const pts = Array.from({ length: 60 }, (_, i) => {
    const t = i / 59, a = notch0 + t * twist, [x, z] = polar(radius(t, a) + 0.8, a);
    return new THREE.Vector3(x, t * H, z);
  });
  g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 120, 1.1, 6), M.led));
  // Podium: follows the rounded-triangle plan of the tower base.
  const base = Array.from({ length: SEG }, (_, i) => { const a = i / SEG * Math.PI * 2; return polar(radius(0, a) * 1.28, a); });
  const podium = new THREE.Mesh(skin([0, 36], SEG, (_, u) => base[Math.round(u * SEG) % SEG]), M.shtower);
  g.add(podium);
  g.add(new THREE.Mesh(cap(base, 36), M.concrete));
  return g;
}

// 上海环球金融中心 492 m: square base sliced by two sloping faces down to a blade, with the trapezoid "bottle opener".
function swfc(M) {
  const g = new THREE.Group();
  const H = 492, rot = -5.4 * DEG; // footprint is rotated 5.4° anticlockwise
  const P = (p, q) => { // building axes -> local x/z
    const x = p * Math.cos(rot) - q * Math.sin(rot), y = p * Math.sin(rot) + q * Math.cos(rot);
    return [x, -y];
  };
  // Section at height t: square (half size h) clipped to a band of half-width c/√2 around the SW–NE diagonal.
  const section = t => {
    const h = 29 * (1 - 0.28 * t), c = 2 * h * Math.pow(1 - t, 0.8) + 0.8;
    let poly = [[-h, -h], [h, -h], [h, h], [-h, h]];
    poly = clip(poly, [-Math.SQRT1_2, Math.SQRT1_2], -c / Math.SQRT2);
    return clip(poly, [Math.SQRT1_2, -Math.SQRT1_2], -c / Math.SQRT2);
  };
  const N = 120;
  const loft = (t0, t1, steps, part = x => x) => {
    const ts = Array.from({ length: steps + 1 }, (_, i) => t0 + (t1 - t0) * i / steps);
    const rings = ts.map(t => resample(part(section(t), t), N).map(([p, q]) => P(p, q)));
    g.add(new THREE.Mesh(skin(ts.map(t => t * H), N, (j, u) => rings[j][Math.round(u * N) % N]), M.swfc));
    g.add(new THREE.Mesh(cap(rings[0], t0 * H, true), M.swfc));
    g.add(new THREE.Mesh(cap(rings[steps], t1 * H), M.swfc));
    return rings;
  };
  const tA = 0.9, tB = 0.965; // the aperture spans these heights
  const gap = t => 9 + 16 * (t - tA) / (tB - tA); // half-width along the diagonal; widens towards the top
  const d = [Math.SQRT1_2, Math.SQRT1_2];
  loft(0, tA, 40);
  loft(tA, tB, 6, (poly, t) => clip(poly, d, gap(t)));
  loft(tA, tB, 6, (poly, t) => clip(poly, [-d[0], -d[1]], gap(t)));
  loft(tB, 1, 3);
  // Outline lights around the trapezoid aperture, on both faces (s: along the diagonal, side: which facade).
  for (const side of [-1, 1]) {
    const pt = (s, t) => {
      const c = 2 * 29 * (1 - 0.28 * t) * Math.pow(1 - t, 0.8) + 0.8, [x, z] = P((s * Math.SQRT2 - side * c) / 2, (s * Math.SQRT2 + side * c) / 2);
      return [x, t * H, z];
    };
    const loop = [pt(gap(tA), tA), pt(gap(tB), tB), pt(-gap(tB), tB), pt(-gap(tA), tA)];
    loop.forEach((p, i) => g.add(strut(p, loop[(i + 1) % 4], 0.8, M.led, 6)));
  }
  const podium = new THREE.Mesh(new THREE.BoxGeometry(70, 20, 70), M.concrete);
  podium.position.y = 10;
  podium.rotation.y = rot;
  g.add(podium);
  return g;
}

// 金茂大厦 420.5 m: sixteen tiers shrinking pagoda-like, stepped crown and spire.
function jinmao(M) {
  const g = new THREE.Group();
  const plan = a => { const c = a * 0.32; return [[a, -a + c], [a, a - c], [a - c, a], [-a + c, a], [-a, a - c], [-a, -a + c], [-a + c, -a], [a - c, -a]]; };
  const tier = (a, y0, y1, mat) => {
    const ring = resample(plan(a), 64);
    g.add(new THREE.Mesh(skin([y0, y1], 64, (_, u) => ring[Math.round(u * 64) % 64]), mat));
    g.add(new THREE.Mesh(cap(ring, y1), mat));
  };
  let y = 0, a = 27, h = 46.8;
  for (let k = 0; k < 16; k++) {
    tier(a, y, y + h, M.jinmao);
    tier(a + 1.3, y + h - 1.2, y + h + 0.6, M.trim); // eave / setback trim
    y += h; h *= 0.875; a *= 0.972;
  }
  for (let k = 0; k < 4; k++) { // crown
    tier(a * (0.9 - k * 0.17), y, y + 9, k % 2 ? M.trim : M.jinmao);
    y += 9;
  }
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 3.2, 420.5 - y, 12), M.gold);
  spire.position.y = y + (420.5 - y) / 2;
  g.add(spire);
  const podium = new THREE.Mesh(new THREE.BoxGeometry(92, 14, 64), M.concrete);
  podium.position.set(6, 7, -4);
  g.add(podium);
  return g;
}

// ---------- Beijing ----------

// 天坛祈年殿 38 m: three-tier marble terrace, round hall with three blue-glazed eaves and a gilded finial.
function qinianDian(M) {
  const g = new THREE.Group();
  // Vermilion columns with gilded lattice doors between them.
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#8e2119'; x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#6a1a14'; x.fillRect(12, 6, 40, 58);
  x.strokeStyle = '#d7a64a'; x.lineWidth = 1.5;
  for (let i = 16; i < 52; i += 6) { x.beginPath(); x.moveTo(i, 8); x.lineTo(i, 60); x.stroke(); }
  for (let j = 10; j < 60; j += 6) { x.beginPath(); x.moveTo(12, j); x.lineTo(52, j); x.stroke(); }
  const doors = texture(c);
  doors.repeat.set(16, 1);
  const red = M.std({ map: doors, roughness: 0.6, emissive: 0xff7a3c, emissiveIntensity: 0 });
  const tile = M.std({ color: 0x1a3f7c, roughness: 0.3, metalness: 0.35, side: THREE.DoubleSide });
  const paint = M.std({ color: 0x2f7564, roughness: 0.6, emissive: 0xffc070, emissiveIntensity: 0 }); // dougong band
  // Marble balustrade: posts and panels.
  const b = document.createElement('canvas');
  b.width = 32; b.height = 16;
  const bx = b.getContext('2d');
  bx.fillStyle = '#9d988d'; bx.fillRect(0, 0, 32, 16);
  bx.fillStyle = '#ece8df'; bx.fillRect(0, 0, 32, 3); bx.fillRect(0, 0, 5, 16); bx.fillRect(9, 5, 19, 8);
  const rail = texture(b);
  rail.repeat.set(180, 1);
  const balustrade = M.std({ map: rail, roughness: 0.8, side: THREE.DoubleSide });
  const marble = M.std({ color: 0xd9d5cb, roughness: 0.85 });
  [[45, 0], [38, 2.2], [31, 4.4]].forEach(([r, y]) => {
    mesh(g, new THREE.CylinderGeometry(r, r + 0.4, 2.2, 96), marble, y + 1.1);
    mesh(g, new THREE.CylinderGeometry(r - 0.3, r - 0.3, 1.1, 96, 1, true), balustrade, y + 2.75);
  });
  // Concave glazed roof from radius r0 (eave) up to r1 over height h.
  const roof = (r0, r1, h, y) => {
    const prof = Array.from({ length: 9 }, (_, i) => { const t = i / 8; return new THREE.Vector2(r0 + (r1 - r0) * Math.sqrt(t), y + h * t); });
    g.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 64), tile));
    mesh(g, new THREE.CylinderGeometry(r0, r0, 0.35, 64, 1, true), M.gold, y); // gilded eave edge
  };
  const body = (r, y0, y1) => {
    mesh(g, new THREE.CylinderGeometry(r, r, y1 - y0 - 1.2, 48), red, (y0 + y1 - 1.2) / 2);
    mesh(g, new THREE.CylinderGeometry(r + 0.3, r + 0.3, 1.2, 48), paint, y1 - 0.6);
  };
  body(12.5, 6.6, 13.5); roof(17, 12.5, 3, 13.5);
  body(10.8, 16.5, 21); roof(14.5, 10.8, 3, 21);
  body(8.6, 24, 28); roof(12, 0.9, 8.4, 28);
  mesh(g, new THREE.SphereGeometry(1.1, 20, 12), M.gold, 36.9);
  mesh(g, new THREE.ConeGeometry(0.5, 1.6, 12), M.gold, 38.3);
  return g;
}

// 中国尊 528 m: rounded square that narrows at the waist and flares at the top, like the ancient "zun" vessel.
function citicTower(M) {
  const g = new THREE.Group(), H = 528, L = 70, SEG = 96;
  const half = table([[0, 39], [0.2, 36], [0.45, 30.5], [0.68, 27.5], [0.86, 30], [1, 34.5]]);
  const mat = M.glass(0xaec3d2, { cols: 32, rows: 48, lit: 0.28, warm: 0.4, seed: 31, band: true, frame: '#bfc9d0' }, [1 / 64, 1 / 211]);
  const ring = t => Array.from({ length: SEG }, (_, i) => {
    const a = i / SEG * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), e = 2 / 7; // superellipse, n = 7
    return [half(t) * Math.sign(c) * Math.abs(c) ** e, half(t) * Math.sign(s) * Math.abs(s) ** e];
  });
  const rings = Array.from({ length: L + 1 }, (_, j) => ring(j / L));
  g.add(new THREE.Mesh(skin(rings.map((_, j) => j / L * H), SEG, (j, u) => rings[j][Math.round(u * SEG) % SEG], 290), mat));
  g.add(new THREE.Mesh(cap(rings[L].map(([x, z]) => [x * 0.96, z * 0.96]), H - 3), M.metal));
  // Crown parapet and the four corner mega-columns.
  g.add(new THREE.Mesh(skin([H - 3, H + 4], SEG, (_, u) => rings[L][Math.round(u * SEG) % SEG].map(v => v * 1.005)), M.trim));
  for (let k = 0; k < 4; k++) {
    const b = (45 + k * 90) * DEG;
    const pts = Array.from({ length: 30 }, (_, i) => {
      const t = i / 29, [x, z] = rings[Math.round(t * L)][Math.round(((b / (Math.PI * 2)) * SEG)) % SEG];
      return new THREE.Vector3(x * 1.01, t * H, z * 1.01);
    });
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 1.6, 6), M.trim));
  }
  return g;
}

// ---------- Hangzhou ----------

// 雷峰塔 71.7 m: octagonal five-storey pagoda on a stone terrace, bronze eaves, spire.
function leifeng(M) {
  const g = new THREE.Group(), o = 22.5 * DEG;
  const wall = M.std({ color: 0xa65a33, roughness: 0.55, metalness: 0.35, emissive: 0xffa040, emissiveIntensity: 0 });
  const bronze = M.std({ color: 0x7a5a38, roughness: 0.35, metalness: 0.85 });
  const stone = M.std({ color: 0xa9a397, roughness: 0.9 });
  const oct = (r, y0, y1, mat) => {
    const p = ngon(8, r, o);
    g.add(new THREE.Mesh(prism(p, y0, y1), mat));
    g.add(new THREE.Mesh(cap(p, y1), mat));
  };
  oct(29, 0, 3, stone);
  oct(23, 3, 8, stone);
  let y = 8;
  [[17, 10.5], [15.5, 9.8], [14, 9.4], [12.5, 9], [11, 8.8]].forEach(([r, h]) => {
    oct(r + 2.6, y, y + 0.7, bronze); // balcony
    oct(r, y, y + h - 1.6, wall);
    // Flared eave: wide, thin, upturned bronze roof with a gilded rim.
    const eave = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r + 6.5, 2.4, 8), bronze);
    eave.position.y = y + h - 0.6;
    eave.rotation.y = o;
    g.add(eave);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r + 6.6, r + 6.6, 0.35, 8, 1, true), M.gold);
    rim.position.y = y + h - 1.8;
    rim.rotation.y = o;
    g.add(rim);
    y += h;
  });
  const top = new THREE.Mesh(new THREE.ConeGeometry(12, 5, 8), bronze);
  top.position.y = y + 2.5;
  top.rotation.y = o;
  g.add(top);
  mesh(g, new THREE.CylinderGeometry(0.5, 0.7, 71.7 - y - 3, 12), M.gold, (71.7 + y + 3) / 2);
  for (let i = 0; i < 7; i++) mesh(g, new THREE.CylinderGeometry(1.8 - i * 0.18, 1.8 - i * 0.18, 0.35, 16), M.gold, y + 6 + i * 1.1); // 相轮
  mesh(g, new THREE.SphereGeometry(0.9, 16, 10), M.gold, 70.2);
  return g;
}

// ---------- Guangzhou ----------

// 广州塔 600 m: hyperboloid lattice between a 80×60 m base ellipse and a 54×41 m top ellipse, core, mast. Rainbow LEDs at night.
function cantonTower(M, glows) {
  const g = new THREE.Group(), H = 454, N = 24, twist = 140 * DEG;
  const ell = (A, B, rot, phi) => { const P = axes(rot); return P(A * Math.cos(phi), B * Math.sin(phi)); };
  const at = (i, t) => {
    const phi = i / N * Math.PI * 2, [x0, z0] = ell(40, 30, 45, phi), [x1, z1] = ell(27, 20.5, 0, phi + twist);
    return [x0 + (x1 - x0) * t, t * H, z0 + (z1 - z0) * t];
  };
  const hue = t => new THREE.Color().setHSL((0.95 - 0.8 * t + 1) % 1, 0.95, 0.5); // rose → violet → blue → cyan → gold
  const steel = t => M.std({ color: 0xe4e8ec, roughness: 0.35, metalness: 0.7, emissive: hue(t), emissiveIntensity: 0 });
  const colMat = M.std({ color: 0xe4e8ec, roughness: 0.35, metalness: 0.7 });
  for (let i = 0; i < N; i++) g.add(strut(at(i, 0), at(i, 1), 1.2, colMat, 8));
  for (let k = 1; k <= 46; k++) {
    const t = k / 46, pts = Array.from({ length: N }, (_, i) => new THREE.Vector3(...at(i, t)));
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, k % 5 ? 0.45 : 0.9, 5, true), steel(t)));
  }
  // Diagonal braces between neighbouring columns.
  const braces = Array.from({ length: 8 }, (_, k) => steel((k + 0.5) / 8));
  for (let i = 0; i < N; i++) for (let k = 0; k < 8; k++) g.add(strut(at(i, k / 8), at((i + 1) % N, (k + 1) / 8), 0.4, braces[k], 5));
  // Elliptical core, enclosed top floors, mast.
  const core = ngon(48, 1).map(([x, z]) => [x * 8.5, z * 7]);
  g.add(new THREE.Mesh(skin([0, H], 48, (_, u) => core[Math.round(u * 48) % 48]), M.concrete));
  const topGlass = M.glass(0x9fb6c8, { cols: 24, rows: 12, lit: 0.6, warm: 0.3, seed: 5, band: true }, [4, 1 / 50]);
  const inner = t => Array.from({ length: N }, (_, i) => { const [x, , z] = at(i, t); return [x * 0.93, z * 0.93]; });
  const t0 = 0.9, sec = [0, 1, 2, 3].map(j => inner(t0 + (1 - t0) * j / 3));
  g.add(new THREE.Mesh(skin([0, 1, 2, 3].map(j => (t0 + (1 - t0) * j / 3) * H), N, (j, u) => sec[j][Math.round(u * N) % N]), topGlass));
  g.add(new THREE.Mesh(cap(sec[3], H), M.metal));
  mesh(g, new THREE.CylinderGeometry(1.2, 5.5, 146, 12), M.metal, H + 73);
  for (let i = 0; i < 8; i++) mesh(g, new THREE.CylinderGeometry(4.6 - i * 0.45, 4.6 - i * 0.45, 1.2, 12), M.led, H + 10 + i * 16);
  g.add(glowSphere(9, 0xff6ad5, glows, 598));
  return g;
}

// ---------- Hong Kong ----------

// 中银大厦 367 m: a square split along its diagonals into four triangular shafts of different heights with sloped tops,
// cross-braced facade (white X frames, lit at night), twin masts.
function bocTower(M) {
  const g = new THREE.Group(), rot = 16, a = 26, P = axes(rot);
  const c = document.createElement('canvas'), n = document.createElement('canvas');
  c.width = c.height = n.width = n.height = 256;
  const d = c.getContext('2d'), e = n.getContext('2d');
  d.fillStyle = '#56697b'; d.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 18) { d.fillStyle = y % 36 ? '#6e8295' : '#4b5d6e'; d.fillRect(0, y, 256, 9); }
  e.fillStyle = '#000'; e.fillRect(0, 0, 256, 256);
  for (const ctx of [d, e]) {
    ctx.strokeStyle = ctx === d ? '#e8ecef' : '#dff1ff';
    ctx.lineWidth = 10;
    ctx.strokeRect(0, 0, 256, 256);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(256, 256); ctx.moveTo(256, 0); ctx.lineTo(0, 256); ctx.stroke();
  }
  const map = texture(c), emissiveMap = texture(n);
  map.repeat.set(1 / 52, 1 / 52); emissiveMap.repeat.set(1 / 52, 1 / 52);
  const mat = M.std({ color: 0xffffff, map, emissiveMap, emissive: 0xffffff, emissiveIntensity: 0, metalness: 0.7, roughness: 0.2, side: THREE.DoubleSide });
  // Quadrant facing compass bearing n (outward normal) rises to h; its roof slopes up from the outer edge towards the centre.
  for (const [nb, h] of [[rot, 110], [rot + 90, 210], [rot + 180, 310], [rot + 270, 160]]) {
    const A = polar(a * Math.SQRT2, (nb - 45) * DEG), B = polar(a * Math.SQRT2, (nb + 45) * DEG), tri = [A, B, [0, 0]];
    const tops = [h - 26, h - 26, h];
    g.add(new THREE.Mesh(prism(tri, 0, tops), mat));
    const roof = new THREE.BufferGeometry();
    roof.setAttribute('position', new THREE.Float32BufferAttribute(tri.flatMap(([x, z], i) => [x, tops[i], z]), 3));
    roof.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 26, 0, 13, 26], 2));
    roof.computeVertexNormals();
    g.add(new THREE.Mesh(roof, mat));
  }
  for (const [x, z] of [P(-15, -3), P(-15, 6)]) mesh(g, new THREE.CylinderGeometry(0.5, 1, 80, 8), M.metal, 327.5, [x, z]);
  g.add(new THREE.Mesh(prism(rect(P, a + 3, a + 3), 0, 12), M.concrete));
  return g;
}

// 环球贸易广场 484 m: square shaft with notched corners, tapering near the top; the facade runs past the roof as a crown.
function icc(M) {
  const g = new THREE.Group(), H = 484, L = 24, SEG = 64, P = axes(42);
  const half = table([[0, 28], [0.8, 27.5], [1, 23]]);
  const mat = M.glass(0x9fb3c4, { cols: 32, rows: 48, lit: 0.3, warm: 0.5, seed: 41, band: true }, [1 / 64, 1 / 211]);
  const rings = Array.from({ length: L + 1 }, (_, j) => {
    const a = half(j / L), n = a * 0.85;
    return resample([[-n, -a], [n, -a], [a, -n], [a, n], [n, a], [-n, a], [-a, n], [-a, -n]].map(([p, q]) => P(p, q)), SEG);
  });
  g.add(new THREE.Mesh(skin(rings.map((_, j) => j / L * H), SEG, (j, u) => rings[j][Math.round(u * SEG) % SEG], 220), mat));
  g.add(new THREE.Mesh(cap(rings[L], H - 10), M.metal));
  return g;
}

// ---------- Tokyo ----------

// Square lattice tower lofted between heights with half-width w(y), p/q axes along `rot`.
// legs: up to this height the tower stands on four separate corner legs of width legW(y).
function latticeTower(g, mat, { rot, w, legs = 0, legW, y0 = 0, y1, step = 4 }) {
  const P = axes(rot), ys = [];
  for (let y = y0; y < y1; y += step) ys.push(y);
  ys.push(y1);
  const square = y => [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([p, q]) => P(p * w(y), q * w(y)));
  const shaftYs = ys.filter(y => y >= legs);
  if (legs > y0) {
    const legYs = ys.filter(y => y <= legs).concat(ys.find(y => y > legs) ?? []);
    for (const [sp, sq] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const ring = (j, u) => {
        const y = legYs[j], W = w(y), l = Math.min(W, legW(y));
        const c = [[W, W], [W - l, W], [W - l, W - l], [W, W - l]][Math.round(u * 4) % 4];
        return P(sp * c[0], sq * c[1]);
      };
      g.add(new THREE.Mesh(skin(legYs, 4, ring, 4), mat));
    }
  }
  if (shaftYs.length > 1) g.add(new THREE.Mesh(skin(shaftYs, 4, (j, u) => square(shaftYs[j])[Math.round(u * 4) % 4], 4), mat));
  return P;
}

// 東京タワー 333 m: orange-and-white lattice, main deck at 150 m, top deck at 250 m. Warm "landmark light" at night.
function tokyoTower(M) {
  const g = new THREE.Group(), rot = 33.8;
  const c = document.createElement('canvas');
  c.width = 4; c.height = 512;
  const x = c.getContext('2d');
  for (let py = 0; py < 512; py++) {
    const y = 333 * (1 - py / 512), band = y < 115 ? 0 : Math.floor((y - 115) / 22) % 2;
    x.fillStyle = band ? '#f3efe6' : '#ff4f12';
    x.fillRect(0, py, 4, 1);
  }
  const map = texture(c);
  map.repeat.set(1, 1 / 333);
  const mat = M.lattice(0xffffff, 0xff7a2a, [3, 1 / 9], 1, { map, metalness: 0.3, roughness: 0.55 });
  const w = y => 2.2 + 39 * Math.exp(-y / 78);
  const P = latticeTower(g, mat, { rot, w, legs: 62, legW: y => 13 + y * 0.05, y1: 250 });
  latticeTower(g, mat, { rot, w: y => 3.2 - (y - 250) * 0.022, y0: 250, y1: 311 });
  mesh(g, new THREE.CylinderGeometry(0.4, 1.3, 22, 8), M.metal, 322);
  // Main deck (two storeys) and top deck.
  const deck = M.glass(0xb8c4cc, { cols: 16, rows: 8, lit: 0.9, warm: 0.9, seed: 3, band: true }, [1 / 32, 1 / 34]);
  g.add(new THREE.Mesh(prism(rect(P, 14.5, 14.5), 120, 150), deck));
  g.add(new THREE.Mesh(cap(rect(P, 14.5, 14.5), 150), M.concrete));
  g.add(new THREE.Mesh(prism(rect(P, 15.3, 15.3), 134, 136), M.trim));
  g.add(new THREE.Mesh(prism(rect(P, 6.3, 6.3), 223, 251), deck));
  g.add(new THREE.Mesh(cap(rect(P, 6.3, 6.3), 251), M.concrete));
  return g;
}

// 東京スカイツリー 634 m: lattice whose plan morphs from a triangle at the base to a circle, two observation decks, antenna.
function skytree(M) {
  const g = new THREE.Group(), SEG = 48, a0 = 0;
  const R = table([[0, 39], [80, 31], [200, 23.5], [300, 19.5], [400, 16], [495, 12]]);
  const radius = (y, a) => {
    const f = ((a - a0) % (Math.PI * 2 / 3) + Math.PI * 2) % (Math.PI * 2 / 3) - Math.PI / 3; // angle from the nearest vertex
    const tri = R(y) * 0.5 / Math.cos(f), k = Math.min(1, y / 330) ** 0.8;
    return tri * (1 - k) + R(y) * 0.74 * k;
  };
  const mat = M.lattice(0xe9eef2, 0x7fc4ff, [36, 1 / 9], 1, { metalness: 0.5, roughness: 0.4 });
  const ys = Array.from({ length: 100 }, (_, j) => j * 5);
  g.add(new THREE.Mesh(skin(ys, SEG, (j, u) => polar(radius(ys[j], u * Math.PI * 2), u * Math.PI * 2)), mat));
  mesh(g, new THREE.CylinderGeometry(6, 8, 495, 24), M.concrete, 247.5);
  const deck = M.glass(0xaec2cf, { cols: 32, rows: 8, lit: 0.9, warm: 0.2, seed: 9, band: true }, [4, 1 / 16]);
  mesh(g, new THREE.CylinderGeometry(17.5, 16, 15, 48), deck, 347.5);
  mesh(g, new THREE.CylinderGeometry(18, 18, 1.2, 48, 1, true), M.led, 340);
  mesh(g, new THREE.CylinderGeometry(13.5, 12.5, 8, 48), deck, 449);
  mesh(g, new THREE.CylinderGeometry(14, 14, 1, 48, 1, true), M.led, 445);
  const gain = M.lattice(0xe9eef2, 0x7fc4ff, [16, 1 / 6], 1);
  g.add(new THREE.Mesh(skin([495, 625], 24, (j, u) => polar(j ? 3.4 : 5.2, u * Math.PI * 2)), gain));
  mesh(g, new THREE.CylinderGeometry(0.6, 2, 9, 12), M.metal, 629.5);
  return g;
}

// ---------- New York ----------

// One World Trade Center 541 m: cubic podium, then eight tall isosceles triangles taper the square into a 45°-rotated square.
function oneWtc(M, glows) {
  const g = new THREE.Group(), P = axes(27.4), R = 32;
  const mat = M.glass(0x9fb8cc, { cols: 40, rows: 48, lit: 0.22, warm: 0.3, seed: 17, band: true, frame: '#a9b6c0' }, [1 / 60, 1 / 190], { flatShading: true });
  const C = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([p, q]) => P(p * R, q * R));
  const Mid = C.map((p, k) => { const q = C[(k + 1) % 4]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; });
  const podium = M.std({ color: 0xc9d0d6, roughness: 0.3, metalness: 0.85 });
  g.add(new THREE.Mesh(prism(C, 0, 57), podium));
  // Each base corner splits into two vertices that slide up to the two neighbouring top vertices.
  const ring = (j, u) => { const i = Math.round(u * 8) % 8, k = i >> 1; return j ? (i % 2 ? Mid[k] : Mid[(k + 3) % 4]) : C[k]; };
  g.add(new THREE.Mesh(skin([57, 417], 8, ring, 240), mat));
  g.add(new THREE.Mesh(cap(Mid, 417), M.metal));
  g.add(new THREE.Mesh(prism(Mid.map(([x, z]) => [x * 1.01, z * 1.01]), 414, 421), M.trim));
  mesh(g, new THREE.CylinderGeometry(9, 11, 8, 24), M.metal, 425);
  mesh(g, new THREE.CylinderGeometry(0.5, 1.6, 112, 12), M.led, 485);
  g.add(glowSphere(6, 0xcfe6ff, glows, 540));
  return g;
}

// Empire State Building 443 m: limestone Art Deco setbacks, lit crown, mooring mast and antenna.
function empireState(M, glows) {
  const g = new THREE.Group(), P = axes(118.9);
  const opts = { cols: 24, rows: 48, lit: 0.3, warm: 0.9, seed: 13, frame: '#cfc5b1', pane: [0.42, 0.45, 0.5] };
  const stone = M.glass(0xffffff, opts, [1 / 40, 1 / 180], { metalness: 0.1, roughness: 0.7 });
  const crown = M.glass(0xffffff, { ...opts, lit: 0.8, seed: 19 }, [1 / 40, 1 / 180], { metalness: 0.1, roughness: 0.6, emissive: 0xfff1c4 });
  const tiers = [[0, 25, 64, 28], [25, 75, 47, 23], [75, 90, 36, 24], [90, 115, 31.5, 20], [115, 255, 28, 20.5], [255, 290, 26, 18], [290, 310, 21.5, 14], [310, 320, 20.5, 13], [320, 330, 17.5, 10]];
  for (const [y0, y1, hp, hq] of tiers) {
    const r = rect(P, hp, hq);
    g.add(new THREE.Mesh(prism(r, y0, y1), y0 >= 255 ? crown : stone));
    g.add(new THREE.Mesh(cap(r, y1), M.concrete));
  }
  const mastMat = M.std({ color: 0xd8d4c8, roughness: 0.35, metalness: 0.6, emissive: 0xfff1c4, emissiveIntensity: 0, flatShading: true });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 7.2, 60, 8), mastMat);
  mast.position.y = 360;
  mast.rotation.y = 22.5 * DEG;
  g.add(mast);
  mesh(g, new THREE.CylinderGeometry(0.3, 2, 53, 8), M.metal, 416.5);
  g.add(glowSphere(4, 0xff5a5a, glows, 443));
  return g;
}

// ---------- Paris ----------

// Tour Eiffel 330 m: four curved lattice legs joined by the arches and platforms at 57 m and 116 m, third floor at 276 m.
function eiffel(M, glows) {
  const g = new THREE.Group(), rot = 44.4;
  const mat = M.lattice(0x7a5f45, 0xffb04a, [2, 1 / 7], 1, { metalness: 0.45, roughness: 0.55 });
  const solid = M.std({ color: 0x6d5540, roughness: 0.6, metalness: 0.4, emissive: 0xffb04a, emissiveIntensity: 0 });
  const w = y => 3 + 59 * Math.exp(-y / 85);
  const P = latticeTower(g, mat, { rot, w, legs: 276, legW: y => w(y) * (0.4 + 0.3 * Math.min(1, y / 276)), y1: 276, step: 3 });
  latticeTower(g, mat, { rot, w: y => 4.6 - (y - 276) * 0.1, y0: 276, y1: 300 });
  const slab = (h, y0, y1, mat2 = solid) => {
    const r = rect(P, h, h);
    g.add(new THREE.Mesh(prism(r, y0, y1), mat2));
    g.add(new THREE.Mesh(cap(r, y1), mat2));
    g.add(new THREE.Mesh(cap(r, y0, true), mat2));
  };
  slab(35.5, 50, 57.6);
  slab(21, 112, 116);
  slab(13, 116, 122, mat);
  slab(9.3, 273, 285);
  // The decorative arches between the legs under the first platform.
  for (let k = 0; k < 4; k++) {
    const b = (rot + 90 * k) * DEG, arch = new THREE.Mesh(new THREE.TorusGeometry(31, 1.4, 8, 48, Math.PI), solid);
    const [x, z] = polar(41, b + Math.PI / 2);
    arch.position.set(x, 19, z);
    arch.rotation.y = Math.PI / 2 - b;
    g.add(arch);
  }
  mesh(g, new THREE.CylinderGeometry(0.5, 1.4, 30, 8), M.metal, 315);
  g.add(glowSphere(7, 0xffd28a, glows, 302));
  return g;
}

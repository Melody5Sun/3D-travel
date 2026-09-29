import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';

// Hand-built models of Lujiazui's skyline, drawn by three.js inside MapLibre's WebGL context.
// Scene units are metres: +X east, +Y up, +Z south, origin at ORIGIN.
const ORIGIN = [121.499, 31.238];
const toLocal = ([lng, lat]) => [
  (lng - ORIGIN[0]) * 111320 * Math.cos(ORIGIN[1] * Math.PI / 180),
  -(lat - ORIGIN[1]) * 110574,
];

// Positions are the centres of the OSM footprints. `hide`: radius (m) of OSM buildings the model replaces.
const LANDMARKS = [
  { id: 'pearl', ll: [121.49527, 31.2419], hide: 72, build: pearl },
  { id: 'shtower', ll: [121.5013, 31.23558], hide: 58, build: shanghaiTower },
  { id: 'swfc', ll: [121.50304, 31.23658], hide: 44, build: swfc },
  { id: 'jinmao', ll: [121.50141, 31.23725], hide: 50, build: jinmao },
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
  let map, renderer, scene, camera, sun, hemi, env, materials, glows = [];
  const cur = { ...MODES.day }, target = { ...MODES.day };
  const modelMatrix = new THREE.Matrix4();

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
      for (const l of LANDMARKS) {
        const g = l.build(materials, glows);
        const [x, z] = toLocal(l.ll);
        g.position.set(x, 0, z);
        scene.add(g);
      }
      scene.traverse(o => { o.frustumCulled = false; });
      const mc = MercatorCoordinate.fromLngLat(ORIGIN, 0), s = mc.meterInMercatorCoordinateUnits();
      // Y-up metres -> mercator (x east, y south, z up)
      modelMatrix.makeTranslation(mc.x, mc.y, mc.z)
        .scale(new THREE.Vector3(s, -s, s))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    },

    render(gl, args) {
      if (map.getZoom() < 12.5) return; // far away (or still on the globe): nothing to see
      if (!env) env = makeEnvironment(renderer, materials); // lazily: PMREM needs a render pass

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
      const pm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix).multiply(modelMatrix);
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

function facadeTextures({ cols, rows, lit, warm, seed }) {
  const W = 512, H = 1024, cw = W / cols, ch = H / rows;
  const day = document.createElement('canvas'), night = document.createElement('canvas');
  day.width = night.width = W; day.height = night.height = H;
  const d = day.getContext('2d'), n = night.getContext('2d');
  d.fillStyle = '#d5dbe0'; d.fillRect(0, 0, W, H); // mullions
  n.fillStyle = '#000'; n.fillRect(0, 0, W, H);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let zone = rnd();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (c === 0) zone = Math.min(1, Math.max(0, zone + (rnd() - 0.5) * 0.8)); // lit floors form clusters
    const p = lit * (zone > 0.6 ? 2.6 : zone > 0.3 ? 0.5 : 0.05);
    const x = c * cw + 1.5, y = r * ch + 2, w = cw - 3, h = ch - 4;
    const g = 150 + rnd() * 50;
    d.fillStyle = `rgb(${g * 0.82},${g * 0.94},${Math.min(255, g * 1.08)})`; // glass pane
    d.fillRect(x, y, w, h);
    if (rnd() < p) {
      const k = 0.4 + rnd() * 0.4, cool = rnd() > warm;
      n.fillStyle = cool ? `rgba(200,225,255,${k})` : `rgba(255,${200 + rnd() * 30},${140 + rnd() * 40},${k})`;
      n.fillRect(x, y, w, h);
    }
  }
  const tex = c => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return { map: tex(day), emissiveMap: tex(night) };
}

function makeMaterials() {
  const glass = (color, opts) => new THREE.MeshStandardMaterial({
    color, metalness: 0.85, roughness: 0.18, emissive: 0xffffff, emissiveIntensity: 0, ...facadeTextures(opts),
  });
  const m = {
    concrete: new THREE.MeshStandardMaterial({ color: 0xd9d4cc, roughness: 0.75, metalness: 0.05 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xc7ccd2, roughness: 0.35, metalness: 0.9 }),
    pearl: new THREE.MeshStandardMaterial({ color: 0xc2336a, roughness: 0.22, metalness: 0.55, emissive: 0xff2d7c, emissiveIntensity: 0 }),
    pearlRing: new THREE.MeshStandardMaterial({ color: 0xe8e2e6, roughness: 0.3, metalness: 0.8, emissive: 0xb6a0ff, emissiveIntensity: 0 }),
    shtower: glass(0xb4d0dc, { cols: 24, rows: 48, lit: 0.2, warm: 0.35, seed: 7 }),
    swfc: glass(0xbccfdd, { cols: 28, rows: 48, lit: 0.18, warm: 0.5, seed: 11 }),
    jinmao: glass(0xc9c6bd, { cols: 20, rows: 48, lit: 0.25, warm: 0.85, seed: 23 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xdcdcd8, roughness: 0.3, metalness: 0.9, emissive: 0xffb54a, emissiveIntensity: 0 }),
    led: new THREE.MeshStandardMaterial({ color: 0xdfefff, roughness: 0.4, metalness: 0.2, emissive: 0x8fd8ff, emissiveIntensity: 0 }),
  };
  // One texture = 48 floors of ~4.4 m; columns ~2 m wide.
  for (const [k, u, v] of [['shtower', 6, 1 / 211], ['swfc', 4, 1 / 211], ['jinmao', 5, 1 / 202]]) {
    m[k].map.repeat.set(u, v);
    m[k].emissiveMap.repeat.set(u, v);
  }
  m.lit = [m.pearl, m.pearlRing, m.shtower, m.swfc, m.jinmao, m.trim, m.led, m.concrete, m.metal];
  return m;
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

// > 0 when a ring of [x, z] points runs clockwise seen from above (north up).
const signedArea = pts => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);

// Bearing-based polar point: b in radians clockwise from north.
const polar = (r, b) => [r * Math.sin(b), -r * Math.cos(b)];

function strut(a, b, r, mat) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, A.distanceTo(B), 16), mat);
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

// ---------- models ----------

// 东方明珠 468 m: three columns, three raking legs, 11 spheres, mast.
function pearl(M, glows) {
  const g = new THREE.Group();
  const add = (geo, mat, y = 0, x = 0, z = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); g.add(o); return o; };
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
  const H = 580, L = 90, SEG = 144, twist = Math.PI * 2 / 3, notch0 = 240 * Math.PI / 180;
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
  // Podium
  // Podium: rounded triangle in plan, matching the tower's footprint.
  const pr = a => polar(64 * (1 + 0.1 * Math.cos(3 * (a - notch0))), a);
  g.add(new THREE.Mesh(skin([0, 36], SEG, (_, u) => pr(u * Math.PI * 2)), M.concrete));
  g.add(new THREE.Mesh(cap(Array.from({ length: SEG }, (_, i) => pr(i / SEG * Math.PI * 2)), 36), M.concrete));
  // Crown lights: a glowing rim along the sloped crown edge.
  const rim = Array.from({ length: 72 }, (_, i) => {
    const a = i / 72 * Math.PI * 2, [x, z] = polar(radius(1, a) * 0.99, a);
    return new THREE.Vector3(x, topY(a) + 0.5, z);
  });
  g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rim, true), 144, 0.9, 6, true), M.led));
  return g;
}

// 上海环球金融中心 492 m: square base sliced by two sloping faces down to a blade, with the trapezoid "bottle opener".
function swfc(M) {
  const g = new THREE.Group();
  const H = 492, rot = -5.4 * Math.PI / 180; // footprint is rotated 5.4° anticlockwise
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
    const mesh = new THREE.Mesh(skin(ts.map(t => t * H), N, (j, u) => rings[j][Math.round(u * N) % N]), M.swfc);
    g.add(mesh);
    g.add(new THREE.Mesh(cap(rings[0], t0 * H, true), M.swfc));
    g.add(new THREE.Mesh(cap(rings[steps], t1 * H), M.swfc));
  };
  const tA = 0.9, tB = 0.965; // the aperture spans these heights
  const gap = t => 9 + 16 * (t - tA) / (tB - tA); // half-width along the diagonal; widens towards the top
  const d = [Math.SQRT1_2, Math.SQRT1_2];
  loft(0, tA, 40);
  loft(tA, tB, 6, (poly, t) => clip(poly, d, gap(t)));
  loft(tA, tB, 6, (poly, t) => clip(poly, [-d[0], -d[1]], gap(t)));
  loft(tB, 1, 3);
  // Outline lights round the trapezoid opening, on both faces.
  for (const side of [-1, 1]) {
    const w = t => side * (2 * 29 * (1 - 0.28 * t) * Math.pow(1 - t, 0.8) / Math.SQRT2 + 0.6);
    const v = (t, s) => { const [x, z] = P(s * d[0] - w(t) * d[1], s * d[1] + w(t) * d[0]); return [x, t * H, z]; };
    const c = [v(tA, -gap(tA)), v(tA, gap(tA)), v(tB, gap(tB)), v(tB, -gap(tB))];
    c.forEach((a, i) => g.add(strut(a, c[(i + 1) % 4], 0.9, M.led)));
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
  const prism = (a, y0, y1, mat) => {
    const ring = resample(plan(a), 64);
    g.add(new THREE.Mesh(skin([y0, y1], 64, (_, u) => ring[Math.round(u * 64) % 64]), mat));
    g.add(new THREE.Mesh(cap(ring, y1), mat));
  };
  let y = 0, a = 27, h = 46.8;
  for (let k = 0; k < 16; k++) {
    prism(a, y, y + h, M.jinmao);
    prism(a + 1.3, y + h - 1.2, y + h + 0.6, M.trim); // eave / setback trim
    y += h; h *= 0.875; a *= 0.972;
  }
  for (let k = 0; k < 4; k++) { // crown
    prism(a * (0.9 - k * 0.17), y, y + 9, k % 2 ? M.trim : M.jinmao);
    y += 9;
  }
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 3.2, 420.5 - y, 12), M.metal);
  spire.position.y = y + (420.5 - y) / 2;
  g.add(spire);
  const podium = new THREE.Mesh(new THREE.BoxGeometry(92, 14, 64), M.concrete);
  podium.position.set(6, 7, -4);
  g.add(podium);
  return g;
}

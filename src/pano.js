import * as THREE from 'three';

// 360° equirectangular viewer. Drag / touch to look around, wheel or pinch to zoom, idle = slow auto-rotate.
export function createPano(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
  const sphere = new THREE.SphereGeometry(50, 128, 64).scale(-1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  scene.add(new THREE.Mesh(sphere, material));

  let lon = 0, lat = 0, fov = 75, fovTarget = 75, running = false, lastInput = 0, last = 0;
  const pointers = new Map();
  let pinch = 0;

  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); lastInput = performance.now(); });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) fovTarget = THREE.MathUtils.clamp(fovTarget * pinch / d, 30, 100);
      pinch = d;
    } else {
      const k = fov / canvas.clientHeight; // degrees per pixel, so dragging feels 1:1
      lon -= (e.clientX - p[0]) * k;
      lat = THREE.MathUtils.clamp(lat + (e.clientY - p[1]) * k, -85, 85);
    }
    p[0] = e.clientX; p[1] = e.clientY;
    lastInput = performance.now();
  });
  const up = e => { pointers.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => { e.preventDefault(); fovTarget = THREE.MathUtils.clamp(fovTarget + e.deltaY * 0.03, 30, 100); lastInput = performance.now(); }, { passive: false });

  function frame(t) {
    if (!running) return;
    const dt = Math.min(t - (last || t), 50); last = t;
    if (t - lastInput > 4000) lon += dt * 0.004; // auto-rotate when idle
    fov += (fovTarget - fov) * 0.12;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.fov = fov; camera.updateProjectionMatrix();
    const phi = THREE.MathUtils.degToRad(lon), th = THREE.MathUtils.degToRad(lat);
    camera.lookAt(Math.cos(th) * Math.cos(phi), Math.sin(th), Math.cos(th) * Math.sin(phi));
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  return {
    // yaw: horizontal position (0..1) of the image column to face first.
    async open(url, yaw = 0.5) {
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      material.map?.dispose();
      material.map = tex;
      material.needsUpdate = true;
      lon = yaw * 360; lat = 0; fov = 100; fovTarget = 75; lastInput = performance.now();
      if (!running) { running = true; last = 0; requestAnimationFrame(frame); }
      return tex.image;
    },
    close() {
      running = false;
      material.map?.dispose();
      material.map = null;
    },
  };
}

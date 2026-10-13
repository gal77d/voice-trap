// game.js - צד לקוח: גרפיקה (Three.js), שליטה במגע, חיזוי תנועה וחצי יריה
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ---------- מצב כללי ----------
let ws = null;
let myId = null;
let cfg = null;          // הגדרות מהשרת
let map = null;          // public/map.json
let inGame = false;
let gameOver = false;
const players = new Map(); // id -> { name, color, score, ch, x, z, tx, tz, yaw, alive, fresh }

// המצב של השחקן שלי (חזוי מקומית)
const me = { x: 0, z: 0, prevX: 0, prevZ: 0, yaw: 0, pitch: 0, alive: true };
let seq = 0;
let pending = [];        // קלטים שנשלחו ועדיין לא אושרו ע"י השרת
let respawnAt = 0;
let deathTime = 0;

const SHOOT_INTERVAL = 350;
const ARROW_MS = 3000;
let lastShotTime = 0;
const IS_TOUCH = 'ontouchstart' in window;

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const menu = $('menu'), hud = $('hud'), overEl = $('over');
const joyBase = $('joyBase'), joyKnob = $('joyKnob'), fireBtn = $('fireBtn');
const arrowsEl = $('arrows'), deathMsg = $('deathMsg');

$('nameInput').value = localStorage.getItem('name') || '';

// באייפון אין API למסך מלא בדפדפן - רק "הוספה למסך הבית" פותחת את המשחק בלי סרגלים
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE = navigator.standalone === true || matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
if (IS_IOS && !IS_STANDALONE) $('installHint').classList.remove('hidden');

// ---------- Renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight, false); // הגודל בפועל נקבע ב-CSS
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;
$('game').appendChild(renderer.domElement);
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc8d6e5, 30, 95);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 2000);
camera.rotation.order = 'YXZ';
scene.add(camera);

// שמיים ותאורה
const sky = new Sky();
sky.scale.setScalar(1500);
const su = sky.material.uniforms;
su.turbidity.value = 3.5;
su.rayleigh.value = 2.2;
su.mieCoefficient.value = 0.004;
su.mieDirectionalG.value = 0.8;
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(145));
su.sunPosition.value.copy(sunDir);
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x5e4e3c, 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffeccc, 3.2);
sun.position.copy(sunDir).multiplyScalar(45);
sun.castShadow = true;
sun.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048);
const sc = sun.shadow.camera;
sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 5; sc.far = 110;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun);

// הבזק מהנשק שלי - מאיר את הסביבה לרגע
const flashLight = new THREE.PointLight(0xffb060, 0, 9, 2);
scene.add(flashLight);

// ---------- טקסטורות פרוצדורליות (בלי קבצי תמונה) ----------
function makeCanvas(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d', { willReadFrequently: true }), size);
  return c;
}
function addNoise(g, s, amount) {
  const img = g.getImageData(0, 0, s, s), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}
function blotches(g, s, n, color, maxR, alpha) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = Math.random() * maxR + 4;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, color.replace('A', alpha * Math.random()));
    gr.addColorStop(1, color.replace('A', 0));
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
}
// מפת נורמלים מתוך בהירות התמונה (נותן תחושת עומק לחריצים)
function normalFromCanvas(src, strength, invert) {
  const s = src.width;
  const sd = src.getContext('2d').getImageData(0, 0, s, s).data;
  const h = (x, y) => {
    x = (x + s) % s; y = (y + s) % s;
    const i = (y * s + x) * 4;
    const v = (sd[i] + sd[i + 1] + sd[i + 2]) / 765;
    return invert ? 1 - v : v;
  };
  return makeCanvas(s, (g) => {
    const img = g.createImageData(s, s), d = img.data;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = (h(x - 1, y) - h(x + 1, y)) * strength;
      const dy = (h(x, y - 1) - h(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * s + x) * 4;
      d[i] = (dx / len * 0.5 + 0.5) * 255;
      d[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}
function toTexture(canvas, color = true) {
  const t = new THREE.CanvasTexture(canvas);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = MAX_ANISO;
  return t;
}
function texSet(canvas, strength, invert = false) {
  return { map: toTexture(canvas), normalMap: toTexture(normalFromCanvas(canvas, strength, invert), false) };
}

const TEX = {};
function buildTextures() {
  // בטון עם לוחות (הקיר המרכזי)
  TEX.concrete = texSet(makeCanvas(512, (g, s) => {
    g.fillStyle = '#8f8e8a'; g.fillRect(0, 0, s, s);
    blotches(g, s, 60, 'rgba(60,58,55,A)', 60, 0.25);
    blotches(g, s, 40, 'rgba(200,198,190,A)', 50, 0.2);
    for (let i = 0; i < 25; i++) { // כתמי מים שזולגים
      const x = Math.random() * s, w = Math.random() * 10 + 3;
      const gr = g.createLinearGradient(0, 0, 0, s * (0.3 + Math.random() * 0.6));
      gr.addColorStop(0, 'rgba(50,48,45,0.18)'); gr.addColorStop(1, 'rgba(50,48,45,0)');
      g.fillStyle = gr; g.fillRect(x, 0, w, s);
    }
    addNoise(g, s, 26);
    g.strokeStyle = 'rgba(40,40,40,0.75)'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(0, 2); g.lineTo(s, 2); g.moveTo(2, 0); g.lineTo(2, s); g.stroke();
    g.fillStyle = 'rgba(50,50,50,0.7)';
    for (const [x, y] of [[64, 64], [448, 64], [64, 448], [448, 448]]) { g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); }
  }), 3);
  // לבנים (קירות חיצוניים)
  TEX.brick = texSet(makeCanvas(512, (g, s) => {
    g.fillStyle = '#8f877b'; g.fillRect(0, 0, s, s);
    const rows = 8, bh = s / rows, bw = s / 4;
    for (let r = 0; r < rows; r++) for (let c = -1; c < 5; c++) {
      const x = c * bw + (r % 2 ? bw / 2 : 0), y = r * bh;
      const tone = 105 + Math.random() * 45;
      g.fillStyle = `rgb(${tone + 25},${tone * 0.52},${tone * 0.4})`;
      g.fillRect(x + 4, y + 4, bw - 8, bh - 8);
    }
    blotches(g, s, 40, 'rgba(40,30,25,A)', 40, 0.3);
    addNoise(g, s, 30);
  }), 4, true);
  // רצפה: אספלט/בטון עם משבצות
  TEX.floor = texSet(makeCanvas(512, (g, s) => {
    g.fillStyle = '#6f6d68'; g.fillRect(0, 0, s, s);
    blotches(g, s, 120, 'rgba(40,38,36,A)', 50, 0.3);
    blotches(g, s, 60, 'rgba(150,145,135,A)', 40, 0.25);
    addNoise(g, s, 40);
    g.strokeStyle = 'rgba(30,30,30,0.8)'; g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, s - 3, s - 3);
    for (let i = 0; i < 6; i++) { // סדקים
      g.strokeStyle = 'rgba(25,25,25,0.5)'; g.lineWidth = 1.2;
      let x = Math.random() * s, y = Math.random() * s;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 8; k++) { x += (Math.random() - 0.5) * 40; y += (Math.random() - 0.5) * 40; g.lineTo(x, y); }
      g.stroke();
    }
  }), 2.5);
  // ארגז עץ
  TEX.crate = texSet(makeCanvas(512, (g, s) => {
    g.fillStyle = '#9a6b3c'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 6; i++) { // קרשים
      const y = i * s / 6, tone = Math.random() * 25;
      g.fillStyle = `rgb(${150 + tone},${102 + tone},${58 + tone * 0.6})`;
      g.fillRect(0, y + 3, s, s / 6 - 6);
      for (let k = 0; k < 14; k++) { // סיבי עץ
        g.strokeStyle = 'rgba(80,50,25,0.35)'; g.lineWidth = 1;
        const yy = y + 6 + Math.random() * (s / 6 - 12);
        g.beginPath(); g.moveTo(0, yy);
        g.bezierCurveTo(s * 0.3, yy + (Math.random() - 0.5) * 8, s * 0.6, yy + (Math.random() - 0.5) * 8, s, yy);
        g.stroke();
      }
    }
    g.fillStyle = '#6b4622';
    g.fillRect(0, 0, s, 44); g.fillRect(0, s - 44, s, 44); g.fillRect(0, 0, 44, s); g.fillRect(s - 44, 0, 44, s);
    g.save(); g.translate(s / 2, s / 2); g.rotate(Math.PI / 4); g.fillRect(-s * 0.7, -22, s * 1.4, 44); g.restore();
    g.fillStyle = '#3d3d3d';
    for (const [x, y] of [[22, 22], [s - 22, 22], [22, s - 22], [s - 22, s - 22]]) { g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); }
    addNoise(g, s, 22);
  }), 4);
  // חבית מתכת
  TEX.barrel = texSet(makeCanvas(256, (g, s) => {
    g.fillStyle = '#9c2b1f'; g.fillRect(0, 0, s, s);
    blotches(g, s, 50, 'rgba(60,35,20,A)', 25, 0.5);
    for (const y of [0.18, 0.5, 0.82]) {
      g.fillStyle = 'rgba(30,10,8,0.6)'; g.fillRect(0, y * s - 5, s, 10);
      g.fillStyle = 'rgba(255,200,180,0.25)'; g.fillRect(0, y * s - 6, s, 2);
    }
    g.fillStyle = '#f2c230'; g.fillRect(s * 0.3, s * 0.3, s * 0.4, s * 0.12);
    addNoise(g, s, 24);
  }), 4);
  // פס אזהרה צהוב-שחור
  TEX.hazard = { map: toTexture(makeCanvas(256, (g, s) => {
    g.fillStyle = '#f2b705'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#1b1b1b';
    for (let i = -2; i < 6; i++) {
      g.beginPath(); g.moveTo(i * 64, s); g.lineTo(i * 64 + 32, s); g.lineTo(i * 64 + 32 + s, 0); g.lineTo(i * 64 + s, 0); g.fill();
    }
    addNoise(g, s, 30);
  })) };
  // חור כדור
  TEX.hole = toTexture(makeCanvas(64, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(10,10,10,1)'); gr.addColorStop(0.35, 'rgba(25,22,20,0.95)');
    gr.addColorStop(0.6, 'rgba(60,55,50,0.5)'); gr.addColorStop(1, 'rgba(60,55,50,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  }));
  // נקודת חלקיק רכה
  TEX.dot = toTexture(makeCanvas(64, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  }));
  // הבזק לוע
  TEX.flash = toTexture(makeCanvas(128, (g, s) => {
    g.translate(s / 2, s / 2);
    for (let i = 0; i < 7; i++) {
      g.rotate(Math.PI * 2 / 7 + Math.random() * 0.3);
      const gr = g.createLinearGradient(0, 0, s / 2, 0);
      gr.addColorStop(0, 'rgba(255,240,200,1)'); gr.addColorStop(1, 'rgba(255,140,40,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(0, -6); g.lineTo(s / 2 * (0.6 + Math.random() * 0.4), 0); g.lineTo(0, 6); g.fill();
    }
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, s / 4);
    gr.addColorStop(0, 'rgba(255,255,230,1)'); gr.addColorStop(1, 'rgba(255,170,60,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, s / 4, 0, 7); g.fill();
  }));
}

// UV לפי מטרים, כדי שהטקסטורה לא תימתח על קירות בגדלים שונים
function boxMapped(w, h, d, tile) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i;
    uv.setXY(k, uv.getX(k) * dims[f][0] / tile, uv.getY(k) * dims[f][1] / tile);
  }
  return geo;
}

// ---------- בניית המפה ----------
const wallMeshes = []; // למטרת פגיעות ויזואליות (חורים וניצוצות)
function buildMap() {
  const W = map.width, D = map.depth;
  const floorGeo = new THREE.PlaneGeometry(W + 2, D + 2);
  floorGeo.attributes.uv.array.forEach((v, i, a) => { a[i] = v * (i % 2 ? (D + 2) : (W + 2)) / 4; });
  const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({
    ...TEX.floor, roughness: 0.92, metalness: 0, normalScale: new THREE.Vector2(0.8, 0.8), envMapIntensity: 0.3,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  wallMeshes.push(floor);

  // קרקע מסביב לזירה
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x6d7a55, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.02;
  outer.receiveShadow = true;
  scene.add(outer);

  const std = (p) => new THREE.MeshStandardMaterial({ envMapIntensity: 0.3, ...p });
  const mats = {
    boundary: std({ ...TEX.brick, roughness: 0.9 }),
    center: std({ ...TEX.concrete, roughness: 0.85 }),
    wall: std({ ...TEX.concrete, roughness: 0.85, color: 0xd8d2c4 }),
    crate: std({ ...TEX.crate, roughness: 0.8 }),
    barrel: std({ ...TEX.barrel, roughness: 0.45, metalness: 0.55, envMapIntensity: 0.8 }),
    cap: std({ color: 0x5b5d61, roughness: 0.5, metalness: 0.6, envMapIntensity: 0.8 }),
    hazard: std({ ...TEX.hazard, roughness: 0.7 }),
  };

  for (const w of map.walls) {
    let mesh;
    if (w.type === 'barrel') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(w.w * 0.45, w.w * 0.45, w.h, 24), mats.barrel);
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(w.w * 0.46, w.w * 0.46, 0.04, 24), mats.cap);
      lid.position.y = w.h / 2;
      mesh.add(lid);
    } else if (w.type === 'crate') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(w.w, w.h, w.d), mats.crate);
    } else {
      const tile = w.type === 'boundary' ? 2.5 : 3;
      mesh = new THREE.Mesh(boxMapped(w.w, w.h, w.d, tile), mats[w.type] || mats.wall);
      // כיסוי מתכת על הקיר
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w.w + 0.1, 0.12, w.d + 0.1), mats.cap);
      cap.position.y = w.h / 2 + 0.06;
      cap.castShadow = true;
      mesh.add(cap);
    }
    mesh.position.set(w.x, w.h / 2, w.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    wallMeshes.push(mesh);

    if (w.type === 'center') {
      // פס אזהרה בתחתית הקיר הגדול ועמודי חיזוק
      const band = new THREE.Mesh(boxMapped(w.w, 0.6, w.d + 0.04, 1.2), mats.hazard);
      band.position.set(w.x, 0.3, w.z);
      band.receiveShadow = true;
      scene.add(band);
      for (let x = -w.w / 2 + 2; x <= w.w / 2 - 2; x += 4) {
        const pillar = new THREE.Mesh(boxMapped(0.6, w.h + 0.3, w.d + 0.24, 3), mats.center);
        pillar.position.set(x, (w.h + 0.3) / 2, w.z);
        pillar.castShadow = true; pillar.receiveShadow = true;
        scene.add(pillar);
        wallMeshes.push(pillar);
      }
    }
  }
}

// ---------- דמויות ----------
let soldier = null;     // GLTF
let soldierScale = 1;
const SOLDIER_YAW = 0; // המודל כבר מסתכל ל- -Z, כמו "קדימה" אצלנו

function makeNameSprite(name, color) {
  const c = makeCanvas(256, (g) => {
    g.font = '700 46px Rubik, Arial';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.strokeText(name, 128, 128);
    g.fillStyle = color; g.fillText(name, 128, 128);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: toTexture(c), transparent: true, depthWrite: false }));
  sp.scale.set(1.4, 1.4, 1);
  return sp;
}

function createRifle(shadows) {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2c2f34, metalness: 0.8, roughness: 0.35 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x1b1d20, metalness: 0.1, roughness: 0.7 });
  const tan = new THREE.MeshStandardMaterial({ color: 0x8c7b5a, metalness: 0.1, roughness: 0.75 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223355, metalness: 1, roughness: 0.05, emissive: 0x112244, emissiveIntensity: 0.6 });
  const add = (geo, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.x = rx;
    m.castShadow = shadows;
    g.add(m);
    return m;
  };
  const cyl = (r1, r2, len, seg = 14) => new THREE.CylinderGeometry(r1, r2, len, seg);
  add(new THREE.BoxGeometry(0.055, 0.075, 0.32), metal, 0, 0, 0);                 // גוף
  add(new THREE.BoxGeometry(0.03, 0.012, 0.36), metal, 0, 0.043, -0.04);          // מסילה
  for (let i = 0; i < 9; i++) add(new THREE.BoxGeometry(0.034, 0.008, 0.012), metal, 0, 0.052, 0.12 - i * 0.035);
  add(new THREE.BoxGeometry(0.064, 0.068, 0.26), tan, 0, -0.002, -0.28);          // מגן יד
  for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.066, 0.01, 0.03), polymer, 0, 0.02, -0.19 - i * 0.055);
  add(cyl(0.011, 0.011, 0.24), metal, 0, 0.005, -0.52, Math.PI / 2);             // קנה
  add(cyl(0.018, 0.016, 0.06), metal, 0, 0.005, -0.66, Math.PI / 2);             // בולם לוע
  add(new THREE.BoxGeometry(0.036, 0.15, 0.07), polymer, 0, -0.11, -0.06).rotation.x = 0.22; // מחסנית
  add(new THREE.BoxGeometry(0.036, 0.1, 0.045), polymer, 0, -0.085, 0.11).rotation.x = -0.35; // ידית
  add(new THREE.BoxGeometry(0.03, 0.03, 0.06), metal, 0, -0.05, 0.05);            // מגן הדק
  add(new THREE.BoxGeometry(0.045, 0.07, 0.22), tan, 0, -0.018, 0.27);            // קת
  add(new THREE.BoxGeometry(0.05, 0.105, 0.03), polymer, 0, -0.028, 0.39);
  add(cyl(0.022, 0.022, 0.16, 20), metal, 0, 0.088, -0.03, Math.PI / 2);         // כוונת
  add(cyl(0.03, 0.022, 0.05, 20), metal, 0, 0.088, -0.13, Math.PI / 2);
  add(cyl(0.027, 0.022, 0.04, 20), metal, 0, 0.088, 0.07, Math.PI / 2);
  add(new THREE.BoxGeometry(0.02, 0.03, 0.02), metal, 0, 0.06, -0.08);
  add(new THREE.BoxGeometry(0.02, 0.03, 0.02), metal, 0, 0.06, 0.03);
  const lens = add(new THREE.CircleGeometry(0.026, 20), glass, 0, 0.088, -0.156);
  lens.rotation.y = Math.PI;
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.005, -0.7);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

function createCharacter(name, color) {
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  scene.add(root);
  const ch = { root, mixer: null, actions: {}, current: null, speed: 0, lastX: null, lastZ: null, deadAt: 0, muzzle: null };

  // טבעת צבע מתחת לרגליים
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.55, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
  root.add(ring);
  ch.ring = ring;

  const tag = makeNameSprite(name, color);
  tag.position.y = 2.2;
  root.add(tag);
  ch.tag = tag;

  const model = SkeletonUtils.clone(soldier.scene);
  model.scale.setScalar(soldierScale);
  model.rotation.y = SOLDIER_YAW;
  const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55);
  model.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;
    o.material = o.material.clone();
    if (/visor/i.test(o.material.name)) {
      o.material.color.set(color);
      o.material.emissive = new THREE.Color(color);
      o.material.emissiveIntensity = 0.9;
    } else {
      o.material.color.copy(tint);
    }
  });
  root.add(model);
  ch.model = model;

  // רובה ביד ימין
  const hand = model.getObjectByName('mixamorigRightHand');
  if (hand) {
    model.updateMatrixWorld(true);
    const ws = new THREE.Vector3();
    hand.getWorldScale(ws);
    const rifle = createRifle(true);
    rifle.scale.setScalar(1 / ws.x);
    rifle.position.set(0.02 / ws.x, 0.09 / ws.x, 0.03 / ws.x);
    rifle.rotation.set(0, Math.PI / 2, Math.PI / 2);
    rifle.rotateY(-Math.PI / 2);
    hand.add(rifle);
    ch.muzzle = rifle.userData.muzzle;
  }

  ch.mixer = new THREE.AnimationMixer(model);
  for (const clip of soldier.animations) ch.actions[clip.name] = ch.mixer.clipAction(clip);
  setAnim(ch, 'Idle', 0);
  return ch;
}

function setAnim(ch, name, fade = 0.2) {
  if (ch.current === name || !ch.actions[name]) return;
  const next = ch.actions[name];
  next.reset().setEffectiveWeight(1).fadeIn(fade).play();
  if (ch.current) ch.actions[ch.current].fadeOut(fade);
  ch.current = name;
}

function removeCharacter(ch) {
  scene.remove(ch.root);
  ch.mixer.stopAllAction();
}

function updateCharacter(ch, x, z, yaw, alive, dt, now) {
  ch.root.position.set(x, 0, z);
  ch.root.rotation.y = yaw;
  if (!alive) {
    // נפילה לאחור
    const t = Math.min(1, (now - ch.deadAt) / 450);
    ch.root.rotation.x = t * t * Math.PI / 2;
    ch.root.position.y = 0.15 * t;
    ch.ring.visible = ch.tag.visible = false;
    ch.root.visible = now - ch.deadAt < 2400;
    return;
  }
  ch.root.visible = ch.ring.visible = ch.tag.visible = true;
  ch.root.rotation.x = 0;
  if (ch.lastX !== null && dt > 0) {
    const sp = Math.hypot(x - ch.lastX, z - ch.lastZ) / dt;
    ch.speed += (sp - ch.speed) * Math.min(1, dt * 8);
  }
  ch.lastX = x; ch.lastZ = z;
  setAnim(ch, ch.speed > 3 ? 'Run' : ch.speed > 0.35 ? 'Walk' : 'Idle');
  ch.mixer.update(dt);
}

// ---------- נשק בגוף ראשון (סצנה נפרדת כדי שלא ייכנס לתוך קירות) ----------
const weaponScene = new THREE.Scene();
const weaponCam = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 10);
weaponScene.add(new THREE.HemisphereLight(0xdde8ff, 0x6b5a45, 1.0));
const wSun = new THREE.DirectionalLight(0xfff0d8, 2.2);
wSun.position.set(0.5, 1, 0.3);
weaponScene.add(wSun);
const wFlashLight = new THREE.PointLight(0xffa040, 0, 3);
weaponScene.add(wFlashLight);
let fpRifle = null;
let fpFlash = null;
const FP_BASE = new THREE.Vector3(0.2, -0.23, -0.52);
let recoil = 0, bobT = 0, swayX = 0, swayY = 0;

// ידיים בגוף ראשון: שרוול + כפפה, מחוברות לרובה
function addArms(rifle) {
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x2f3526, roughness: 0.95 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.8 });
  const limb = (from, to, r, mat) => {
    const len = from.distanceTo(to);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), mat);
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    rifle.add(m);
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // יד ימין על הידית
  limb(V(0.01, -0.1, 0.13), V(0.03, -0.14, 0.2), 0.032, glove);
  limb(V(0.03, -0.15, 0.22), V(0.12, -0.3, 0.55), 0.045, sleeve);
  // יד שמאל על מגן היד
  limb(V(-0.01, -0.05, -0.33), V(-0.04, -0.09, -0.28), 0.032, glove);
  limb(V(-0.05, -0.1, -0.27), V(-0.24, -0.3, 0.05), 0.045, sleeve);
}

function buildWeapon() {
  weaponScene.environment = scene.environment;
  fpRifle = createRifle(false);
  addArms(fpRifle);
  fpRifle.position.copy(FP_BASE);
  fpRifle.rotation.y = 0.04;
  weaponScene.add(fpRifle);
  fpFlash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: TEX.flash, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  }));
  fpFlash.scale.setScalar(0.3);
  fpFlash.visible = false;
  fpRifle.userData.muzzle.add(fpFlash);
}

// ---------- אפקטים ----------
const bursts = [];
function burst(pos, { count = 18, color = 0xffc870, speed = 4, life = 0.45, gravity = 9, size = 0.07, additive = true, dir = null }) {
  const arr = new Float32Array(count * 3);
  const vel = [];
  for (let i = 0; i < count; i++) {
    arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z;
    const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
    if (dir) v.add(dir).normalize();
    vel.push(v.multiplyScalar(speed * (0.3 + Math.random() * 0.9)));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const mat = new THREE.PointsMaterial({
    color, size, map: TEX.dot, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  bursts.push({ pts, vel, born: performance.now(), life: life * 1000, gravity });
}
function updateBursts(now, dt) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i], age = now - b.born;
    if (age > b.life) {
      scene.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose();
      bursts.splice(i, 1); continue;
    }
    const a = b.pts.geometry.attributes.position;
    for (let k = 0; k < b.vel.length; k++) {
      const v = b.vel[k];
      v.y -= b.gravity * dt;
      a.setXYZ(k, a.getX(k) + v.x * dt, Math.max(0.02, a.getY(k) + v.y * dt), a.getZ(k) + v.z * dt);
    }
    a.needsUpdate = true;
    b.pts.material.opacity = 1 - age / b.life;
  }
}

const holes = [];
const holeGeo = new THREE.PlaneGeometry(0.14, 0.14);
function addHole(point, normal, color = 0xffffff, size = 1) {
  const m = new THREE.Mesh(holeGeo, new THREE.MeshBasicMaterial({
    map: TEX.hole, color, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
  }));
  m.position.copy(point).addScaledVector(normal, 0.01);
  m.lookAt(point.clone().add(normal));
  m.rotateZ(Math.random() * Math.PI);
  m.scale.setScalar(size);
  scene.add(m);
  holes.push(m);
  if (holes.length > 40) { const h = holes.shift(); scene.remove(h); h.material.dispose(); }
}

const tracers = [];
const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
function addTracer(from, to) {
  const len = from.distanceTo(to);
  const geo = new THREE.CylinderGeometry(0.008, 0.008, len, 6, 1, true);
  geo.translate(0, len / 2, 0);
  geo.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(geo, tracerMat.clone());
  m.position.copy(from);
  m.lookAt(to);
  scene.add(m);
  tracers.push({ m, born: performance.now() });
}

const remoteFlashes = [];
function remoteMuzzleFlash(ch) {
  const pos = new THREE.Vector3();
  if (ch.muzzle) ch.muzzle.getWorldPosition(pos);
  else pos.set(0, 1.35, -0.7).applyMatrix4(ch.root.matrixWorld);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.flash, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  sp.position.copy(pos);
  sp.scale.setScalar(0.7);
  sp.material.rotation = Math.random() * 6;
  scene.add(sp);
  remoteFlashes.push({ sp, born: performance.now() });
}

const raycaster = new THREE.Raycaster();
function shotEffects() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  // נקודת הלוע של הנשק בעולם
  const muzzleWorld = new THREE.Vector3();
  fpRifle.userData.muzzle.getWorldPosition(muzzleWorld);
  muzzleWorld.applyMatrix4(camera.matrixWorld);
  raycaster.set(camera.position, dir);
  raycaster.far = 90;
  const hit = raycaster.intersectObjects(wallMeshes, true)[0];
  const end = hit ? hit.point : camera.position.clone().addScaledVector(dir, 90);
  addTracer(muzzleWorld, end);
  if (hit && hit.face) {
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    addHole(hit.point, n);
    burst(hit.point, { count: 14, color: 0xffcf7a, speed: 5, life: 0.35, dir: n });
    burst(hit.point, { count: 8, color: 0x8a8278, speed: 1.6, life: 0.8, gravity: 2, size: 0.18, additive: false, dir: n });
  }
}

// ---------- פיזיקה (זהה לשרת) ----------
function collidesWall(x, z) {
  const r = cfg.radius;
  for (const w of map.walls) {
    const cx = Math.max(w.x - w.w / 2, Math.min(x, w.x + w.w / 2));
    const cz = Math.max(w.z - w.d / 2, Math.min(z, w.z + w.d / 2));
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}
function applyMove(p, mx, mz, yaw) {
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  const dt = 1 / cfg.tick;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const vx = (fx * mz + rx * mx) * cfg.speed * dt;
  const vz = (fz * mz + rz * mx) * cfg.speed * dt;
  if (!collidesWall(p.x + vx, p.z)) p.x += vx;
  if (!collidesWall(p.x, p.z + vz)) p.z += vz;
}

// ---------- רשת ----------
function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = onOpen;
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (inGame) location.reload();
    else $('menuError').textContent = 'אין חיבור לשרת';
  };
}
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handle(m) {
  switch (m.t) {
    case 'joined': {
      myId = m.id; cfg = m.cfg;
      clearDemo();
      $('roomCode').textContent = `חדר ${m.code}`;
      menu.classList.add('hidden');
      hud.classList.remove('hidden');
      inGame = true;
      gameOver = m.state === 'over';
      break;
    }
    case 'error':
      $('menuError').textContent = m.msg;
      ws.onclose = null; ws.close();
      break;
    case 'roster': {
      const ids = new Set(m.players.map(p => p.id));
      for (const [id, p] of players) {
        if (!ids.has(id)) { if (p.ch) removeCharacter(p.ch); players.delete(id); }
      }
      for (const info of m.players) {
        let p = players.get(info.id);
        if (!p) {
          p = { x: 0, z: 0, yaw: 0, alive: true, tx: 0, tz: 0, ch: null, fresh: true };
          if (info.id !== myId) p.ch = createCharacter(info.name, info.color);
          players.set(info.id, p);
        }
        p.name = info.name; p.color = info.color; p.score = info.score;
      }
      renderScoreboard();
      break;
    }
    case 's': onSnapshot(m.p); break;
    case 'shot': {
      addArrow(m.id, m.x, m.z);
      const p = players.get(m.id);
      if (p && p.ch && p.alive) remoteMuzzleFlash(p.ch);
      break;
    }
    case 'kill': onKill(m); break;
    case 'over': onOver(m); break;
    case 'restart':
      cfg.win = m.win;
      renderScoreboard();
      gameOver = false;
      overEl.classList.add('hidden');
      break;
  }
}

function onSnapshot(list) {
  for (const [id, x, z, yaw, pitch, alive, ack] of list) {
    const p = players.get(id);
    if (!p) continue;
    if (id === myId) {
      const wasAlive = me.alive;
      me.alive = !!alive;
      if (!wasAlive && me.alive) {
        me.yaw = yaw; me.pitch = 0;
        deathMsg.classList.add('hidden');
        $('damage').style.opacity = 0;
        fpRifle.visible = true;
      }
      // יישוב מחדש: מתחילים מהמיקום של השרת ומריצים שוב את הקלטים שעוד לא אושרו
      me.x = x; me.z = z;
      pending = pending.filter(i => i.seq > ack);
      for (const i of pending) applyMove(me, i.mx, i.mz, i.yaw);
      if (!wasAlive && me.alive) { me.prevX = me.x; me.prevZ = me.z; }
    } else {
      p.tx = x; p.tz = z; p.yaw = yaw;
      if (p.fresh || (!p.alive && alive)) {
        p.x = x; p.z = z; p.fresh = false;
        if (p.ch) { p.ch.lastX = null; p.ch.speed = 0; }
      }
      p.alive = !!alive;
    }
  }
}

function onKill(m) {
  const killer = players.get(m.killer), victim = players.get(m.victim);
  addKillfeed(killer, victim);
  if (victim && victim.ch && m.victim !== myId) {
    victim.alive = false;
    victim.ch.deadAt = performance.now();
    const pos = new THREE.Vector3(victim.x, 1.3, victim.z);
    burst(pos, { count: 40, color: 0x9e0b0b, speed: 3.5, life: 0.9, gravity: 9, size: 0.09, additive: false });
    burst(pos, { count: 12, color: 0x5a0505, speed: 1.2, life: 1.4, gravity: 1, size: 0.3, additive: false });
    addHole(new THREE.Vector3(victim.x, 0.02, victim.z), new THREE.Vector3(0, 1, 0), 0x7a0000, 6);
  }
  if (m.victim === myId) {
    me.alive = false;
    deathTime = performance.now();
    respawnAt = deathTime + m.respawnMs;
    deathMsg.classList.remove('hidden');
    deathMsg.dataset.killer = killer ? killer.name : '?';
    $('damage').style.opacity = 1;
    fpRifle.visible = false;
  }
  if (m.killer === myId) {
    const hm = $('hitMarker'), ht = $('hitText');
    hm.style.opacity = 1; ht.textContent = 'הריגה!'; ht.style.opacity = 1;
    setTimeout(() => { hm.style.opacity = 0; ht.style.opacity = 0; }, 600);
  }
}

function onOver(m) {
  gameOver = true;
  const w = players.get(m.winner);
  $('overTitle').textContent = m.winner === myId ? '🏆 ניצחת!' : `🏆 ${w ? w.name : '?'} ניצח/ה!`;
  $('overBoard').innerHTML = m.board.map((p, i) =>
    `<div class="line" style="color:${p.color}"><span>${i + 1}. ${escapeHtml(p.name)}${p.id === myId ? ' (אתה)' : ''}</span><span>${p.score}</span></div>`
  ).join('');
  $('winSelect2').value = cfg.win;
  overEl.classList.remove('hidden');
  firing = false; fireBtn.classList.remove('active');
}

function renderScoreboard() {
  const list = [...players.entries()].sort((a, b) => b[1].score - a[1].score);
  $('scoreboard').innerHTML = list.map(([id, p]) =>
    `<div class="line"><span><i style="background:${p.color}"></i>${escapeHtml(p.name)}${id === myId ? ' ★' : ''}</span><span>${p.score}</span></div>`
  ).join('') + `<div style="opacity:.6;font-size:11px">ראשון ל-${cfg ? cfg.win : 10}</div>`;
}

function addKillfeed(killer, victim) {
  const d = document.createElement('div');
  const name = p => p ? `<b style="color:${p.color}">${escapeHtml(p.name)}</b>` : '?';
  d.innerHTML = `${name(killer)} ⌖ ${name(victim)}`;
  $('killfeed').prepend(d);
  setTimeout(() => { d.style.opacity = 0; }, 3500);
  setTimeout(() => d.remove(), 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- חצי יריה ----------
const arrows = new Map(); // shooterId -> { x, z, born, el }
function addArrow(id, x, z) {
  let a = arrows.get(id);
  if (!a) {
    const el = document.createElement('div');
    el.className = 'arrow';
    const p = players.get(id);
    el.style.background = p ? p.color : '#fff';
    arrowsEl.appendChild(el);
    a = { el };
    arrows.set(id, a);
  }
  a.x = x; a.z = z; a.born = performance.now();
}
function updateArrows(now) {
  const W = window.innerWidth, H = window.innerHeight;
  const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
  const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
  for (const [id, a] of arrows) {
    const age = now - a.born;
    if (age > ARROW_MS) { a.el.remove(); arrows.delete(id); continue; }
    const dx = a.x - me.x, dz = a.z - me.z;
    const forward = dx * fx + dz * fz;
    const right = dx * rx + dz * rz;
    const ang = Math.atan2(right, forward); // 0 = מולי, חיובי = ימינה
    const cx = W / 2 + Math.sin(ang) * (W / 2 - 50);
    const cy = H / 2 - Math.cos(ang) * (H / 2 - 50);
    const pulse = 1 + 0.15 * Math.max(0, 1 - age / 300);
    a.el.style.transform = `translate(${cx}px, ${cy}px) rotate(${ang}rad) scale(${pulse})`;
    a.el.style.opacity = age < 2000 ? 1 : 1 - (age - 2000) / 1000;
  }
}

// ---------- שליטה ----------
const input = { mx: 0, mz: 0 };
let firing = false;
const keys = {};
let moveTouch = null, lookTouches = new Map(), fireTouch = null;
const JOY_R = 55;
const LOOK_SENS = 0.006;

function setJoy(bx, by, kx, ky) {
  joyBase.style.transform = `translate(${bx}px, ${by}px)`;
  joyKnob.style.transform = `translate(${kx}px, ${ky}px)`;
}
// מרחק מהשוליים הבטוחים (המגרעת באייפון במסך מלא)
const safeProbe = document.createElement('div');
safeProbe.style.cssText = 'position:fixed;visibility:hidden;padding-left:env(safe-area-inset-left);padding-bottom:env(safe-area-inset-bottom)';
document.body.appendChild(safeProbe);
function resetJoy() {
  const cs = getComputedStyle(safeProbe);
  const left = parseFloat(cs.paddingLeft) || 0, bottom = parseFloat(cs.paddingBottom) || 0;
  setJoy(110 + left, window.innerHeight - 110 - bottom, 0, 0);
  input.mx = 0; input.mz = 0;
}
resetJoy();

function look(dx, dy) {
  me.yaw -= dx * LOOK_SENS;
  me.pitch = Math.max(-1.3, Math.min(1.3, me.pitch - dy * LOOK_SENS));
  swayX += dx * 0.00025; swayY += dy * 0.00025;
}

function onTouchStart(e) {
  if (!inGame || e.target.closest('.ui')) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.target === fireBtn || fireBtn.contains(t.target)) {
      fireTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
      firing = true; fireBtn.classList.add('active');
      tryShoot(performance.now()); // גם טאפ קצר יורה מיד
    } else if (t.clientX < window.innerWidth / 2 && !moveTouch) {
      moveTouch = { id: t.identifier, bx: t.clientX, by: t.clientY };
      setJoy(t.clientX, t.clientY, 0, 0);
    } else {
      lookTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
  }
}
function onTouchMove(e) {
  if (!inGame || e.target.closest('.ui')) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (moveTouch && t.identifier === moveTouch.id) {
      let dx = t.clientX - moveTouch.bx, dy = t.clientY - moveTouch.by;
      const d = Math.hypot(dx, dy);
      if (d > JOY_R) { dx *= JOY_R / d; dy *= JOY_R / d; }
      setJoy(moveTouch.bx, moveTouch.by, dx, dy);
      input.mx = dx / JOY_R; input.mz = -dy / JOY_R;
    } else if (fireTouch && t.identifier === fireTouch.id) {
      // אפשר לכוון תוך כדי החזקת כפתור הירי
      look(t.clientX - fireTouch.x, t.clientY - fireTouch.y);
      fireTouch.x = t.clientX; fireTouch.y = t.clientY;
    } else if (lookTouches.has(t.identifier)) {
      const l = lookTouches.get(t.identifier);
      look(t.clientX - l.x, t.clientY - l.y);
      l.x = t.clientX; l.y = t.clientY;
    }
  }
}
function onTouchEnd(e) {
  for (const t of e.changedTouches) {
    if (moveTouch && t.identifier === moveTouch.id) { moveTouch = null; resetJoy(); }
    else if (fireTouch && t.identifier === fireTouch.id) { fireTouch = null; firing = false; fireBtn.classList.remove('active'); }
    else lookTouches.delete(t.identifier);
  }
}
document.addEventListener('touchstart', onTouchStart, { passive: false });
document.addEventListener('touchmove', onTouchMove, { passive: false });
document.addEventListener('touchend', onTouchEnd);
document.addEventListener('touchcancel', onTouchEnd);
// iOS: מניעת זום בצביטה/דאבל-טאפ
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());

// מקלדת ועכבר (לבדיקה במחשב): WASD + עכבר + קליק
document.addEventListener('keydown', e => { keys[e.code] = true; });
document.addEventListener('keyup', e => { keys[e.code] = false; });
renderer.domElement.addEventListener('click', () => {
  if (inGame && !gameOver && document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
});
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement === renderer.domElement) look(e.movementX * 0.5, e.movementY * 0.5);
});
document.addEventListener('mousedown', e => {
  if (document.pointerLockElement === renderer.domElement && e.button === 0) { firing = true; tryShoot(performance.now()); }
});
document.addEventListener('mouseup', e => { if (e.button === 0 && !fireTouch) firing = false; });

function keyboardInput() {
  if (moveTouch) return;
  const kx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const kz = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  if (kx || kz || !IS_TOUCH) { input.mx = kx; input.mz = kz; }
}

// ---------- תפריט ----------
function startGame(msg) {
  const name = $('nameInput').value.trim() || 'שחקן';
  localStorage.setItem('name', name);
  msg.name = name;
  $('menuError').textContent = 'מתחבר...';
  // מסך מלא + נעילה לרוחב (עובד באנדרואיד, באייפון מתעלמים)
  const el = document.documentElement;
  if (el.requestFullscreen) {
    el.requestFullscreen().then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  }
  connect(() => { $('menuError').textContent = ''; send(msg); });
}
// בחירת ניקוד לניצחון (1-10), נשמר לפעם הבאה
for (const id of ['winSelect', 'winSelect2']) {
  for (let i = 1; i <= 10; i++) $(id).add(new Option(i, i));
}
$('winSelect').value = localStorage.getItem('win') || 10;
$('winSelect').onchange = () => localStorage.setItem('win', $('winSelect').value);
$('createBtn').onclick = () => startGame({ t: 'create', win: +$('winSelect').value });
$('joinBtn').onclick = () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { $('menuError').textContent = 'הקוד צריך להיות 4 אותיות'; return; }
  startGame({ t: 'join', code });
};
$('restartBtn').onclick = () => send({ t: 'restart', win: +$('winSelect2').value });

// בדיקת גודל המסך בכל פריים: באייפון (במיוחד ממסך הבית) אירוע resize
// לא תמיד מגיע אחרי סיבוב, והתמונה נשארת בגודל של מצב עמידה
let viewW = 0, viewH = 0;
function syncSize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (w === viewW && h === viewH) return;
  viewW = w; viewH = h;
  renderer.setSize(w, h, false);
  camera.aspect = weaponCam.aspect = w / h;
  camera.updateProjectionMatrix();
  weaponCam.updateProjectionMatrix();
  if (!moveTouch) resetJoy();
}

// דמויות לתצוגה ברקע התפריט
const demo = [];
function spawnDemo() {
  const spots = [[-4, 3.5, Math.PI, '#4da6ff', 'Run'], [5, -4, 0.3, '#ff4d4d', 'Idle'], [-9, -9, -0.8, '#5cd65c', 'Walk']];
  for (const [x, z, yaw, color, anim] of spots) {
    const ch = createCharacter('', color);
    ch.tag.visible = false;
    ch.root.position.set(x, 0, z);
    ch.root.rotation.y = yaw;
    setAnim(ch, anim, 0);
    demo.push(ch);
  }
}
function clearDemo() {
  for (const ch of demo) removeCharacter(ch);
  demo.length = 0;
}

// ---------- לולאה ראשית ----------
function tryShoot(now) {
  if (me.alive && !gameOver && now - lastShotTime >= SHOOT_INTERVAL) shoot(now);
}
function shoot(now) {
  lastShotTime = now;
  send({ t: 'shoot', yaw: me.yaw, pitch: me.pitch });
  recoil = 1;
  fpFlash.visible = true;
  fpFlash.material.rotation = Math.random() * 6;
  flashLight.intensity = 25;
  wFlashLight.intensity = 6;
  const ch = $('crosshair');
  ch.classList.add('kick');
  setTimeout(() => ch.classList.remove('kick'), 90);
  shotEffects();
}

function inputTick() {
  seq++;
  const alive = me.alive && !gameOver;
  const inp = { seq, mx: alive ? input.mx : 0, mz: alive ? input.mz : 0, yaw: me.yaw, pitch: me.pitch };
  me.prevX = me.x; me.prevZ = me.z;
  if (alive) applyMove(me, inp.mx, inp.mz, inp.yaw);
  pending.push(inp);
  if (pending.length > 120) pending.shift();
  send({ t: 'in', ...inp });
}

let acc = 0;
let last = performance.now();
let mySpeed = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  syncSize();

  if (inGame && cfg) {
    keyboardInput();
    const step = 1 / cfg.tick;
    acc += dt;
    while (acc >= step) { inputTick(); acc -= step; }
    const alpha = acc / step;

    if (firing) tryShoot(now);

    // מצלמה = המיקום החזוי שלי (עם אינטרפולציה בין טיקים)
    const cx = me.prevX + (me.x - me.prevX) * alpha;
    const cz = me.prevZ + (me.z - me.prevZ) * alpha;
    const moving = Math.hypot(me.x - me.prevX, me.z - me.prevZ) * cfg.tick;
    mySpeed += (moving - mySpeed) * Math.min(1, dt * 10);
    bobT += dt * mySpeed * 1.9;
    const bobAmt = Math.min(1, mySpeed / cfg.speed);
    if (me.alive) {
      camera.position.set(cx, cfg.eye + Math.sin(bobT * 2) * 0.035 * bobAmt, cz);
      camera.rotation.set(me.pitch, me.yaw, Math.sin(bobT) * 0.004 * bobAmt);
    } else {
      // מצלמת מוות: נופלים לרצפה
      const t = Math.min(1, (now - deathTime) / 500);
      camera.position.set(cx, cfg.eye - t * 1.25, cz);
      camera.rotation.set(me.pitch * (1 - t) + 0.25 * t, me.yaw, t * 0.5);
    }

    // נשק: נדנוד הליכה, רתע, תנועה עם המבט
    recoil += (0 - recoil) * Math.min(1, dt * 12);
    swayX += (0 - swayX) * Math.min(1, dt * 8);
    swayY += (0 - swayY) * Math.min(1, dt * 8);
    fpRifle.position.set(
      FP_BASE.x + Math.sin(bobT) * 0.012 * bobAmt - swayX,
      FP_BASE.y - Math.abs(Math.cos(bobT)) * 0.012 * bobAmt + swayY + recoil * 0.012,
      FP_BASE.z + recoil * 0.07
    );
    fpRifle.rotation.set(recoil * 0.09 + swayY * 2, 0.04 + swayX * 2, 0);
    if (now - lastShotTime > 45) fpFlash.visible = false;
    camera.updateMatrixWorld();
    flashLight.position.copy(camera.position);
    flashLight.intensity *= Math.pow(0.0005, dt);
    wFlashLight.position.set(0.17, -0.1, -1);
    wFlashLight.intensity *= Math.pow(0.0005, dt);

    // יריבים - החלקה לכיוון המיקום מהשרת
    const k = Math.min(1, dt * 15);
    for (const [id, p] of players) {
      if (id === myId || !p.ch) continue;
      if (p.alive) {
        p.x += (p.tx - p.x) * k;
        p.z += (p.tz - p.z) * k;
      }
      updateCharacter(p.ch, p.x, p.z, p.yaw, p.alive, dt, now);
    }

    updateArrows(now);

    if (!me.alive) {
      const s = Math.max(0, Math.ceil((respawnAt - now) / 1000));
      deathMsg.innerHTML = `<div>💀 ${escapeHtml(deathMsg.dataset.killer || '')} הרג אותך</div><small>חוזר בעוד ${s}...</small>`;
    }
  } else if (map) {
    if (location.hash === '#preview') {
      // תצוגה קרובה של הדמויות (לבדיקת גרפיקה)
      camera.position.set(-3.1, 1.5, 5.3);
      camera.lookAt(-4, 1.1, 3.5);
    } else {
      // מצלמה מסתובבת מעל המפה בתפריט
      const a = now * 0.00006;
      camera.position.set(Math.sin(a) * 28, 13, Math.cos(a) * 28);
      camera.lookAt(0, 1.5, 0);
    }
    for (const ch of demo) ch.mixer.update(dt);
  }

  // אפקטים
  updateBursts(now, dt);
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i], age = now - t.born;
    if (age > 90) { scene.remove(t.m); t.m.geometry.dispose(); t.m.material.dispose(); tracers.splice(i, 1); }
    else t.m.material.opacity = 1 - age / 90;
  }
  for (let i = remoteFlashes.length - 1; i >= 0; i--) {
    const f = remoteFlashes[i];
    if (now - f.born > 60) { scene.remove(f.sp); f.sp.material.dispose(); remoteFlashes.splice(i, 1); }
  }

  renderer.clear();
  renderer.render(scene, camera);
  if (inGame && fpRifle && fpRifle.visible) {
    renderer.clearDepth();
    renderer.render(weaponScene, weaponCam);
  }
}

// ---------- טעינה ----------
async function init() {
  buildTextures();
  const [mapData, gltf] = await Promise.all([
    fetch('/map.json').then(r => r.json()),
    new GLTFLoader().loadAsync('/models/soldier.glb'),
  ]);
  map = mapData;
  soldier = gltf;
  // גובה הדמות לפי השלד (גבולות של מודל מונפש לא אמינים)
  gltf.scene.updateMatrixWorld(true);
  const top = gltf.scene.getObjectByName('mixamorigHeadTop_End');
  const topY = top ? top.getWorldPosition(new THREE.Vector3()).y : 1.8;
  soldierScale = 1.8 / topY;
  buildMap();
  buildWeapon();
  spawnDemo();
  $('loading').classList.add('hidden');
  if (location.hash === '#preview') menu.classList.add('hidden');
  requestAnimationFrame(loop);
}
init().catch(err => {
  console.error(err);
  $('loading').innerHTML = 'שגיאה בטעינה. רענן את הדף.';
});

// game.js - צד לקוח: רינדור Three.js, שליטה במגע, חיזוי תנועה וחצי יריה
import * as THREE from 'three';

// ---------- מצב כללי ----------
let ws = null;
let myId = null;
let cfg = null;          // הגדרות מהשרת
let walls = [];
let inGame = false;
let gameOver = false;
const players = new Map(); // id -> { name, color, score, mesh, x, z, yaw, alive, tx, tz }

// המצב של השחקן שלי (חזוי מקומית)
const me = { x: 0, z: 0, prevX: 0, prevZ: 0, yaw: 0, pitch: 0, alive: true };
let seq = 0;
let pending = [];        // קלטים שנשלחו ועדיין לא אושרו ע"י השרת
let respawnAt = 0;

const SHOOT_INTERVAL = 350;
const ARROW_MS = 3000;
let lastShotTime = 0;

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const menu = $('menu'), hud = $('hud'), overEl = $('over');
const joyBase = $('joyBase'), joyKnob = $('joyKnob'), fireBtn = $('fireBtn');
const arrowsEl = $('arrows'), deathMsg = $('deathMsg');

$('nameInput').value = localStorage.getItem('name') || '';

// ---------- Three.js ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
$('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5e8);
scene.fog = new THREE.Fog(0x87b5e8, 25, 60);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
camera.rotation.order = 'YXZ';
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(10, 20, 6);
scene.add(sun);

// נשק פשוט שמחובר למצלמה
const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.4), new THREE.MeshLambertMaterial({ color: 0x333333 }));
gun.position.set(0.22, -0.2, -0.5);
camera.add(gun);
const muzzle = new THREE.Object3D();
muzzle.position.set(0, 0, -0.22);
gun.add(muzzle);

function buildMap(map) {
  const size = map.size;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshLambertMaterial({ color: 0x5f7f4f })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const grid = new THREE.GridHelper(size, size, 0x000000, 0x000000);
  grid.material.opacity = 0.15;
  grid.material.transparent = true;
  grid.position.y = 0.01;
  scene.add(grid);

  const wallColors = [0xb08968, 0x9c8a7a, 0xa47551, 0x8d99ae];
  map.walls.forEach((w, i) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w.w, w.h, w.d),
      new THREE.MeshLambertMaterial({ color: wallColors[i % wallColors.length] })
    );
    mesh.position.set(w.x, w.h / 2, w.z);
    scene.add(mesh);
  });
}

function makePlayerMesh(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.3, 16), mat);
  body.position.y = 0.65;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), mat);
  head.position.y = 1.5;
  const eyes = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  eyes.position.set(0, 1.55, -0.27);
  const g2 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.7), new THREE.MeshLambertMaterial({ color: 0x222222 }));
  g2.position.set(0.35, 1.1, -0.35);
  g.add(body, head, eyes, g2);
  scene.add(g);
  return g;
}

// קווי יריה (רק של היריות שלי, כדי שלא יסגירו יריבים)
const tracers = [];
function spawnTracer() {
  const start = new THREE.Vector3();
  muzzle.getWorldPosition(start);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const end = camera.position.clone().addScaledVector(dir, 60);
  const geo = new THREE.BufferGeometry().setFromPoints([start, end]);
  const mat = new THREE.LineBasicMaterial({ color: 0xffee88, transparent: true, opacity: 1 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  tracers.push({ line, born: performance.now() });
}

// ---------- פיזיקה (זהה לשרת) ----------
function collidesWall(x, z) {
  const r = cfg.radius;
  for (const w of walls) {
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
      myId = m.id; cfg = m.cfg; walls = m.map.walls;
      buildMap(m.map);
      $('roomCode').textContent = `חדר: ${m.code}`;
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
        if (!ids.has(id)) { if (p.mesh) scene.remove(p.mesh); players.delete(id); }
      }
      for (const info of m.players) {
        let p = players.get(info.id);
        if (!p) {
          p = { x: 0, z: 0, yaw: 0, alive: true, tx: 0, tz: 0, mesh: null, fresh: true };
          if (info.id !== myId) p.mesh = makePlayerMesh(info.color);
          players.set(info.id, p);
        }
        p.name = info.name; p.color = info.color; p.score = info.score;
      }
      renderScoreboard();
      break;
    }
    case 's': onSnapshot(m.p); break;
    case 'shot': addArrow(m.id, m.x, m.z); break;
    case 'kill': onKill(m); break;
    case 'over': onOver(m); break;
    case 'restart':
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
      if (!wasAlive && me.alive) { me.yaw = yaw; me.pitch = 0; deathMsg.classList.add('hidden'); }
      // יישוב מחדש: מתחילים מהמיקום של השרת ומריצים שוב את הקלטים שעוד לא אושרו
      me.x = x; me.z = z;
      pending = pending.filter(i => i.seq > ack);
      for (const i of pending) applyMove(me, i.mx, i.mz, i.yaw);
      if (!wasAlive && me.alive) { me.prevX = me.x; me.prevZ = me.z; }
    } else {
      p.tx = x; p.tz = z; p.yaw = yaw;
      if (p.fresh || (!p.alive && alive)) { p.x = x; p.z = z; p.fresh = false; }
      p.alive = !!alive;
    }
  }
}

function onKill(m) {
  const killer = players.get(m.killer), victim = players.get(m.victim);
  addKillfeed(`${killer ? killer.name : '?'} 🔫 ${victim ? victim.name : '?'}`);
  if (m.victim === myId) {
    me.alive = false;
    respawnAt = performance.now() + m.respawnMs;
    deathMsg.classList.remove('hidden');
    deathMsg.dataset.killer = killer ? killer.name : '?';
  }
  if (m.killer === myId) {
    const ch = $('crosshair'), ht = $('hitText');
    ch.classList.add('hit'); ht.textContent = 'הריגה!'; ht.style.opacity = 1;
    setTimeout(() => { ch.classList.remove('hit'); ht.style.opacity = 0; }, 500);
  }
}

function onOver(m) {
  gameOver = true;
  const w = players.get(m.winner);
  $('overTitle').textContent = m.winner === myId ? '🏆 ניצחת!' : `🏆 ${w ? w.name : '?'} ניצח/ה!`;
  $('overBoard').innerHTML = m.board.map((p, i) =>
    `<div class="line" style="color:${p.color}"><span>${i + 1}. ${escapeHtml(p.name)}${p.id === myId ? ' (אתה)' : ''}</span><span>${p.score}</span></div>`
  ).join('');
  overEl.classList.remove('hidden');
  firing = false; fireBtn.classList.remove('active');
}

function renderScoreboard() {
  const list = [...players.entries()].sort((a, b) => b[1].score - a[1].score);
  $('scoreboard').innerHTML = list.map(([id, p]) =>
    `<div class="line" style="color:${p.color}"><span>${escapeHtml(p.name)}${id === myId ? ' ★' : ''}</span><span>${p.score}</span></div>`
  ).join('') + `<div style="opacity:.6;font-size:11px">ראשון ל-${cfg ? cfg.win : 10}</div>`;
}

function addKillfeed(text) {
  const d = document.createElement('div');
  d.textContent = text;
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
    a.el.style.transform = `translate(${cx}px, ${cy}px) rotate(${ang}rad)`;
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
let joyHome = { x: 110, y: window.innerHeight - 110 };

function setJoy(bx, by, kx, ky) {
  joyBase.style.transform = `translate(${bx}px, ${by}px)`;
  joyKnob.style.transform = `translate(${kx}px, ${ky}px)`;
}
function resetJoy() {
  joyHome = { x: 110, y: window.innerHeight - 110 };
  setJoy(joyHome.x, joyHome.y, 0, 0);
  input.mx = 0; input.mz = 0;
}
resetJoy();

function look(dx, dy) {
  me.yaw -= dx * LOOK_SENS;
  me.pitch = Math.max(-1.3, Math.min(1.3, me.pitch - dy * LOOK_SENS));
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
  if (kx || kz || !('ontouchstart' in window)) { input.mx = kx; input.mz = kz; }
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
$('createBtn').onclick = () => startGame({ t: 'create' });
$('joinBtn').onclick = () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { $('menuError').textContent = 'הקוד צריך להיות 4 אותיות'; return; }
  startGame({ t: 'join', code });
};
$('restartBtn').onclick = () => send({ t: 'restart' });

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (!moveTouch) resetJoy();
});

// ---------- לולאה ראשית ----------
function tryShoot(now) {
  if (me.alive && !gameOver && now - lastShotTime >= SHOOT_INTERVAL) shoot(now);
}
function shoot(now) {
  lastShotTime = now;
  send({ t: 'shoot', yaw: me.yaw, pitch: me.pitch });
  spawnTracer();
  gun.position.z = -0.42; // רתע קטן
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
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (inGame && cfg) {
    keyboardInput();
    const step = 1 / cfg.tick;
    acc += dt;
    while (acc >= step) { inputTick(); acc -= step; }
    const alpha = acc / step;

    if (firing) tryShoot(now);
    gun.position.z += (-0.5 - gun.position.z) * Math.min(1, dt * 15);

    // מצלמה = המיקום החזוי שלי (עם אינטרפולציה בין טיקים)
    camera.position.set(
      me.prevX + (me.x - me.prevX) * alpha,
      cfg.eye,
      me.prevZ + (me.z - me.prevZ) * alpha
    );
    camera.rotation.y = me.yaw;
    camera.rotation.x = me.pitch;

    // יריבים - החלקה לכיוון המיקום מהשרת
    const k = Math.min(1, dt * 15);
    for (const [id, p] of players) {
      if (id === myId || !p.mesh) continue;
      p.x += (p.tx - p.x) * k;
      p.z += (p.tz - p.z) * k;
      p.mesh.position.set(p.x, 0, p.z);
      p.mesh.rotation.y = p.yaw;
      p.mesh.visible = p.alive;
    }

    for (let i = tracers.length - 1; i >= 0; i--) {
      const t = tracers[i], age = now - t.born;
      if (age > 120) { scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); tracers.splice(i, 1); }
      else t.line.material.opacity = 1 - age / 120;
    }

    updateArrows(now);

    if (!me.alive) {
      const s = Math.max(0, Math.ceil((respawnAt - now) / 1000));
      deathMsg.innerHTML = `💀 ${escapeHtml(deathMsg.dataset.killer || '')} הרג אותך<br>חוזר בעוד ${s}...`;
    }
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(loop);

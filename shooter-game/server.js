// server.js - שרת סמכותי: מגיש את קבצי הלקוח ומריץ את המשחק דרך WebSocket
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- הגדרות משחק ----------
const TICK_RATE = 30;              // עדכוני שרת בשנייה
const DT = 1 / TICK_RATE;          // כל קלט מייצג טיק אחד
const MOVE_SPEED = 5;              // מטר לשנייה
const PLAYER_RADIUS = 0.4;
const PLAYER_HEIGHT = 1.8;
const HIT_RADIUS = 0.5;            // רדיוס פגיעה (קצת נדיב יותר מרדיוס ההתנגשות)
const EYE_HEIGHT = 1.6;
const FIRE_COOLDOWN_MS = 300;             // הלקוח יורה כל 350ms, מרווח קטן לג׳יטר ברשת
const RESPAWN_MS = 3000;
const MAX_WIN_SCORE = 10;           // היוצר בוחר עד כמה נקודות (1-10)
const MAX_PLAYERS = 4;
const MAX_INPUTS_PER_TICK = 4;     // הגנה בסיסית מפני "ספידהאק"
const COLORS = ['#ff4d4d', '#4da6ff', '#5cd65c', '#ffcc33'];

// ---------- כוחות וכסף ----------
const SCOPE_MS = 3000;             // 🎯 כוונת סנייפר שרואה יריבים דרך קירות ל-3 שניות (חינם)
const SCOPE_COOLDOWN_MS = 20000;   // ...ואז 20 שניות המתנה עד הפעם הבאה
const SHIELD_MS = 8000;            // 🛡 מגן ל-8 שניות
const SHIELD_COST = 200;
const KILL_REWARD = 100;
const INCOME = 10;                 // כסף שמקבלים כל INCOME_MS
const INCOME_MS = 5000;

// ---------- המפה ----------
// המפה משותפת לשרת וללקוח: public/map.json
// כל קיר הוא תיבה: מרכז (x,z), רוחב w (ציר X), עומק d (ציר Z), גובה h
const MAP = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'map.json'), 'utf8'));
const WALLS = MAP.walls;
const SPAWNS = MAP.spawns;

// ---------- פיזיקה ----------
function collidesWall(x, z) {
  for (const w of WALLS) {
    const cx = Math.max(w.x - w.w / 2, Math.min(x, w.x + w.w / 2));
    const cz = Math.max(w.z - w.d / 2, Math.min(z, w.z + w.d / 2));
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

// אותה פונקציה בדיוק קיימת בלקוח (לחיזוי תנועה)
function applyMove(p, mx, mz, yaw) {
  let len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // קדימה
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);    // ימינה
  const vx = (fx * mz + rx * mx) * MOVE_SPEED * DT;
  const vz = (fz * mz + rz * mx) * MOVE_SPEED * DT;
  if (!collidesWall(p.x + vx, p.z)) p.x += vx;
  if (!collidesWall(p.x, p.z + vz)) p.z += vz;
}

// בדיקת פגיעה: קרן ישרה מול גליל אנכי. קירות לא נלקחים בחשבון בכוונה!
function rayHitDistance(ox, oy, oz, dx, dy, dz, target) {
  const px = ox - target.x, pz = oz - target.z;
  const a = dx * dx + dz * dz;
  if (a < 1e-6) return null;
  const b = 2 * (px * dx + pz * dz);
  const c = px * px + pz * pz - HIT_RADIUS * HIT_RADIUS;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  if (t1 < 0) return null;
  if (t0 < 0) t0 = 0;
  const y0 = oy + dy * t0, y1 = oy + dy * t1;
  if (Math.max(y0, y1) < 0 || Math.min(y0, y1) > PLAYER_HEIGHT) return null;
  return t0;
}

// ---------- חדרים ----------
const rooms = new Map(); // code -> room
let nextId = 1;

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // בלי I ו-O כדי לא להתבלבל
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  } while (rooms.has(code));
  return code;
}

// כל שחקן שייך לבסיס: צד אחד של הקיר המרכזי (-1 = z שלילי, 1 = z חיובי)
function pickSide(room) {
  let neg = 0, pos = 0;
  for (const p of room.players.values()) p.side < 0 ? neg++ : pos++;
  if (neg !== pos) return neg < pos ? -1 : 1;
  return Math.random() < 0.5 ? -1 : 1;
}

function pickSpawn(room, self) {
  const mine = SPAWNS.filter(s => Math.sign(s.z) === self.side); // רק בבסיס שלך
  const others = [...room.players.values()].filter(p => p !== self && p.alive);
  const safe = mine.filter(s => others.every(o => Math.hypot(o.x - s.x, o.z - s.z) > 8));
  const list = safe.length ? safe : mine;
  return list[Math.floor(Math.random() * list.length)];
}

function spawn(room, p) {
  const s = pickSpawn(room, p);
  p.x = s.x; p.z = s.z;
  p.yaw = Math.atan2(s.x, s.z); // מסתכל בערך לכיוון מרכז המפה
  p.alive = true;
  p.respawnAt = 0;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
  }
}
function roster(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score }));
}

// מצב פרטי של השחקן (כסף וזמנים שנשארו), נשלח רק אליו
function sendMe(p) {
  const now = Date.now();
  send(p.ws, {
    t: 'me', money: p.money,
    scopeLeft: Math.max(0, p.scopeUntil - now),
    scopeCd: Math.max(0, p.scopeReadyAt - now),
    shieldLeft: Math.max(0, p.shieldUntil - now),
  });
}

function usePower(room, p, kind) {
  const now = Date.now();
  if (room.state !== 'play' || !p.alive) return;
  if (kind === 'scope') {
    if (now < p.scopeReadyAt) return;
    p.scopeUntil = now + SCOPE_MS;
    p.scopeReadyAt = p.scopeUntil + SCOPE_COOLDOWN_MS;
  } else if (kind === 'shield') {
    if (p.money < SHIELD_COST || now < p.shieldUntil) return;
    p.money -= SHIELD_COST;
    p.shieldUntil = now + SHIELD_MS;
  } else return;
  broadcast(room, { t: 'power', id: p.id, kind });
  sendMe(p);
}

function addPlayer(room, ws, name) {
  const used = new Set([...room.players.values()].map(p => p.color));
  const p = {
    id: nextId++, ws, name, color: COLORS.find(c => !used.has(c)),
    x: 0, z: 0, yaw: 0, pitch: 0, alive: true, respawnAt: 0,
    score: 0, lastShot: 0, inputs: [], ack: 0, side: pickSide(room),
    money: 0, scopeUntil: 0, scopeReadyAt: 0, shieldUntil: 0,
  };
  room.players.set(p.id, p);
  spawn(room, p);
  ws.player = p; ws.room = room;
  send(ws, {
    t: 'joined', id: p.id, code: room.code,
    cfg: {
      speed: MOVE_SPEED, radius: PLAYER_RADIUS, tick: TICK_RATE, win: room.win, eye: EYE_HEIGHT,
      shieldCost: SHIELD_COST, scopeMs: SCOPE_MS, scopeCooldownMs: SCOPE_COOLDOWN_MS, shieldMs: SHIELD_MS,
    },
    state: room.state,
  });
  sendMe(p);
  broadcast(room, { t: 'roster', players: roster(room) });
}

function removePlayer(ws) {
  const room = ws.room, p = ws.player;
  if (!room || !p) return;
  room.players.delete(p.id);
  ws.room = null; ws.player = null;
  if (room.players.size === 0) {
    clearInterval(room.timer);
    rooms.delete(room.code);
    console.log(`room ${room.code} closed`);
  } else {
    broadcast(room, { t: 'roster', players: roster(room) });
  }
}

function createRoom(win) {
  const room = { code: makeCode(), players: new Map(), state: 'play', win };
  room.timer = setInterval(() => tick(room), 1000 / TICK_RATE);
  room.nextIncome = Date.now() + INCOME_MS;
  rooms.set(room.code, room);
  console.log(`room ${room.code} created`);
  return room;
}

function tick(room) {
  const now = Date.now();
  for (const p of room.players.values()) {
    // מעבד את הקלטים שהגיעו (כל קלט = טיק תנועה אחד)
    let n = 0;
    while (p.inputs.length && n < MAX_INPUTS_PER_TICK) {
      const inp = p.inputs.shift();
      n++;
      p.ack = inp.seq;
      p.yaw = inp.yaw; p.pitch = inp.pitch;
      if (p.alive && room.state === 'play') applyMove(p, inp.mx, inp.mz, inp.yaw);
    }
    if (p.inputs.length > 30) p.inputs.length = 0; // לקוח מציף - מנקים
    if (!p.alive && room.state === 'play' && now >= p.respawnAt) spawn(room, p);
  }
  if (room.state === 'play' && now >= room.nextIncome) {
    room.nextIncome = now + INCOME_MS;
    for (const p of room.players.values()) { p.money += INCOME; sendMe(p); }
  }
  broadcast(room, {
    t: 's',
    p: [...room.players.values()].map(p => [
      p.id, +p.x.toFixed(3), +p.z.toFixed(3), +p.yaw.toFixed(3), +p.pitch.toFixed(3), p.alive ? 1 : 0, p.ack,
      now < p.shieldUntil ? 1 : 0,
    ]),
  });
}

function handleShoot(room, p, yaw, pitch) {
  const now = Date.now();
  if (room.state !== 'play' || !p.alive || now - p.lastShot < FIRE_COOLDOWN_MS) return;
  p.lastShot = now;
  if (typeof yaw === 'number') p.yaw = yaw;
  if (typeof pitch === 'number') p.pitch = Math.max(-1.4, Math.min(1.4, pitch));

  const dx = -Math.sin(p.yaw) * Math.cos(p.pitch);
  const dy = Math.sin(p.pitch);
  const dz = -Math.cos(p.yaw) * Math.cos(p.pitch);

  // כולם (חוץ מהיורה) מקבלים את מיקום היריה בשביל החץ
  broadcast(room, { t: 'shot', id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2) }, p.id);

  let best = null, bestT = Infinity;
  for (const o of room.players.values()) {
    if (o === p || !o.alive) continue;
    const t = rayHitDistance(p.x, EYE_HEIGHT, p.z, dx, dy, dz, o);
    if (t !== null && t < bestT) { bestT = t; best = o; }
  }
  if (!best) return;

  // המגן בולע את הכדור
  if (now < best.shieldUntil) {
    broadcast(room, { t: 'block', shooter: p.id, target: best.id });
    return;
  }

  best.alive = false;
  best.respawnAt = now + RESPAWN_MS;
  best.scopeUntil = 0;
  p.score++;
  p.money += KILL_REWARD;
  sendMe(p);
  sendMe(best);
  broadcast(room, { t: 'kill', killer: p.id, victim: best.id, respawnMs: RESPAWN_MS });
  broadcast(room, { t: 'roster', players: roster(room) });

  if (p.score >= room.win) {
    room.state = 'over';
    const board = roster(room).sort((a, b) => b.score - a.score);
    broadcast(room, { t: 'over', winner: p.id, board });
  }
}

function restart(room, win) {
  if (room.state !== 'over') return;
  room.state = 'play';
  room.win = cleanWin(win, room.win);
  for (const p of room.players.values()) {
    p.score = 0;
    p.money = 0; p.scopeUntil = 0; p.scopeReadyAt = 0; p.shieldUntil = 0;
    p.alive = false; // כדי ש-spawn יפזר אותם
  }
  room.nextIncome = Date.now() + INCOME_MS;
  for (const p of room.players.values()) { spawn(room, p); sendMe(p); }
  broadcast(room, { t: 'restart', win: room.win });
  broadcast(room, { t: 'roster', players: roster(room) });
}

// ---------- שרת HTTP לקבצים סטטיים ----------
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.webmanifest': 'application/manifest+json',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Three.js מוגש מ-node_modules, כך שלא צריך CDN חיצוני
  let base = PUBLIC_DIR;
  if (urlPath.startsWith('/vendor/three/')) {
    base = THREE_DIR;
    urlPath = urlPath.slice('/vendor/three'.length);
  }
  const filePath = path.join(base, path.normalize(urlPath));
  if (!filePath.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (base === THREE_DIR || ext === '.glb') headers['Cache-Control'] = 'public, max-age=86400';
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const room = ws.room, p = ws.player;

    if (m.t === 'create' && !room) {
      addPlayer(createRoom(cleanWin(m.win, MAX_WIN_SCORE)), ws, cleanName(m.name));
    } else if (m.t === 'join' && !room) {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return send(ws, { t: 'error', msg: 'חדר לא נמצא' });
      if (r.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'החדר מלא (4 שחקנים)' });
      addPlayer(r, ws, cleanName(m.name));
    } else if (m.t === 'in' && p) {
      if (typeof m.seq !== 'number') return;
      p.inputs.push({
        seq: m.seq,
        mx: clamp(+m.mx || 0, -1, 1),
        mz: clamp(+m.mz || 0, -1, 1),
        yaw: +m.yaw || 0,
        pitch: clamp(+m.pitch || 0, -1.4, 1.4),
      });
    } else if (m.t === 'shoot' && p) {
      handleShoot(room, p, m.yaw, m.pitch);
    } else if (m.t === 'power' && p) {
      usePower(room, p, m.kind);
    } else if (m.t === 'restart' && room) {
      restart(room, m.win);
    }
  });
  ws.on('close', () => removePlayer(ws));
});

// ניתוק חיבורים מתים (טלפון שנכבה וכו')
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function cleanWin(w, fallback) {
  w = Math.round(+w);
  return w >= 1 && w <= MAX_WIN_SCORE ? w : fallback;
}
function cleanName(n) {
  n = String(n || '').trim().slice(0, 12);
  return n || 'שחקן';
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

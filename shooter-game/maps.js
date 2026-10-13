// maps.js - יצירת מפות בצד השרת. הלקוח מקבל את המפה כ-JSON.
//
// כל "קיר" הוא תיבה: מרכז (x,z), רוחב w (ציר X המקומי), עומק d, גובה h,
// סיבוב rot (רדיאנים סביב ציר Y, כמו rotation.y ב-Three.js) וסוג type.
// מצבים:
//   bases - זירה מרובעת שמחולקת בקירות גבוהים לבסיס לכל שחקן (2/3/4 בסיסים)
//   open  - מפה ענקית בלי קיר מפריד, מלאה בבניינים, מכולות, עצים וארגזים

// מספרים אקראיים עם seed, כדי שהמפה תהיה זהה לכולם
function rng(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// מרחק מנקודה לתיבה (כולל סיבוב). משמש גם להתנגשות
function distToWall(w, x, z) {
  const dx = x - w.x, dz = z - w.z;
  const c = Math.cos(w.rot || 0), s = Math.sin(w.rot || 0);
  const lx = c * dx - s * dz, lz = s * dx + c * dz;
  const qx = Math.max(Math.abs(lx) - w.w / 2, 0), qz = Math.max(Math.abs(lz) - w.d / 2, 0);
  return Math.hypot(qx, qz);
}
function freeAt(walls, x, z, clearance) {
  for (const w of walls) if (distToWall(w, x, z) < clearance) return false;
  return true;
}

// סיבוב נקודה סביב המרכז בזווית a (במערכת שבה זווית = atan2(z, x))
function rotatePoint(x, z, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - z * s, z: x * s + z * c };
}
function rotateWall(w, a) {
  const p = rotatePoint(w.x, w.z, a);
  return { ...w, x: +p.x.toFixed(3), z: +p.z.toFixed(3), rot: +(((w.rot || 0) - a)).toFixed(4) };
}

function boundaryWalls(W, D, h) {
  return [
    { x: 0, z: -D / 2 - 0.5, w: W + 2, d: 1, h, type: 'boundary' },
    { x: 0, z: D / 2 + 0.5, w: W + 2, d: 1, h, type: 'boundary' },
    { x: -W / 2 - 0.5, z: 0, w: 1, d: D + 2, h, type: 'boundary' },
    { x: W / 2 + 0.5, z: 0, w: 1, d: D + 2, h, type: 'boundary' },
  ];
}

// ---------- מצב בסיסים ----------
const BASE_SIZE = 40;
const BASE_OFFSETS = { 2: 0, 3: Math.PI / 2, 4: 0 }; // 2 = קו ישר, 3 = צורת Y, 4 = פלוס

function sectorOf(map, x, z) {
  const n = map.sectors, step = Math.PI * 2 / n;
  let a = Math.atan2(z, x) - map.sectorOffset;
  a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.floor(a / step) % n;
}

function makeBasesMap(n) {
  const S = BASE_SIZE, half = S / 2, inner = half - 1.5;
  const offset = BASE_OFFSETS[n];
  const step = Math.PI * 2 / n;
  const walls = boundaryWalls(S, S, 3.5);

  // קירות מפרידים: קרניים מהמרכז עד הגבול
  for (let k = 0; k < n; k++) {
    const phi = offset + k * step;
    const cx = Math.cos(phi), cz = Math.sin(phi);
    const L = Math.min(
      Math.abs(cx) > 1e-6 ? half / Math.abs(cx) : Infinity,
      Math.abs(cz) > 1e-6 ? half / Math.abs(cz) : Infinity
    ) + 0.3;
    walls.push({ x: +(cx * L / 2).toFixed(3), z: +(cz * L / 2).toFixed(3), w: +L.toFixed(3), d: 1.2, h: 6, type: 'center', rot: +(-phi).toFixed(4) });
  }
  walls.push({ x: 0, z: 0, w: 2.2, d: 2.2, h: 6.4, type: 'pillar' });

  const separators = walls.slice();
  const R = rng(1000 + n);
  const sectorMid = offset + step / 2;
  const inBounds = (x, z) => Math.abs(x) < inner && Math.abs(z) < inner;
  const awayFromSeparators = (x, z, m) => separators.every(w => distToWall(w, x, z) > m);
  const copies = (list) => {
    const out = [];
    for (let k = 0; k < n; k++) for (const it of list) out.push(rotateWall(it, k * step));
    return out;
  };

  // מכשולים לבסיס הראשון, ואז אותו דבר מסובב לכל בסיס (הוגן לכולם)
  const obstacles = [];
  for (let tries = 0; obstacles.length < 9 && tries < 400; tries++) {
    const r = 5 + R() * 13;
    const a = sectorMid + (R() - 0.5) * step * 0.85;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const kind = R();
    let o;
    if (kind < 0.45) { const s = 1.5 + R() * 0.7; o = { x, z, w: s, d: s, h: s, type: 'crate', rot: R() * Math.PI }; }
    else if (kind < 0.7) o = { x, z, w: 1, d: 1, h: 1.3, type: 'barrel' };
    else o = { x, z, w: 3 + R() * 3, d: 0.8, h: 3, type: 'wall', rot: R() * Math.PI };
    const size = Math.hypot(o.w, o.d) / 2;
    const all = copies([o]);
    const ok = all.every(c => inBounds(c.x, c.z) && awayFromSeparators(c.x, c.z, size + 2)) &&
      copies(obstacles).every(c => all.every(nw => Math.hypot(c.x - nw.x, c.z - nw.z) > size + Math.hypot(c.w, c.d) / 2 + 1.5));
    if (ok) obstacles.push(o);
  }
  walls.push(...copies(obstacles).map(w => ({ ...w, x: +w.x.toFixed(3), z: +w.z.toFixed(3) })));

  // נקודות לידה: לכל בסיס, מסובבות כמו המכשולים
  const spawns0 = [];
  for (let tries = 0; spawns0.length < 6 && tries < 600; tries++) {
    const r = 4 + R() * 14;
    const a = sectorMid + (R() - 0.5) * step * 0.8;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const ok = [0].concat([...Array(n).keys()].slice(1)).every(k => {
      const p = rotatePoint(x, z, k * step);
      return inBounds(p.x, p.z) && freeAt(walls, p.x, p.z, 1.3) && awayFromSeparators(p.x, p.z, 1.8);
    }) && spawns0.every(s => Math.hypot(s.x - x, s.z - z) > 3);
    if (ok) spawns0.push({ x, z });
  }
  const spawns = [];
  for (let k = 0; k < n; k++) for (const s of spawns0) {
    const p = rotatePoint(s.x, s.z, k * step);
    spawns.push({ x: +p.x.toFixed(2), z: +p.z.toFixed(2), sector: k });
  }
  return { mode: 'bases', width: S, depth: S, floor: 'concrete', sectors: n, sectorOffset: offset, walls, spawns };
}

// ---------- מצב מפה ענקית ----------
const OPEN_SIZE = 90;
const CONTAINER_COLORS = ['#2f6db5', '#b5432f', '#3f8f4a', '#d08a22', '#7a4fa0', '#8a8f96'];

function makeOpenMap(seed) {
  const S = OPEN_SIZE, half = S / 2;
  const R = rng(seed);
  const walls = boundaryWalls(S, S, 4);
  const blobs = []; // אזורים תפוסים (עיגולים) כדי שדברים לא ייכנסו אחד בשני
  const place = (radius, margin = 2) => {
    for (let t = 0; t < 200; t++) {
      const x = (R() - 0.5) * (S - 2 * radius - 4), z = (R() - 0.5) * (S - 2 * radius - 4);
      if (blobs.every(b => Math.hypot(b.x - x, b.z - z) > b.r + radius + margin)) {
        blobs.push({ x, z, r: radius });
        return { x, z };
      }
    }
    return null;
  };
  const local = (cx, cz, rot, lx, lz) => { // נקודה מקומית של בניין -> עולם
    const c = Math.cos(rot), s = Math.sin(rot);
    return { x: cx + c * lx + s * lz, z: cz - s * lx + c * lz };
  };

  // בניינים: 4 קירות עם פתחים לדלתות (בלי גג)
  for (let i = 0; i < 9; i++) {
    const bw = 8 + R() * 5, bd = 7 + R() * 4, t = 0.4, h = 3.2;
    const rot = Math.floor(R() * 4) * Math.PI / 2;
    const p = place(Math.hypot(bw, bd) / 2, 3);
    if (!p) continue;
    const door = 2.2;
    const sides = [
      { lx: 0, lz: -bd / 2, len: bw, along: 'x' }, { lx: 0, lz: bd / 2, len: bw, along: 'x' },
      { lx: -bw / 2, lz: 0, len: bd, along: 'z' }, { lx: bw / 2, lz: 0, len: bd, along: 'z' },
    ];
    const doors = new Set([Math.floor(R() * 4), Math.floor(R() * 4)]);
    sides.forEach((sd, idx) => {
      const segs = doors.has(idx)
        ? [{ o: -(sd.len + door) / 4, l: (sd.len - door) / 2 }, { o: (sd.len + door) / 4, l: (sd.len - door) / 2 }]
        : [{ o: 0, l: sd.len }];
      for (const sg of segs) {
        const lx = sd.along === 'x' ? sd.lx + sg.o : sd.lx;
        const lz = sd.along === 'z' ? sd.lz + sg.o : sd.lz;
        const q = local(p.x, p.z, rot, lx, lz);
        walls.push({
          x: q.x, z: q.z, w: sd.along === 'x' ? sg.l + t : t, d: sd.along === 'x' ? t : sg.l + t, h,
          type: 'wall', rot,
        });
      }
    });
    // ארגז בתוך הבניין
    const q = local(p.x, p.z, rot, (R() - 0.5) * (bw - 4), (R() - 0.5) * (bd - 4));
    walls.push({ x: q.x, z: q.z, w: 1.5, d: 1.5, h: 1.5, type: 'crate', rot: R() * Math.PI });
  }
  // מכולות
  for (let i = 0; i < 16; i++) {
    const p = place(3.4);
    if (!p) continue;
    walls.push({ x: p.x, z: p.z, w: 6, d: 2.4, h: 2.6, type: 'container', rot: R() * Math.PI, color: CONTAINER_COLORS[Math.floor(R() * CONTAINER_COLORS.length)] });
  }
  // קבוצות ארגזים
  for (let i = 0; i < 16; i++) {
    const p = place(2.5);
    if (!p) continue;
    const count = 2 + Math.floor(R() * 3);
    for (let k = 0; k < count; k++) {
      const s = 1.2 + R() * 0.9;
      walls.push({ x: p.x + (R() - 0.5) * 3, z: p.z + (R() - 0.5) * 3, w: s, d: s, h: s, type: 'crate', rot: R() * Math.PI });
    }
  }
  // חומות נמוכות (שקי חול)
  for (let i = 0; i < 12; i++) {
    const p = place(2.6);
    if (!p) continue;
    walls.push({ x: p.x, z: p.z, w: 4 + R() * 2, d: 0.9, h: 1.2, type: 'sandbag', rot: R() * Math.PI });
  }
  // חביות
  for (let i = 0; i < 26; i++) {
    const p = place(0.7, 1.5);
    if (!p) continue;
    walls.push({ x: p.x, z: p.z, w: 1, d: 1, h: 1.3, type: 'barrel' });
  }
  // עצים
  for (let i = 0; i < 40; i++) {
    const p = place(1.4, 1.2);
    if (!p) continue;
    walls.push({ x: p.x, z: p.z, w: 0.7, d: 0.7, h: 6 + R() * 3, type: 'tree' });
  }
  for (const w of walls) { w.x = +w.x.toFixed(3); w.z = +w.z.toFixed(3); if (w.rot) w.rot = +w.rot.toFixed(4); }

  // נקודות לידה בכל המפה
  const spawns = [];
  for (let t = 0; spawns.length < 32 && t < 3000; t++) {
    const x = (R() - 0.5) * (S - 6), z = (R() - 0.5) * (S - 6);
    if (freeAt(walls, x, z, 1.5) && spawns.every(s => Math.hypot(s.x - x, s.z - z) > 5)) spawns.push({ x: +x.toFixed(2), z: +z.toFixed(2) });
  }
  return { mode: 'open', width: S, depth: S, floor: 'grass', walls, spawns };
}

module.exports = { makeBasesMap, makeOpenMap, distToWall, sectorOf };

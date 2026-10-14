// poker.js - שרת פוקר טקסס הולדם לחברים: חדרים פרטיים עם קוד, השרת מחזיק את הקלפים
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MAX_SEATS = 6;
const TURN_MS = 30000;            // זמן לתור
const AWAY_TURN_MS = 10000;       // שחקן מנותק מקבל פחות זמן
const NEXT_HAND_MS = +process.env.POKER_NEXT_MS || 6000;        // הפסקה בין ידיים
const STREET_MS = +process.env.POKER_STREET_MS || 800;            // השהיה לפני חשיפת קלפים על השולחן
const ROOM_IDLE_MS = 15 * 60 * 1000;
const HANDS_PER_LEVEL = 10;
const BLINDS = [[5, 10], [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [250, 500], [500, 1000]];
const CHIP_OPTIONS = [500, 1000, 2500, 5000];

// ---------- קלפים והערכת ידיים ----------
const SUITS = ['s', 'h', 'd', 'c'];
const RN = { 2: 'שתיים', 3: 'שלוש', 4: 'ארבע', 5: 'חמש', 6: 'שש', 7: 'שבע', 8: 'שמונה', 9: 'תשע', 10: 'עשר', 11: 'נסיכים', 12: 'מלכות', 13: 'מלכים', 14: 'אסים' };
const RN1 = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'נסיך', 12: 'מלכה', 13: 'מלך', 14: 'אס' };

function newDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ r, s, id: r + s });
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function score5(c) {
  const rs = c.map(x => x.r).sort((a, b) => b - a);
  const flush = c.every(x => x.s === c[0].s);
  const cnt = {};
  for (const r of rs) cnt[r] = (cnt[r] || 0) + 1;
  const g = Object.keys(cnt).map(r => [cnt[r], +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let sh = 0;
  if (g.length === 5) {
    if (rs[0] - rs[4] === 4) sh = rs[0];
    else if (rs[0] === 14 && rs[1] === 5) sh = 5;
  }
  let cat, k;
  if (sh && flush) { cat = 8; k = [sh]; }
  else if (g[0][0] === 4) { cat = 7; k = [g[0][1], g[1][1]]; }
  else if (g[0][0] === 3 && g[1][0] === 2) { cat = 6; k = [g[0][1], g[1][1]]; }
  else if (flush) { cat = 5; k = rs; }
  else if (sh) { cat = 4; k = [sh]; }
  else if (g[0][0] === 3) { cat = 3; k = g.map(x => x[1]); }
  else if (g[0][0] === 2 && g[1][0] === 2) { cat = 2; k = g.map(x => x[1]); }
  else if (g[0][0] === 2) { cat = 1; k = g.map(x => x[1]); }
  else { cat = 0; k = rs; }
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 15 + (k[i] || 0);
  return v;
}
function best(cards) {
  let bs = -1, bc = null;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const h = [cards[a], cards[b], cards[c], cards[d], cards[e]];
      const s = score5(h);
      if (s > bs) { bs = s; bc = h; }
    }
  return { score: bs, cards: bc, cat: Math.floor(bs / 759375) };
}
function handName(b) {
  const k = [];
  let v = b.score;
  for (let i = 0; i < 5; i++) { k.unshift(v % 15); v = Math.floor(v / 15); }
  switch (b.cat) {
    case 8: return k[0] === 14 ? 'רויאל פלאש' : 'רצף צבע';
    case 7: return 'רביעיית ' + RN[k[0]];
    case 6: return 'פול האוס';
    case 5: return 'צבע';
    case 4: return 'רצף עד ' + RN1[k[0]];
    case 3: return 'שלישיית ' + RN[k[0]];
    case 2: return 'שני זוגות';
    case 1: return 'זוג ' + RN[k[0]];
    default: return 'קלף גבוה ' + RN1[k[0]];
  }
}

// ---------- בוטים ----------
const BOT_NAMES = ['רובי', 'צ\'יפ', 'מקס', 'לולו', 'ביפ', 'טורבו', 'נינג\'ה'];
const BOT_THINK_MS = [700, 1600];

function equity(hole, board, nOpp, iters) {
  const used = new Set(hole.concat(board).map(c => c.id));
  const rest = newDeck().filter(c => !used.has(c.id));
  const need = 5 - board.length + 2 * nOpp;
  let won = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (rest.length - i));
      const t = rest[i]; rest[i] = rest[j]; rest[j] = t;
    }
    const b = board.concat(rest.slice(0, 5 - board.length));
    const my = best(hole.concat(b)).score;
    let lost = false, ties = 0, k = 5 - board.length;
    for (let o = 0; o < nOpp; o++) {
      const s = best([rest[k], rest[k + 1]].concat(b)).score;
      k += 2;
      if (s > my) { lost = true; break; }
      if (s === my) ties++;
    }
    if (!lost) won += 1 / (ties + 1);
  }
  return won / iters;
}

// החלטת בוט לפי סיכויי הניצחון שלו מול השחקנים שנשארו ביד
function botDecide(room, p) {
  const opp = live(room).length - 1;
  const eq = equity(p.hand, room.board, opp, room.board.length === 0 ? 160 : 220);
  const toCall = Math.min(room.currentBet - p.bet, p.chips);
  const pot = potTotal(room);
  const odds = toCall / (pot + toCall || 1);
  const rel = eq * (opp + 1);
  const agg = p.agg, r = Math.random();
  const stack = p.chips + p.bet;
  const raiseTo = frac => {
    let to = room.currentBet + Math.max(room.minRaise, Math.round(pot * frac / room.bb) * room.bb);
    if (to >= stack * 0.7) to = stack;
    return { a: 'raise', to };
  };
  if (eq > 0.82 && opp <= 2 && r < 0.35 * agg) return { a: 'raise', to: stack };
  if (toCall <= 0) {
    if (rel * agg > 1.45 && r < 0.75) return raiseTo(0.45 + Math.random() * 0.45);
    if (r < 0.07 * agg + 0.05 * p.loose) return raiseTo(0.5);
    return { a: 'call' };
  }
  const bigBet = toCall > p.chips * 0.5;
  if (rel * agg > 2.0 && r < 0.55 && !bigBet) return raiseTo(0.6 + Math.random() * 0.5);
  if (bigBet && eq < 0.5 && rel < 1.6) return { a: 'fold' };
  if (eq >= odds * (1.05 - 0.2 * p.loose)) return { a: 'call' };
  if (room.board.length === 0 && toCall <= room.bb && rel > 0.75) return { a: 'call' };
  if (r < 0.04 * agg && toCall < pot * 0.4) return { a: 'call' };
  return { a: 'fold' };
}

function addBot(room) {
  if (room.players.filter(q => !q.left).length >= MAX_SEATS) return;
  const used = new Set(room.players.map(q => q.name));
  const name = BOT_NAMES.find(n => !used.has(n)) || 'בוט ' + (room.players.length + 1);
  room.players.push({
    id: nextId++, bot: true, ws: null, name, connected: true,
    agg: 0.75 + Math.random() * 0.6, loose: Math.random(),
    chips: room.startChips, hand: [], bet: 0, total: 0, folded: true, allIn: false,
    out: room.state === 'over', left: false, revealed: false, last: '', lastCls: '', waiting: room.state !== 'lobby' && room.state !== 'over',
  });
}
const humansOnline = room => room.players.some(q => !q.bot && !q.left && q.connected);

// ---------- חדרים ----------
const rooms = new Map(); // code -> room
let nextId = 1;

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // בלי I ו-O כדי לא להתבלבל
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(chips) {
  const room = {
    code: makeCode(), players: [], hostId: 0, state: 'lobby',
    startChips: CHIP_OPTIONS.includes(+chips) ? +chips : 1000,
    handNo: 0, dealer: -1, sb: 5, bb: 10, board: [], deck: [], pot: 0,
    currentBet: 0, minRaise: 0, toAct: -1, need: new Set(), busy: false,
    turnEndsAt: 0, turnTimer: null, stepTimer: null, handId: 0,
    result: null, winnerId: 0, lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  console.log(`poker room ${room.code} created`);
  return room;
}

function addPlayer(room, ws, name) {
  const p = {
    id: nextId++, token: crypto.randomBytes(12).toString('hex'), ws, name,
    connected: true, chips: room.startChips, hand: [], bet: 0, total: 0,
    folded: true, allIn: false, out: false, left: false, revealed: false,
    last: '', lastCls: '', waiting: room.state !== 'lobby',
  };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  bind(ws, room, p);
  return p;
}

function bind(ws, room, p) {
  if (p.ws && p.ws !== ws) { p.ws.room = null; p.ws.player = null; try { p.ws.close(); } catch { } }
  p.ws = ws; p.connected = true;
  ws.room = room; ws.player = p;
  send(ws, { t: 'joined', code: room.code, id: p.id, token: p.token });
}

function removePlayer(room, p) {
  p.left = true; p.connected = false;
  if (room.state === 'hand') {
    // באמצע יד: השחקן מקפל ויוצא בסוף היד
    const idx = room.players.indexOf(p);
    if (!p.folded) { p.folded = true; say(p, 'יצא', 'fold'); }
    room.need.delete(p.id);
    if (room.toAct === idx) { clearTurn(room); room.toAct = -1; proceed(room, idx + 1); }
    else if (live(room).length <= 1 && !room.busy) finishHand(room);
  } else {
    dropPlayer(room, p);
  }
  if (room.hostId === p.id) {
    const h = room.players.find(q => !q.left && !q.bot);
    room.hostId = h ? h.id : 0;
  }
  if (!room.players.some(q => !q.left && !q.bot)) return closeRoom(room);
  broadcastState(room);
}

function dropPlayer(room, p) {
  const i = room.players.indexOf(p);
  if (i < 0) return;
  room.players.splice(i, 1);
  if (room.dealer >= i) room.dealer--;
}

function closeRoom(room) {
  clearTurn(room);
  clearTimeout(room.stepTimer);
  rooms.delete(room.code);
  console.log(`poker room ${room.code} closed`);
}

// ---------- עזרי מצב ----------
const canAct = p => !p.folded && !p.out && !p.allIn;
const live = room => room.players.filter(p => !p.folded && !p.out);
function nextIdx(room, i, pred) {
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (((i + k) % n) + n) % n;
    if (pred(room.players[j])) return j;
  }
  return -1;
}
function say(p, text, cls = '') { p.last = text; p.lastCls = cls; }
function put(p, a) {
  a = Math.max(0, Math.min(a, p.chips));
  p.chips -= a; p.bet += a; p.total += a;
  if (!p.chips) p.allIn = true;
}
function potTotal(room) { return room.pot + room.players.reduce((s, p) => s + p.bet, 0); }

// ---------- מהלך יד ----------
function startGame(room) {
  if (room.state === 'hand') return;
  const seated = room.players.filter(p => !p.left);
  if (seated.length < 2) return;
  if (room.state === 'over' || room.state === 'lobby') {
    for (const p of seated) { p.chips = room.startChips; p.out = false; p.waiting = false; }
    room.handNo = 0; room.dealer = -1; room.winnerId = 0;
  }
  startHand(room);
}

function startHand(room) {
  clearTurn(room);
  clearTimeout(room.stepTimer);
  for (const p of [...room.players]) if (p.left) dropPlayer(room, p);
  const P = room.players;
  for (const p of P) {
    p.waiting = false;
    p.out = p.chips <= 0;
    p.hand = []; p.bet = 0; p.total = 0; p.allIn = false; p.revealed = false;
    p.folded = p.out; say(p, '');
  }
  const alive = P.filter(p => !p.out);
  if (alive.length < 2) {
    room.state = 'over';
    room.winnerId = alive[0] ? alive[0].id : 0;
    room.toAct = -1;
    return broadcastState(room);
  }
  room.state = 'hand';
  room.handId++;
  room.handNo++;
  [room.sb, room.bb] = BLINDS[Math.min(BLINDS.length - 1, Math.floor((room.handNo - 1) / HANDS_PER_LEVEL))];
  room.board = []; room.pot = 0; room.result = null; room.busy = false;
  room.deck = shuffle(newDeck());
  const notOut = p => !p.out;
  room.dealer = nextIdx(room, room.dealer < 0 ? crypto.randomInt(P.length) - 1 : room.dealer, notOut);
  let sbI, bbI;
  if (alive.length === 2) { sbI = room.dealer; bbI = nextIdx(room, sbI, notOut); }
  else { sbI = nextIdx(room, room.dealer, notOut); bbI = nextIdx(room, sbI, notOut); }
  put(P[sbI], room.sb); say(P[sbI], 'סמול');
  put(P[bbI], room.bb); say(P[bbI], 'ביג');
  for (let r = 0; r < 2; r++) for (const p of alive) p.hand.push(room.deck.pop());
  room.currentBet = room.bb;
  room.minRaise = room.bb;
  room.need = new Set(P.filter(canAct).map(p => p.id));
  proceed(room, bbI + 1);
}

// מוצא את השחקן הבא שצריך לפעול, או מסיים את הסיבוב
function proceed(room, fromIdx) {
  if (live(room).length <= 1) return finishHand(room);
  const P = room.players, n = P.length;
  for (let k = 0; k < n; k++) {
    const idx = (fromIdx + k) % n, p = P[idx];
    if (!room.need.has(p.id)) continue;
    if (!canAct(p)) { room.need.delete(p.id); continue; }
    if (P.filter(canAct).length === 1 && p.bet >= room.currentBet) { room.need.delete(p.id); continue; }
    room.toAct = idx;
    startTurn(room, p);
    return broadcastState(room);
  }
  endStreet(room);
}

function startTurn(room, p) {
  clearTurn(room);
  const hid = room.handId;
  if (p.bot) {
    const ms = BOT_THINK_MS[0] + Math.random() * (BOT_THINK_MS[1] - BOT_THINK_MS[0]);
    room.turnEndsAt = 0;
    room.turnTimer = setTimeout(() => {
      if (room.handId !== hid || room.players[room.toAct] !== p) return;
      act(room, p, botDecide(room, p));
    }, ms);
    return;
  }
  const ms = p.connected ? TURN_MS : AWAY_TURN_MS;
  room.turnEndsAt = Date.now() + ms;
  room.turnTimer = setTimeout(() => {
    if (room.handId !== hid || room.players[room.toAct] !== p) return;
    // נגמר הזמן: צ'ק אם אפשר, אחרת פולד
    act(room, p, { a: room.currentBet > p.bet ? 'fold' : 'call' });
  }, ms);
}
function clearTurn(room) { clearTimeout(room.turnTimer); room.turnTimer = null; room.turnEndsAt = 0; }

function act(room, p, m) {
  if (room.state !== 'hand' || room.busy) return;
  const idx = room.players.indexOf(p);
  if (idx !== room.toAct) return;
  clearTurn(room);
  const toCall = room.currentBet - p.bet;
  let raised = false;
  if (m.a === 'fold') {
    p.folded = true; say(p, 'פולד', 'fold');
  } else if (m.a === 'raise' && p.chips > toCall) {
    const minTo = Math.min(room.currentBet + Math.max(room.minRaise, room.bb), p.bet + p.chips);
    const to = Math.max(minTo, Math.min(Math.round(+m.to || 0), p.bet + p.chips));
    put(p, to - p.bet);
    if (p.bet > room.currentBet) {
      const inc = p.bet - room.currentBet, wasBet = room.currentBet === 0;
      if (inc >= room.minRaise) room.minRaise = inc;
      room.currentBet = p.bet;
      say(p, p.allIn ? 'אול-אין' : (wasBet ? 'הימור ' : 'העלאה ל-') + p.bet, p.allIn ? 'allin' : 'raise');
      raised = true;
    } else say(p, p.allIn ? 'אול-אין' : 'קול', p.allIn ? 'allin' : '');
  } else {
    put(p, toCall);
    if (toCall <= 0) say(p, "צ'ק");
    else say(p, p.allIn ? 'אול-אין' : 'קול ' + p.bet, p.allIn ? 'allin' : '');
  }
  room.need.delete(p.id);
  if (raised) room.need = new Set(room.players.filter(q => canAct(q) && q !== p).map(q => q.id));
  room.toAct = -1;
  proceed(room, idx + 1);
}

function collectBets(room) {
  for (const p of room.players) { room.pot += p.bet; p.bet = 0; }
}

function endStreet(room) {
  room.toAct = -1;
  collectBets(room);
  if (room.board.length === 5) return showdown(room);
  const runout = room.players.filter(canAct).length <= 1;
  if (runout) for (const p of live(room)) p.revealed = true;
  room.busy = true;
  broadcastState(room);
  const hid = room.handId;
  room.stepTimer = setTimeout(() => {
    if (room.handId !== hid || !rooms.has(room.code)) return;
    room.busy = false;
    room.deck.pop(); // שריפה
    const n = room.board.length === 0 ? 3 : 1;
    for (let k = 0; k < n; k++) room.board.push(room.deck.pop());
    for (const p of room.players) if (!p.folded && !p.allIn) say(p, '');
    if (runout) return endStreet(room);
    room.currentBet = 0;
    room.minRaise = room.bb;
    room.need = new Set(room.players.filter(canAct).map(p => p.id));
    proceed(room, room.dealer + 1);
  }, runout ? STREET_MS * 1.6 : STREET_MS);
}

function finishHand(room) {
  clearTurn(room);
  room.toAct = -1;
  collectBets(room);
  const L = live(room);
  const w = L[0];
  const amt = room.pot;
  if (w) w.chips += amt;
  room.pot = 0;
  room.result = { winners: w ? [{ id: w.id, amount: amt, hand: '', cards: [] }] : [], showdown: false };
  scheduleNext(room);
}

function showdown(room) {
  clearTurn(room);
  room.toAct = -1;
  const P = room.players, L = live(room);
  for (const p of L) { p.revealed = true; p.best = best(p.hand.concat(room.board)); }
  // קופות צד
  const levels = [...new Set(P.filter(p => p.total > 0).map(p => p.total))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const lv of levels) {
    let amt = 0;
    for (const p of P) amt += Math.max(0, Math.min(p.total, lv) - prev);
    const elig = L.filter(p => p.total >= lv);
    const key = elig.map(p => p.id).join(',');
    if (elig.length) {
      const last = pots[pots.length - 1];
      if (last && last.key === key) last.amt += amt; else pots.push({ amt, elig, key });
    } else if (pots.length) pots[pots.length - 1].amt += amt;
    prev = lv;
  }
  const pays = new Map();
  for (const pt of pots) {
    const top = Math.max(...pt.elig.map(p => p.best.score));
    const ws = pt.elig.filter(p => p.best.score === top);
    const share = Math.floor(pt.amt / ws.length);
    let rem = pt.amt - share * ws.length;
    const order = [];
    for (let k = 1; k <= P.length; k++) { const q = P[(room.dealer + k) % P.length]; if (ws.includes(q)) order.push(q); }
    for (const w of order) { pays.set(w, (pays.get(w) || 0) + share + (rem > 0 ? 1 : 0)); if (rem > 0) rem--; }
  }
  for (const [w, amt] of pays) w.chips += amt;
  room.pot = 0;
  for (const p of L) say(p, pays.has(p) ? handName(p.best) : '', pays.has(p) ? 'raise' : '');
  room.result = {
    showdown: true,
    winners: [...pays.entries()].map(([w, amount]) => ({ id: w.id, amount, hand: handName(w.best), cards: w.best.cards.map(c => c.id) })),
    hands: L.map(p => ({ id: p.id, hand: handName(p.best) })),
  };
  scheduleNext(room);
}

function scheduleNext(room) {
  room.busy = true;
  room.state = 'result';
  for (const p of room.players) if (p.chips <= 0) p.out = true;
  broadcastState(room);
  const hid = room.handId;
  room.stepTimer = setTimeout(() => {
    if (room.handId !== hid || !rooms.has(room.code)) return;
    room.busy = false;
    // כשאף שחקן אמיתי לא מחובר, הבוטים מחכים במקום לשחק לבד
    if (!humansOnline(room)) { room.paused = true; return; }
    startHand(room);
  }, NEXT_HAND_MS);
}

// ---------- שליחת מצב (כל שחקן רואה רק את הקלפים שלו) ----------
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function viewFor(room, me) {
  const inHand = room.state === 'hand' || room.state === 'result';
  return {
    t: 'state', code: room.code, you: me.id, host: room.hostId, state: room.state,
    handNo: room.handNo, sb: room.sb, bb: room.bb, dealer: room.dealer, toAct: room.toAct,
    turnLeft: room.turnEndsAt ? Math.max(0, room.turnEndsAt - Date.now()) : 0, turnMs: TURN_MS,
    pot: room.pot, currentBet: room.currentBet, minRaise: Math.max(room.minRaise, room.bb),
    board: room.board, startChips: room.startChips, winnerId: room.winnerId,
    result: room.state === 'result' ? room.result : null,
    players: room.players.filter(p => !p.left || inHand).map(p => ({
      id: p.id, name: p.name, bot: !!p.bot, chips: p.chips, bet: p.bet, folded: p.folded, allIn: p.allIn,
      out: p.out, waiting: p.waiting, connected: p.connected && !p.left, last: p.last, lastCls: p.lastCls,
      nCards: p.hand.length,
      cards: (p === me || p.revealed) ? p.hand : null,
    })),
  };
}
function broadcastState(room) {
  for (const p of room.players) if (p.connected && !p.bot) send(p.ws, viewFor(room, p));
}

// ---------- WebSocket ----------
function cleanName(n) {
  n = String(n || '').replace(/[<>]/g, '').trim().slice(0, 12);
  return n || 'שחקן';
}

function createPokerWss() {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      const room = ws.room, p = ws.player;
      if (room) room.lastActive = Date.now();

      if (m.t === 'create' && !room) {
        const r = createRoom(m.chips);
        addPlayer(r, ws, cleanName(m.name));
        const nb = Math.max(0, Math.min(MAX_SEATS - 1, Math.round(+m.bots || 0)));
        for (let i = 0; i < nb; i++) addBot(r);
        if (nb && m.autostart) startGame(r); else broadcastState(r);
      } else if (m.t === 'join' && !room) {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'error', msg: 'לא מצאנו חדר עם הקוד הזה' });
        if (r.players.filter(q => !q.left).length >= MAX_SEATS) return send(ws, { t: 'error', msg: 'השולחן מלא (6 שחקנים)' });
        const np = addPlayer(r, ws, cleanName(m.name));
        if (r.state === 'over') { np.out = true; }
        broadcastState(r);
      } else if (m.t === 'rejoin' && !room) {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        const q = r && r.players.find(x => x.token === m.token && !x.left);
        if (!q) return send(ws, { t: 'gone' });
        bind(ws, r, q);
        if (r.paused) { r.paused = false; startHand(r); return; }
        if (r.state === 'hand' && r.players[r.toAct] === q) startTurn(r, q);
        broadcastState(r);
      } else if (m.t === 'addBot' && p && room.hostId === p.id) {
        addBot(room);
        broadcastState(room);
      } else if (m.t === 'removeBot' && p && room.hostId === p.id && room.state !== 'hand' && room.state !== 'result') {
        const b = room.players.find(q => q.bot && q.id === m.id);
        if (b) { dropPlayer(room, b); broadcastState(room); }
      } else if (m.t === 'start' && p && room.hostId === p.id) {
        startGame(room);
      } else if (m.t === 'act' && p) {
        act(room, p, m);
      } else if (m.t === 'leave' && p) {
        ws.room = null; ws.player = null;
        removePlayer(room, p);
      }
    });
    ws.on('close', () => {
      const room = ws.room, p = ws.player;
      if (!room || !p || p.ws !== ws) return;
      p.connected = false;
      // תורו של שחקן שהתנתק: מקצרים את הזמן
      if (room.state === 'hand' && room.players[room.toAct] === p && room.turnEndsAt - Date.now() > AWAY_TURN_MS) startTurn(room, p);
      broadcastState(room);
    });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const room of rooms.values()) {
      if (!humansOnline(room) && now - room.lastActive > ROOM_IDLE_MS) closeRoom(room);
    }
  }, 10000);

  return wss;
}

module.exports = { createPokerWss, _test: { best, handName, score5 } };

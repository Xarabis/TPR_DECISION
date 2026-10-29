/* DECISION / 01 — «Подземелье»: сервер игры для зала.
   Без зависимостей: только встроенные модули Node.js. Запуск: node server.js
   Всё хранится в памяти: закрыл окно сервера — имена и баланс исчезли. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');   // адрес туннеля, если он есть
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(4).toString('hex');
const DIR = __dirname;

/* числа сюжета: этаж 1 → 2 → 3 → сундук */
const LOOT = [100, 150, 300];       // золото в руках на этаже
const CHANCE = [80, 60, 20];        // шанс пройти дальше, %
const NEXT = [150, 300, 1200];      // что будет в руках после прохода
// Обратная индукция пересчитывает ценность игры с учётом ЛИЧНОГО возврата из лифта.
// После спуска игрок сохраняет 150 золота и может забрать их на первом этаже.
const LIFT_FLOOR = 2, LIFT_UP = 70;
const V3 = Math.max(LOOT[2], CHANCE[2] / 100 * NEXT[2]);   // 300
const STAIRS_EV = CHANCE[1] / 100 * V3;                    // 180
const V1_SOLO = Math.max(LOOT[1], CHANCE[0] / 100 * Math.max(LOOT[1], STAIRS_EV)); // 150
const V3_FROM_LIFT = Math.max(LOOT[1], CHANCE[2] / 100 * NEXT[2]); // 240: на этаже 3 после лифта в руках 150
const LIFT_EV = Math.round(10 * (LIFT_UP / 100 * V3_FROM_LIFT + (1 - LIFT_UP / 100) * V1_SOLO)) / 10; // 213
const THEORY = Math.round(10 * Math.max(LOOT[0], CHANCE[0] / 100 * Math.max(LOOT[1], STAIRS_EV, LIFT_EV))) / 10; // 170,4

const G = { phase: 'lobby', round: 0, players: new Map(), stats: null };
const clients = new Set();           // { res, pid, host }

/* ---------- вспомогательное ---------- */
function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f<>&"'`]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 14).join('');
}
function uniqueName(base) {
  const taken = new Set([...G.players.values()].map(p => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) { const n = Array.from(base).slice(0, 12).join('') + ' ' + i; if (!taken.has(n.toLowerCase())) return n; }
  return base + Math.floor(Math.random() * 1000);
}
const playing = () => [...G.players.values()].filter(p => !p.spectator);
const active = () => playing().filter(p => p.active);
// Лифт отправляет конкретного участника в независимую мини-ветку.
// Общие этапы не ждут выбора игрока в мини-ветке и не сбрасываются.
const activeGlobal = () => active().filter(p => !p.detour);
const activeDetours = () => active().filter(p => p.detour);


function rank() {
  const arr = playing().slice().sort((a, b) => b.banked - a.banked || a.name.localeCompare(b.name, 'ru'));
  let r = 0, prev = null;
  arr.forEach((p, i) => { if (p.banked !== prev) { r = i + 1; prev = p.banked; } p.rank = r; });
  return arr;
}

/* ---------- состояние для клиентов ---------- */
function view(pid) {
  const showChoice = G.phase === 'closed' || G.phase === 'revealed' || G.phase === 'final';
  const showResult = G.phase === 'revealed' || G.phase === 'final';
  const r = G.round;
  const ps = [...G.players.values()].map(p => ({
    id: p.pub, n: p.name, sp: p.spectator ? 1 : 0, a: p.active ? 1 : 0, d: p.dead ? 1 : 0, det: p.active && p.detour ? 1 : 0,
    v: p.choice ? 1 : 0, g: p.gold,
    c: showChoice ? p.choice : undefined, au: showChoice && p.auto ? 1 : 0,
    res: showResult && p.last && p.last.round === r ? { roll: p.last.roll, pass: p.last.pass, ch: p.last.choice, up: p.last.up } : undefined,
    b: (showResult || G.phase === 'final') ? p.banked : undefined,
  }));
  const cnt = { take: 0, go: 0, lift: 0, voted: 0, total: activeGlobal().length, detours: activeDetours().length };
  activeGlobal().forEach(p => { if (p.choice) cnt.voted++; if (showChoice && p.choice === 'take') cnt.take++; if (showChoice && p.choice === 'go') cnt.go++; if (showChoice && p.choice === 'lift') cnt.lift++; });
  const v = {
    phase: G.phase, round: r, rounds: 3,
    floor: r ? { hand: LOOT[r - 1], chance: CHANCE[r - 1], next: NEXT[r - 1], last: r === 3, lift: r === LIFT_FLOOR, ch1: CHANCE[0] } : null,
    players: ps, counts: cnt, theory: THEORY,
  };
  if (G.phase === 'final' && G.stats) v.final = G.stats;
  if (pid) {
    const p = G.players.get(pid);
    if (p) {
      v.me = {
        id: p.pub, name: p.name, spectator: p.spectator, active: p.active, dead: p.dead, gold: p.gold, floor: p.floor,
        choice: p.choice, auto: p.auto, last: showResult ? p.last : null,
        banked: (showResult || !p.active || G.phase === 'final') ? p.banked : null,
        hist: p.hist, detour: p.detour ? { ...p.detour } : null,
      };
      if (G.phase === 'final') { rank(); v.me.rank = p.spectator ? null : p.rank; v.me.total = playing().length; }
    }
  }
  return v;
}
function send(c, v) { try { c.res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch (e) { clients.delete(c); } }
function broadcast() { clients.forEach(c => send(c, view(c.pid))); }

/* ---------- игровая логика ---------- */
function openRound() {
  G.round += 1; G.phase = 'open';
  activeGlobal().forEach(p => { p.choice = null; p.auto = false; p.last = null; });
}
function closeVoting() {
  G.phase = 'closed';
  activeGlobal().forEach(p => { if (!p.choice) { p.choice = 'take'; p.auto = true; } });
}
function reveal() {
  const r = G.round;
  activeGlobal().forEach(p => {
    if (p.choice === 'take') {
      p.banked = p.gold; p.active = false;
      p.last = { round: r, choice: 'take', roll: null, pass: null, gold: p.gold };
    } else if (p.choice === 'lift') {
      const roll = crypto.randomInt(100), up = roll < LIFT_UP;
      p.lift = up ? 'up' : 'down';
      if (up) {
        p.floor = r + 1;                                   // золото при нём, идёт на этаж 3
        p.last = { round: r, choice: 'lift', roll, up: true, gold: p.gold };
      } else {
        // Реальный возврат на этаж 1 только для этого игрока — без автопоражения.
        // 150 золота сохраняются: лифт действительно не сжигает добычу.
        // Игрок сам проходит этажи 1 → 2 → 3 на своём телефоне.
        p.floor = 1;
        p.detour = { stage: 'arrival', floor: 1, roll, up: false, hand: p.gold };
        p.last = { round: r, choice: 'lift', roll, up: false, gold: p.gold };
      }
    } else {
      const roll = crypto.randomInt(100), pass = roll < CHANCE[r - 1];
      if (pass) {
        p.gold = NEXT[r - 1]; p.floor = r + 1;
        if (r === 3) { p.banked = p.gold; p.active = false; }
      } else { p.banked = 0; p.gold = 0; p.active = false; p.dead = true; }
      p.last = { round: r, choice: 'go', roll, pass, gold: p.gold };
    }
    p.hist.push(p.last);
  });
  G.phase = 'revealed';
}
// Личная ветка после неудачного лифта. Команды выполняет только владелец pid.
function stepDetour(p, action) {
  const d = p.detour;
  if (!d || !p.active) return 'inactive';
  if (d.stage === 'arrival') {
    if (action !== 'begin') return 'action';
    p.detour = { stage: 'choose', floor: 1, hand: p.gold };
    return 'ok';
  }
  if (d.stage === 'result') {
    if (action !== 'next') return 'action';
    p.detour = { stage: 'choose', floor: p.floor, hand: p.gold };
    return 'ok';
  }
  if (d.stage !== 'choose') return 'action';
  const floor = d.floor;
  if (action === 'take') {
    p.banked = p.gold;
    p.active = false;
    p.detour = { stage: 'done', floor, outcome: 'take', hand: p.gold };
    p.hist.push({ round: 'solo-' + floor, choice: 'take', gold: p.gold });
    return 'ok';
  }
  if (action !== 'go') return 'action';
  const roll = crypto.randomInt(100), pass = roll < CHANCE[floor - 1];
  if (pass) {
    // На первом этаже не отнимаем принесённые из лифта 150 золотых.
    p.gold = Math.max(p.gold, NEXT[floor - 1]);
    p.floor = floor + 1;
    if (floor === 3) {
      p.banked = p.gold;
      p.active = false;
      p.detour = { stage: 'done', floor, roll, pass: true, outcome: 'chest', hand: p.gold };
    } else {
      p.detour = { stage: 'result', floor: p.floor, from: floor, roll, pass: true, hand: p.gold };
    }
  } else {
    p.gold = 0;
    p.banked = 0;
    p.dead = true;
    p.active = false;
    p.detour = { stage: 'done', floor, roll, pass: false, outcome: 'trap', hand: 0 };
  }
  p.hist.push({ round: 'solo-' + floor, choice: 'go', roll, pass, gold: p.gold });
  return 'ok';
}
function finish() {
  G.phase = 'final';
  const arr = rank(), n = arr.length;
  const sum = arr.reduce((s, p) => s + p.banked, 0);
  const lf = arr.filter(p => p.lift);
  G.stats = {
    top: arr.slice(0, 10).map(p => ({ id: p.pub, n: p.name, b: p.banked, r: p.rank })),
    n, avg: n ? Math.round(sum / n * 10) / 10 : 0, theory: THEORY,
    zero: arr.filter(p => p.banked === 0).length, max: n ? arr[0].banked : 0,
    lift: { n: lf.length, up: lf.filter(p => p.lift === 'up').length, avg: lf.length ? Math.round(lf.reduce((a, p) => a + p.banked, 0) / lf.length * 10) / 10 : 0, ev: LIFT_EV, stairs: STAIRS_EV, upPct: LIFT_UP },
  };
}
function resetGame(wipe) {
  G.phase = 'lobby'; G.round = 0; G.stats = null;
  if (wipe) G.players.clear();
  else G.players.forEach(p => Object.assign(p, { spectator: false, active: true, dead: false, gold: LOOT[0], floor: 1, banked: 0, choice: null, auto: false, last: null, hist: [], lift: null, detour: null }));
}
function advance(from) {
  if (from && from !== G.phase) return 'phase';
  switch (G.phase) {
    case 'lobby': if (!playing().length) return 'empty'; resetGame(false); openRound(); break;
    case 'open': closeVoting(); break;
    case 'closed': reveal(); break;
    case 'revealed':
      if (G.round < 3 && activeGlobal().length) openRound();
      else if (activeDetours().length) G.phase = 'detour_wait';
      else finish();
      break;
    case 'detour_wait':
      if (activeDetours().length) return 'pending';
      finish();
      break;
    default: return 'end';
  }
  return 'ok';
}

/* ---------- HTTP ---------- */
function lanUrls() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(k => (ifs[k] || []).forEach(a => { if (a.family === 'IPv4' && !a.internal) out.push('http://' + a.address + ':' + PORT); }));
  return out;
}
function body(req) {
  return new Promise(resolve => {
    let s = ''; req.on('data', d => { s += d; if (s.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function file(res, name) {
  try { const b = fs.readFileSync(path.join(DIR, name)); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); }
  catch (e) { res.writeHead(404); res.end('нет файла ' + name + ' — запусти build.py'); }
}
const hits = new Map();   // простой лимит запросов с одного адреса
function limited(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = req.headers['cf-connecting-ip'] || xf || req.socket.remoteAddress, now = Date.now();
  const a = (hits.get(ip) || []).filter(t => now - t < 1000); a.push(now); hits.set(ip, a);
  return a.length > 400;   // за одним адресом может сидеть весь зал (общий NAT), поэтому лимит высокий
}
const pidHits = new Map();   // и отдельный лимит на одного игрока
function pidLimited(pid) {
  if (!pid) return false; const now = Date.now(), k = String(pid).slice(0, 40);
  const a = (pidHits.get(k) || []).filter(t => now - t < 1000); a.push(now); pidHits.set(k, a);
  return a.length > 8;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  if (req.method === 'GET') {
    if (p === '/' || p === '/play') return file(res, 'play.html');
    if (p === '/host') return file(res, 'host.html');
    if (p === '/film') return file(res, 'film.html');
    if (p === '/api/info') {
      // адрес для QR: PUBLIC_URL -> домен из запроса (облако) -> адреса в локальной сети
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const hostname = host.replace(/:\d+$/, '');
      const isLocal = !hostname || hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.endsWith('.local');
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const cloud = !PUBLIC_URL && !isLocal ? proto + '://' + host : '';
      const urls = PUBLIC_URL ? [PUBLIC_URL] : cloud ? [cloud] : lanUrls();
      return json(res, 200, { urls, port: PORT, public: !!(PUBLIC_URL || cloud) });
    }
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (p === '/events') {
      const pid = u.searchParams.get('pid') || '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n');
      const c = { res, pid }; clients.add(c); send(c, view(pid));
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { } }, 15000);
      req.on('close', () => { clearInterval(hb); clients.delete(c); });
      return;
    }
    res.writeHead(404); return res.end('404');
  }
  if (req.method === 'POST') {
    if (limited(req)) return json(res, 429, { err: 'slow' });
    const b = await body(req);
    if (pidLimited(b.pid)) return json(res, 429, { err: 'slow' });
    if (p === '/api/join') {
      let pl = b.pid && G.players.get(String(b.pid));
      if (!pl) {
        const name = cleanName(b.name); if (!name) return json(res, 400, { err: 'name' });
        if (G.players.size >= 200) return json(res, 400, { err: 'full' });
        const id = crypto.randomBytes(16).toString('hex');   // секретный токен игрока: только он голосует, наружу не отдаётся
        pl = { id, pub: crypto.randomBytes(4).toString('hex'), name: uniqueName(name), spectator: G.phase !== 'lobby', active: G.phase === 'lobby', dead: false, gold: LOOT[0], floor: 1, banked: 0, choice: null, auto: false, last: null, hist: [], lift: null, detour: null };
        G.players.set(id, pl);
        broadcast();
      }
      return json(res, 200, { pid: pl.id, name: pl.name });
    }
    if (p === '/api/vote') {
      const pl = G.players.get(String(b.pid));
      if (!pl || G.phase !== 'open' || !pl.active || pl.detour) return json(res, 409, { err: 'closed' });
      if (b.choice !== 'take' && b.choice !== 'go' && !(b.choice === 'lift' && G.round === LIFT_FLOOR)) return json(res, 400, { err: 'choice' });
      pl.choice = b.choice; pl.auto = false; broadcast();
      return json(res, 200, { ok: 1 });
    }
    if (p === '/api/detour') {
      const pl = G.players.get(String(b.pid));
      if (!pl || !pl.detour || !pl.active || G.phase === 'lobby' || G.phase === 'final')
        return json(res, 409, { err: 'inactive' });
      const outcome = stepDetour(pl, b.action);
      if (outcome !== 'ok') return json(res, 409, { err: outcome });
      broadcast();
      return json(res, 200, { ok: 1, detour: pl.detour });
    }
    if (p === '/api/host') {
      if (String(b.k) !== HOST_KEY) return json(res, 403, { err: 'key' });
      let r = 'ok';
      if (b.action === 'advance') r = advance(b.from);
      else if (b.action === 'reset') resetGame(false);
      else if (b.action === 'wipe') resetGame(true);
      else if (b.action === 'finish' && (G.phase === 'revealed' || G.phase === 'detour_wait') && !activeDetours().length) finish();
      else if (b.action === 'finish_detours' && G.phase === 'detour_wait') {
        // Аварийное завершение для выступления: без наказания за ожидание.
        activeDetours().forEach(q => {
          q.banked = q.gold;
          q.active = false;
          q.detour = { stage: 'done', floor: q.floor, outcome: 'timeout', hand: q.gold };
        });
        finish();
      }
      else if (b.action === 'kick') { for (const [k, q] of G.players) if (q.pub === String(b.id)) G.players.delete(k); }
      broadcast();
      return json(res, 200, { r, phase: G.phase });
    }
  }
  res.writeHead(404); res.end('404');
});

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log('\n  DECISION / 01 — Подземелье: сервер запущен\n');
  console.log('  Экран ведущего (открой у себя):  http://localhost:' + PORT + '/host?k=' + HOST_KEY);
  console.log('  Телефоны (QR на экране ведёт сюда):  ' + (PUBLIC_URL || urls.join('  или  ') || 'сеть не найдена'));
  console.log('  Ключ ведущего: ' + HOST_KEY + '  (без ключа экран только показывает)\n');
});
module.exports = { server, HOST_KEY, G, LIFT_UP, LIFT_EV, STAIRS_EV };

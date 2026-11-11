'use strict';
/*
 * '금고 털이 작전' 부스 운영 서버 (야탑제 · 심리탐구 동아리)
 * Express + Socket.IO. 상태는 data/state.json 에 저장되어 서버를 껐다 켜도 이어집니다.
 *
 * 진행 단계: waiting(대기) → escape(방탈출) → arrest(체포) → interrogation(심문) → verdict(판결) → done(종료)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const ROOT = __dirname;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

const PHASES = ['waiting', 'escape', 'arrest', 'interrogation', 'verdict', 'done'];
const PHASE_KO = { waiting: '대기', escape: '방탈출', arrest: '체포', interrogation: '심문', verdict: '판결', done: '종료' };
const SEAT_LABEL = ['A', 'B'];

// ---------- 설정 ----------
const DEFAULT_CONFIG = {
  port: 3000,
  adminPin: '1234',
  publicUrl: '',
  cleanupHours: 6,
  escapeTimeLimitSec: 180,
  defaultSessionSec: 480,
  parallelSessions: 1,
  payoff: { CC: 3, CD: 0, DC: 5, DD: 1 },
  revealPartnerChoice: true,
  showRulesToSuspect: true,
  openingMessage: '',
  pressureLines: ['네 동료는 벌써 다 불었어.'],
};

function toInt(v, def, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[설정] config.json 을 읽을 수 없어 기본값을 씁니다:', e.message);
  }
  const c = Object.assign({}, DEFAULT_CONFIG, cfg);
  c.payoff = Object.assign({}, DEFAULT_CONFIG.payoff, cfg.payoff || {});
  const out = {
    port: toInt(c.port, 3000, 1, 65535),
    adminPin: String(c.adminPin == null ? '1234' : c.adminPin),
    publicUrl: String(c.publicUrl || '').trim().replace(/\/+$/, ''),
    cleanupHours: Math.max(0.1, Number(c.cleanupHours) || 6),
    escapeTimeLimitSec: toInt(c.escapeTimeLimitSec, 180, 0, 3600),
    defaultSessionSec: toInt(c.defaultSessionSec, 480, 60, 3600),
    parallelSessions: toInt(c.parallelSessions, 1, 1, 8),
    payoff: {
      CC: toInt(c.payoff.CC, 3, 0, 999),
      CD: toInt(c.payoff.CD, 0, 0, 999),
      DC: toInt(c.payoff.DC, 5, 0, 999),
      DD: toInt(c.payoff.DD, 1, 0, 999),
    },
    revealPartnerChoice: c.revealPartnerChoice !== false,
    showRulesToSuspect: c.showRulesToSuspect !== false,
    openingMessage: cleanText(c.openingMessage, 500),
    pressureLines: (Array.isArray(c.pressureLines) ? c.pressureLines : []).map((s) => cleanText(s, 200)).filter(Boolean).slice(0, 40),
  };
  if (process.env.ADMIN_PIN) out.adminPin = String(process.env.ADMIN_PIN);
  if (process.env.PUBLIC_URL) out.publicUrl = String(process.env.PUBLIC_URL).trim().replace(/\/+$/, '');
  return out;
}
const config = loadConfig();

// ---------- 보상 계산 (payout.js) ----------
const { computePayout } = require('./payout');
const waitEst = require('./wait');

// ---------- 상태 저장 ----------
let state = { sessions: {}, queue: [], results: [], seq: 0 };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const loaded = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  state.sessions = loaded.sessions || {};
  state.queue = (loaded.queue || []).filter((id) => state.sessions[id]);
  state.results = loaded.results || [];
  state.seq = loaded.seq || 0;
  console.log(`[저장] 이전 상태를 불러왔어요 (세션 ${Object.keys(state.sessions).length}개, 누적 결과 ${state.results.length}건)`);
} catch (e) {
  if (e.code !== 'ENOENT') console.error('[저장] state.json 을 읽지 못했어요. 새로 시작합니다:', e.message);
}

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeStateNow(); }, 150);
}
function writeStateNow() {
  try {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) {
    console.error('[저장] 실패:', e.message);
  }
}

// ---------- 네트워크 주소 ----------
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).forEach((i) => {
      if (i.family !== 'IPv4' && i.family !== 4) return;
      if (i.internal) return;
      if (/^169\.254\./.test(i.address)) return;
      if (/docker|veth|br-|vmnet|vboxnet|virtualbox|vEthernet|utun|tailscale|zt/i.test(name)) return;
      out.push({ name, address: i.address });
    });
  });
  const score = (a) => (/^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  out.sort((x, y) => score(x.address) - score(y.address));
  return out;
}
const PORT = toInt(process.env.PORT || config.port, 3000, 1, 65535);
function baseUrlFor(req) {
  if (config.publicUrl) return config.publicUrl;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const isLocal = !hostname || hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname) || hostname === '0.0.0.0';
  if (!isLocal) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    return `${proto}://${host}`;
  }
  const ip = lanIPs()[0];
  return ip ? `http://${ip.address}:${PORT}` : `http://localhost:${PORT}`;
}

// ---------- 세션 ----------
function usedCodes() {
  const set = {};
  Object.keys(state.sessions).forEach((id) => state.sessions[id].suspects.forEach((s) => (set[s.code] = true)));
  return set;
}
function newCode() {
  const used = usedCodes();
  for (let i = 0; i < 5000; i++) {
    const c = String(crypto.randomInt(1000, 10000));
    if (!used[c]) return c;
  }
  for (;;) {
    const c = String(crypto.randomInt(10000, 100000));
    if (!used[c]) return c;
  }
}
const newToken = () => crypto.randomBytes(16).toString('hex');
const now = () => Date.now();

function createSession(teamName, members) {
  state.seq += 1;
  const id = 'T' + state.seq;
  const m = members || [];
  const t = now();
  const s = {
    id,
    no: state.seq,
    teamName: cleanText(teamName, 20) || `${state.seq}팀`,
    members: [cleanText(m[0], 12), cleanText(m[1], 12)],
    phase: 'waiting',
    phaseAt: { waiting: t },
    createdAt: t,
    updatedAt: t,
    payoff: null,
    suspects: [{ code: newCode(), token: null }, { code: null, token: null }],
    chats: [[], []],
    choices: [null, null],
    choiceAt: [null, null],
    verdict: null,
  };
  s.suspects[1].code = newCode();
  while (s.suspects[1].code === s.suspects[0].code) s.suspects[1].code = newCode();
  state.sessions[id] = s;
  state.queue.push(id);
  return s;
}

function suspectName(s, seat) {
  return s.members[seat] || `용의자 ${SEAT_LABEL[seat]}`;
}
function isConnected(s, seat) {
  const r = io.sockets.adapter.rooms.get(`sus:${s.id}:${seat}`);
  return !!(r && r.size > 0);
}
function setPhase(s, phase) {
  s.phase = phase;
  s.phaseAt[phase] = now();
  s.updatedAt = now();
  if (phase === 'interrogation' && config.openingMessage) {
    [0, 1].forEach((seat) => {
      if (!s.chats[seat].some((m) => m.opening)) pushMsg(s, seat, 'inv', config.openingMessage, true);
    });
  }
}
function pushMsg(s, seat, from, text, opening) {
  const msg = { id: crypto.randomBytes(4).toString('hex'), from, text, t: now() };
  if (opening) msg.opening = true;
  s.chats[seat].push(msg);
  if (s.chats[seat].length > 400) s.chats[seat].splice(0, s.chats[seat].length - 400);
  s.updatedAt = now();
  return msg;
}
function removeResult(s) {
  state.results = state.results.filter((r) => r.sid !== s.id);
}
function clearInterrogation(s) {
  s.choices = [null, null];
  s.choiceAt = [null, null];
  s.verdict = null;
  removeResult(s);
}
function makeVerdict(s) {
  const r = computePayout(s.choices, s.payoff);
  const t = now();
  const start = waitEst.startedAt(s);
  s.verdict = Object.assign({ choices: s.choices.slice(), at: t }, r);
  removeResult(s);
  state.results.push({
    sid: s.id, team: s.teamName, choices: s.choices.slice(),
    payout: r.payout.slice(), outcome: r.outcome, at: t,
    startedAt: start || null,
    durationMs: start && t > start ? t - start : null,
  });
  setPhase(s, 'verdict');
}
// 체포 단계에서 두 조사실 기기가 모두 연결돼 있으면 바로 심문으로 넘어간다
function maybeAutoInterrogate(s) {
  if (s.phase === 'arrest' && isConnected(s, 0) && isConnected(s, 1)) {
    setPhase(s, 'interrogation');
    return true;
  }
  return false;
}

// ---------- 화면별로 보낼 데이터 ----------
// 용의자 화면: 자기 채팅·자기 선택만. 상대의 채팅/선택/선택 여부는 판결 전까지 절대 넣지 않는다.
function suspectView(s, seat) {
  const other = 1 - seat;
  const v = {
    sid: s.id,
    seat,
    label: SEAT_LABEL[seat],
    teamName: s.teamName,
    myName: suspectName(s, seat),
    phase: s.phase,
    chat: s.chats[seat].map((m) => ({ id: m.id, from: m.from, text: m.text, t: m.t })),
    myChoice: s.choices[seat],
    canChoose: s.phase === 'interrogation' && !s.choices[seat],
    canChat: s.phase === 'arrest' || s.phase === 'interrogation' || s.phase === 'verdict',
    rules: null,
    verdict: null,
  };
  if (config.showRulesToSuspect && s.payoff) v.rules = Object.assign({}, s.payoff);
  if (s.verdict && (s.phase === 'verdict' || s.phase === 'done')) {
    v.verdict = {
      myChoice: s.verdict.choices[seat],
      myPayout: s.verdict.payout[seat],
      outcome: s.verdict.outcome,
    };
    if (config.revealPartnerChoice) {
      v.verdict.partnerName = suspectName(s, other);
      v.verdict.partnerChoice = s.verdict.choices[other];
      v.verdict.partnerPayout = s.verdict.payout[other];
    }
  }
  return v;
}

// 운영자 목록(로비·잡는 사람·수사관 목록): 채팅 내용은 빼고 요약만
function opSummary(s) {
  return {
    id: s.id, no: s.no, teamName: s.teamName, members: s.members, phase: s.phase, phaseAt: s.phaseAt,
    createdAt: s.createdAt,
    queuePos: state.queue.indexOf(s.id),
    suspects: [0, 1].map((seat) => ({
      label: SEAT_LABEL[seat], name: suspectName(s, seat), code: s.suspects[seat].code,
      joined: !!s.suspects[seat].token, connected: isConnected(s, seat), chosen: !!s.choices[seat],
      msgs: s.chats[seat].length,
    })),
    verdict: s.verdict,
  };
}
// 수사관 상세: 두 채팅 모두 + 선택 '여부'만 (판결 전에는 무엇을 골랐는지 숨김)
function investigatorView(s) {
  const v = opSummary(s);
  v.chats = s.chats;
  v.payoff = s.payoff || config.payoff;
  v.verdict = s.verdict && (s.phase === 'verdict' || s.phase === 'done') ? s.verdict : null;
  return v;
}

function computeStats() {
  const st = { teams: 0, cooperate: 0, betray: 0, bothCooperate: 0, bothBetray: 0, mixed: 0, candies: 0, recent: [] };
  state.results.forEach((r) => {
    st.teams++;
    r.choices.forEach((c) => (c === 'C' ? st.cooperate++ : st.betray++));
    if (r.outcome === 'CC') st.bothCooperate++;
    else if (r.outcome === 'DD') st.bothBetray++;
    else st.mixed++;
    st.candies += r.payout[0] + r.payout[1];
  });
  st.recent = state.results.slice(-8).reverse().map((r) => ({ team: r.team, choices: r.choices, payout: r.payout, outcome: r.outcome, at: r.at }));
  return st;
}
function sortedSessions() {
  return Object.keys(state.sessions).map((id) => state.sessions[id]).sort((a, b) => {
    const qa = state.queue.indexOf(a.id), qb = state.queue.indexOf(b.id);
    if (qa >= 0 && qb >= 0) return qa - qb;
    return a.no - b.no;
  });
}
function boardData() {
  const t = now();
  const sessions = sortedSessions().filter((s) => s.phase !== 'done' || t - (s.phaseAt.done || 0) < 10 * 60 * 1000);
  const queue = state.queue.map((id) => state.sessions[id]).filter(Boolean);
  const active = sessions.filter((s) => s.phase !== 'waiting' && s.phase !== 'done');
  const est = waitEst.buildQueueEstimates({
    queue, active, results: state.results, sessions, now: t,
    defaultSessionSec: config.defaultSessionSec,
    parallelSessions: config.parallelSessions,
  });
  const waitById = {};
  queue.forEach((s, i) => { waitById[s.id] = est.waits[i]; });
  return {
    now: t,
    escapeTimeLimitSec: config.escapeTimeLimitSec,
    avgSessionSec: Math.round(est.avgMs / 1000),
    parallelSessions: est.capacity,
    sessions: sessions.map((s) => ({
      id: s.id, no: s.no, teamName: s.teamName, phase: s.phase, phaseAt: s.phaseAt,
      queuePos: state.queue.indexOf(s.id),
      waitMs: s.phase === 'waiting' ? waitById[s.id] : null,
      verdict: s.verdict && (s.phase === 'verdict' || s.phase === 'done') ? { choices: s.verdict.choices, payout: s.verdict.payout, outcome: s.verdict.outcome } : null,
    })),
    stats: computeStats(),
  };
}
function opsList() {
  return {
    now: now(),
    sessions: sortedSessions().map(opSummary),
    stats: computeStats(),
    config: {
      escapeTimeLimitSec: config.escapeTimeLimitSec,
      payoff: config.payoff,
      pressureLines: config.pressureLines,
      revealPartnerChoice: config.revealPartnerChoice,
    },
  };
}

let listTimer = null;
function broadcastLists() {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    io.to('ops').emit('ops:list', opsList());
    io.to('board').emit('board:data', boardData());
  }, 60);
}
function broadcastSession(s) {
  [0, 1].forEach((seat) => io.to(`sus:${s.id}:${seat}`).emit('sus:state', suspectView(s, seat)));
  io.to(`inv:${s.id}`).emit('inv:session', investigatorView(s));
  broadcastLists();
}
function changed(s) {
  saveState();
  if (s) broadcastSession(s);
  else broadcastLists();
}

// 오래된 세션 정리 (누적 통계는 results 에 남는다)
function cleanup() {
  const t = now();
  const hour = 3600 * 1000;
  let removed = 0;
  Object.keys(state.sessions).forEach((id) => {
    const s = state.sessions[id];
    const age = t - (s.updatedAt || s.createdAt);
    const limit = s.phase === 'done' ? config.cleanupHours * hour : Math.max(config.cleanupHours, 12) * hour;
    if (age > limit) {
      deleteSession(s);
      removed++;
    }
  });
  if (removed) {
    console.log(`[정리] 오래된 세션 ${removed}개를 지웠어요`);
    changed(null);
  }
}
function deleteSession(s) {
  delete state.sessions[s.id];
  [0, 1].forEach((seat) => io.to(`sus:${s.id}:${seat}`).emit('sus:closed'));
  io.sockets.sockets.forEach((sk) => {
    if (sk.data.sid === s.id) {
      sk.leave(`sus:${s.id}:${sk.data.seat}`);
      sk.data.sid = null;
    }
  });
  state.queue = state.queue.filter((x) => x !== s.id);
  io.to(`inv:${s.id}`).emit('inv:closed', { id: s.id });
}
setInterval(cleanup, 10 * 60 * 1000).unref();

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20kb' }));

app.get('/api/info', (req, res) => {
  res.json({ baseUrl: baseUrlFor(req), lan: lanIPs().map((i) => `http://${i.address}:${PORT}`), port: PORT });
});
app.get('/api/qr.svg', async (req, res) => {
  const code = String(req.query.code || '').replace(/\D/g, '').slice(0, 6);
  const p = String(req.query.path || '').replace(/[^a-z]/g, '').slice(0, 20);
  const target = code ? `${baseUrlFor(req)}/?code=${code}` : `${baseUrlFor(req)}/${p}`;
  try {
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (e) {
    res.status(500).send('QR error');
  }
});
app.get('/healthz', (req, res) => res.send('ok'));
const page = (f) => (req, res) => res.sendFile(path.join(ROOT, 'public', f));
app.get('/s', page('index.html'));
app.get('/lobby', page('lobby.html'));
app.get('/catcher', page('catcher.html'));
app.get('/investigator', page('investigator.html'));
app.get('/board', page('board.html'));
app.get('/staff', page('staff.html'));
app.use(express.static(path.join(ROOT, 'public')));

// ---------- Socket.IO ----------
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

const failByAddr = {}; // 코드/PIN 무차별 대입 방지
function tooManyFails(socket) {
  const k = socket.handshake.address || 'x';
  const f = failByAddr[k];
  return f && f.n >= 8 && now() - f.t < 60 * 1000;
}
function addFail(socket) {
  const k = socket.handshake.address || 'x';
  const f = failByAddr[k];
  if (!f || now() - f.t > 60 * 1000) failByAddr[k] = { n: 1, t: now() };
  else f.n++;
}

function findByCode(code) {
  const ids = Object.keys(state.sessions);
  for (let i = 0; i < ids.length; i++) {
    const s = state.sessions[ids[i]];
    for (let seat = 0; seat < 2; seat++) if (s.suspects[seat].code === code) return { s, seat };
  }
  return null;
}
function attachSuspect(socket, s, seat) {
  detachSuspect(socket);
  socket.data.sid = s.id;
  socket.data.seat = seat;
  socket.join(`sus:${s.id}:${seat}`);
}
function detachSuspect(socket) {
  if (socket.data.sid != null) {
    socket.leave(`sus:${socket.data.sid}:${socket.data.seat}`);
    const prev = state.sessions[socket.data.sid];
    socket.data.sid = null;
    if (prev) broadcastSession(prev);
  }
}

// 운영자 동작들
const OPS = {
  register(m) {
    const s = createSession(m.teamName, m.members);
    return { s, data: { id: s.id } };
  },
  move(m, s) {
    const i = state.queue.indexOf(s.id);
    if (i < 0) return '대기열에 없는 팀이에요.';
    const j = m.dir === 'up' ? i - 1 : m.dir === 'down' ? i + 1 : m.dir === 'top' ? 0 : i;
    if (j < 0 || j >= state.queue.length) return null;
    state.queue.splice(i, 1);
    state.queue.splice(j, 0, s.id);
    return null;
  },
  remove(m, s) {
    deleteSession(s);
    return { s: null };
  },
  start(m, s) {
    if (s.phase !== 'waiting') return '대기 중인 팀만 시작할 수 있어요.';
    state.queue = state.queue.filter((x) => x !== s.id);
    setPhase(s, 'escape');
    return null;
  },
  arrest(m, s) {
    if (s.phase !== 'escape') return '방탈출 중인 팀만 체포할 수 있어요.';
    s.payoff = Object.assign({}, config.payoff);
    setPhase(s, 'arrest');
    maybeAutoInterrogate(s);
    return null;
  },
  beginInterrogation(m, s) {
    if (s.phase !== 'arrest') return '체포 단계에서만 심문을 시작할 수 있어요.';
    setPhase(s, 'interrogation');
    return null;
  },
  finish(m, s) {
    if (s.phase !== 'verdict') return '판결이 난 뒤에 종료할 수 있어요.';
    setPhase(s, 'done');
    return null;
  },
  reopenChoices(m, s) {
    if (s.phase !== 'interrogation' && s.phase !== 'verdict' && s.phase !== 'done') return '심문/판결 단계에서만 쓸 수 있어요.';
    clearInterrogation(s);
    setPhase(s, 'interrogation');
    return null;
  },
  // 실수했을 때: 원하는 단계로 강제 이동
  setPhase(m, s) {
    const p = m.phase;
    if (PHASES.indexOf(p) < 0) return '알 수 없는 단계예요.';
    if (p === s.phase) return null;
    if ((p === 'verdict' || p === 'done') && !s.verdict) {
      if (!(s.choices[0] && s.choices[1])) return '두 용의자가 모두 선택해야 판결로 넘어갈 수 있어요.';
      makeVerdict(s);
      if (p === 'done') setPhase(s, 'done');
      return null;
    }
    if (PHASES.indexOf(p) < PHASES.indexOf('verdict')) clearInterrogation(s);
    if (p !== 'waiting' && PHASES.indexOf(p) >= PHASES.indexOf('arrest') && !s.payoff) {
      s.payoff = Object.assign({}, config.payoff);
    }
    if (p === 'waiting') {
      s.payoff = null;
      if (state.queue.indexOf(s.id) < 0) state.queue.unshift(s.id);
    } else {
      state.queue = state.queue.filter((x) => x !== s.id);
    }
    setPhase(s, p);
    return null;
  },
  // 처음 상태로 되돌리기 (채팅·선택 모두 지우고 대기열 맨 앞으로)
  reset(m, s) {
    clearInterrogation(s);
    s.chats = [[], []];
    s.payoff = null;
    s.phaseAt = {};
    if (state.queue.indexOf(s.id) < 0) state.queue.unshift(s.id);
    setPhase(s, 'waiting');
    return null;
  },
  rename(m, s) {
    if (m.teamName != null) s.teamName = cleanText(m.teamName, 20) || s.teamName;
    if (Array.isArray(m.members)) s.members = [cleanText(m.members[0], 12), cleanText(m.members[1], 12)];
    s.updatedAt = now();
    return null;
  },
  // 조사실 기기 연결 해제 (다른 기기로 다시 접속해야 할 때)
  unbind(m, s) {
    const seat = m.seat === 1 ? 1 : 0;
    s.suspects[seat].token = null;
    io.to(`sus:${s.id}:${seat}`).emit('sus:closed');
    io.sockets.sockets.forEach((sk) => {
      if (sk.data.sid === s.id && sk.data.seat === seat) {
        sk.leave(`sus:${s.id}:${seat}`);
        sk.data.sid = null;
      }
    });
    return null;
  },
  send(m, s) {
    const seat = m.seat === 1 ? 1 : 0;
    const text = cleanText(m.text, 500);
    if (!text) return '내용을 입력하세요.';
    if (s.phase === 'waiting' || s.phase === 'escape') return '체포 뒤에 채팅할 수 있어요.';
    pushMsg(s, seat, 'inv', text);
    return null;
  },
};

io.on('connection', (socket) => {
  const reply = (cb, data) => typeof cb === 'function' && cb(data);
  socket.data.sid = null;

  // ----- 운영자 -----
  socket.on('op:auth', (m, cb) => {
    if (tooManyFails(socket)) return reply(cb, { ok: false, error: '잠시 후 다시 시도하세요.' });
    if (m && String(m.pin) === config.adminPin) {
      socket.data.op = true;
      socket.join('ops');
      socket.emit('ops:list', opsList());
      return reply(cb, { ok: true });
    }
    addFail(socket);
    reply(cb, { ok: false, error: 'PIN이 틀렸어요.' });
  });
  socket.on('op', (m, cb) => {
    if (!socket.data.op) return reply(cb, { ok: false, error: '운영자 로그인이 필요해요.', auth: true });
    m = m || {};
    const fn = OPS[m.action];
    if (!fn) return reply(cb, { ok: false, error: '알 수 없는 동작이에요.' });
    let s = null;
    if (m.action !== 'register') {
      s = state.sessions[m.id];
      if (!s) return reply(cb, { ok: false, error: '세션을 찾을 수 없어요.' });
    }
    const r = fn(m, s);
    if (typeof r === 'string') return reply(cb, { ok: false, error: r });
    if (r && 's' in r) s = r.s;
    changed(s);
    reply(cb, Object.assign({ ok: true }, (r && r.data) || {}));
  });
  socket.on('op:resetStats', (m, cb) => {
    if (!socket.data.op) return reply(cb, { ok: false, error: '운영자 로그인이 필요해요.', auth: true });
    state.results = [];
    changed(null);
    reply(cb, { ok: true });
  });
  socket.on('inv:watch', (m, cb) => {
    if (!socket.data.op) return reply(cb, { ok: false, error: '운영자 로그인이 필요해요.', auth: true });
    Array.from(socket.rooms).forEach((r) => { if (r.indexOf('inv:') === 0) socket.leave(r); });
    const s = state.sessions[m && m.id];
    if (!s) return reply(cb, { ok: false, error: '세션을 찾을 수 없어요.' });
    socket.join(`inv:${s.id}`);
    socket.emit('inv:session', investigatorView(s));
    reply(cb, { ok: true });
  });

  // ----- 전체 현황판 (PIN 없음: 채팅·참가 코드는 보내지 않음) -----
  socket.on('board:watch', () => {
    socket.join('board');
    socket.emit('board:data', boardData());
  });

  // ----- 용의자 -----
  socket.on('sus:join', (m, cb) => {
    if (tooManyFails(socket)) return reply(cb, { ok: false, error: '너무 많이 틀렸어요. 1분 뒤에 다시 시도하세요.' });
    const code = String((m && m.code) || '').replace(/\D/g, '');
    const found = code && findByCode(code);
    if (!found) {
      addFail(socket);
      return reply(cb, { ok: false, error: '코드를 찾을 수 없어요. 운영진에게 코드를 다시 확인해 주세요.' });
    }
    const s = found.s, seat = found.seat, sus = s.suspects[seat];
    if (sus.token && m.token === sus.token) {
      // 같은 기기 재접속
    } else if (sus.token && isConnected(s, seat)) {
      return reply(cb, { ok: false, error: `이미 다른 기기가 용의자 ${SEAT_LABEL[seat]}로 접속해 있어요. 운영자 화면에서 '기기 해제' 후 다시 시도하세요.` });
    } else {
      sus.token = newToken(); // 새 기기 (이전 기기가 꺼져 있으면 넘겨받음)
    }
    s.updatedAt = now();
    attachSuspect(socket, s, seat);
    maybeAutoInterrogate(s);
    changed(s);
    reply(cb, { ok: true, sid: s.id, seat, token: sus.token });
  });
  socket.on('sus:resume', (m, cb) => {
    const s = m && state.sessions[m.sid];
    const seat = m && (m.seat === 1 ? 1 : 0);
    if (!s || !m.token || s.suspects[seat].token !== m.token) return reply(cb, { ok: false });
    attachSuspect(socket, s, seat);
    maybeAutoInterrogate(s);
    changed(s);
    reply(cb, { ok: true });
  });
  socket.on('sus:send', (m, cb) => {
    const s = state.sessions[socket.data.sid];
    if (!s) return reply(cb, { ok: false, error: '세션이 없어요.' });
    const text = cleanText(m && m.text, 300);
    if (!text) return reply(cb, { ok: false, error: '내용을 입력하세요.' });
    if (!(s.phase === 'arrest' || s.phase === 'interrogation' || s.phase === 'verdict')) return reply(cb, { ok: false, error: '지금은 메시지를 보낼 수 없어요.' });
    pushMsg(s, socket.data.seat, 'sus', text);
    changed(s);
    reply(cb, { ok: true });
  });
  socket.on('sus:choose', (m, cb) => {
    const s = state.sessions[socket.data.sid];
    if (!s) return reply(cb, { ok: false, error: '세션이 없어요.' });
    const seat = socket.data.seat;
    const c = m && m.choice;
    if (c !== 'C' && c !== 'D') return reply(cb, { ok: false, error: '잘못된 선택이에요.' });
    if (s.phase !== 'interrogation') return reply(cb, { ok: false, error: '지금은 선택할 수 없어요.' });
    if (s.choices[seat]) return reply(cb, { ok: false, error: '이미 선택했어요. 바꿀 수 없어요.' });
    s.choices[seat] = c;
    s.choiceAt[seat] = now();
    s.updatedAt = now();
    if (s.choices[0] && s.choices[1]) makeVerdict(s);
    changed(s);
    reply(cb, { ok: true });
  });
  socket.on('sus:leave', (m, cb) => {
    detachSuspect(socket);
    reply(cb, { ok: true });
  });

  socket.on('disconnect', () => {
    const s = state.sessions[socket.data.sid];
    if (s) setTimeout(() => state.sessions[s.id] && broadcastSession(s), 50);
  });
});

function shutdown() {
  writeStateNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  cleanup(); // 켤 때 한 번 오래된 세션 정리
  const ips = lanIPs();
  console.log('');
  console.log('==============================================');
  console.log(" '금고 털이 작전' 부스 서버가 켜졌어요!");
  console.log('==============================================');
  console.log(` 이 노트북에서:  http://localhost:${PORT}/staff`);
  ips.forEach((ip) => console.log(` 다른 기기에서:  http://${ip.address}:${PORT}/staff   (${ip.name})`));
  if (!ips.length) console.log(' (와이파이 주소를 찾지 못했어요. 와이파이/핫스팟 연결을 확인하세요)');
  if (config.publicUrl) console.log(` QR 주소(설정값): ${config.publicUrl}`);
  const b = ips.length ? `http://${ips[0].address}:${PORT}` : `http://localhost:${PORT}`;
  console.log('');
  console.log(` 로비 매니저:   ${b}/lobby`);
  console.log(` 잡는 사람:     ${b}/catcher`);
  console.log(` 수사관:        ${b}/investigator`);
  console.log(` 전체 현황판:   ${b}/board   (PIN 없음)`);
  console.log(` 용의자(조사실): ${b}/          (참가 코드 입력)`);
  console.log(` 운영자 PIN: ${config.adminPin === '1234' ? '1234 (기본값! config.json 에서 바꾸세요)' : '설정됨'}`);
  console.log('');
});

module.exports = { server, computePayout };

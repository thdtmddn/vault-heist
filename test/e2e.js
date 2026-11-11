// 자동 테스트: 서버를 임시 폴더로 띄워서 전체 흐름을 소켓으로 검사합니다.
// 사용법: npm test
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { computePayout } = require('../payout');
const waitEst = require('../wait');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-test-'));
const CFG = path.join(TMP, 'config.json');
const baseCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
baseCfg.adminPin = '1234';
baseCfg.payoff = { CC: 3, CD: 0, DC: 5, DD: 1 };
baseCfg.defaultCoins = 20;
fs.writeFileSync(CFG, JSON.stringify(baseCfg));
const ENV_PIN = '8642';

let fails = 0, passes = 0;
function check(c, msg) {
  if (c) { passes++; console.log('  ✔ ' + msg); } else { fails++; console.log('  ✘ ' + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), CONFIG_PATH: CFG, DATA_DIR: TMP, ADMIN_PIN: ENV_PIN }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; if (out.includes('서버가 켜졌어요')) resolve(); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (c) => { if (!out.includes('서버가 켜졌어요')) reject(new Error('server exit ' + c)); });
  });
}
function stopServer() {
  return new Promise((r) => { proc.once('exit', () => r()); proc.kill('SIGTERM'); });
}

const sockets = [];
function connect(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.__name = name;
  s.__log = []; // 이 소켓이 받은 모든 패킷 (격리 검사용)
  s.onAny((ev, data) => s.__log.push(JSON.stringify([ev, data])));
  sockets.push(s);
  return new Promise((res) => s.on('connect', () => res(s)));
}
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, (r) => res(r)));
function next(s, ev, pred) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting ' + ev + ' on ' + s.__name)), 3000);
    const h = (d) => { if (!pred || pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
    s.on(ev, h);
  });
}
let lastList = null;
async function opList(op) {
  await sleep(150);
  return lastList;
}

(async () => {
  console.log('\n[0] 보상 계산 (단위)');
  const P = { CC: 3, CD: 0, DC: 5, DD: 1 };
  let r = computePayout(['C', 'C'], P);
  check(r.payout[0] === 3 && r.payout[1] === 3 && r.total === 6, '둘 다 협력 → 캔디 3 / 3');
  r = computePayout(['D', 'C'], P);
  check(r.payout[0] === 5 && r.payout[1] === 0, 'A만 배반 → A 캔디 5, B 0');
  r = computePayout(['C', 'D'], P);
  check(r.payout[0] === 0 && r.payout[1] === 5, 'B만 배반 → A 0, B 캔디 5');
  r = computePayout(['D', 'D'], P);
  check(r.payout[0] === 1 && r.payout[1] === 1 && r.outcome === 'DD', '둘 다 배반 → 캔디 1 / 1');
  r = computePayout(['D', 'C'], { CC: 4, CD: 1, DC: 7, DD: 2 });
  check(r.payout[0] === 7 && r.payout[1] === 1, '설정 바꾼 보상표도 그대로 반영 (7 / 1)');

  console.log('\n[0b] 대기 시간 예상 (단위)');
  const AVG = 8 * 60 * 1000;
  check(waitEst.averageDurationMs([], 480) === 480000, '끝난 판이 없으면 기본 시간(초)을 씀');
  check(waitEst.averageDurationMs([], undefined) === waitEst.DEFAULT_SESSION_SEC * 1000, '기본값이 비어 있으면 8분');
  const durs = [6, 8, 10].map((m) => ({ durationMs: m * 60 * 1000 }));
  check(waitEst.averageDurationMs(durs, 480) === AVG, '끝난 판의 평균 길이를 씀 (6·8·10분 → 8분)');
  const mixed = [{ durationMs: 5000 }, { durationMs: 2 * 3600 * 1000 }, { durationMs: 7 * 60 * 1000 }];
  check(waitEst.averageDurationMs(mixed, 480) === 7 * 60 * 1000, '너무 짧거나 긴 이상치는 평균에서 뺌');
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ durationMs: (i < 5 ? 5 : 10) * 60 * 1000 });
  check(waitEst.averageDurationMs(many, 480) === 10 * 60 * 1000, '최근 15건만 평균에 반영');
  const w0 = waitEst.estimateQueueWaits({ queueLength: 3, activeRemainingMs: [], avgMs: AVG, capacity: 1 });
  check(w0[0] === 0 && w0[1] === AVG && w0[2] === 2 * AVG, '진행 중이 없고 동시 1판이면 대기 = 0, 한 판, 두 판');
  const w2 = waitEst.estimateQueueWaits({ queueLength: 4, activeRemainingMs: [], avgMs: AVG, capacity: 2 });
  check(w2[0] === 0 && w2[1] === 0 && w2[2] === AVG && w2[3] === AVG, '동시 2판이면 앞 두 팀은 바로, 뒤 두 팀은 한 판 뒤');
  const rem = [2 * 60 * 1000, 5 * 60 * 1000];
  const wA = waitEst.estimateQueueWaits({ queueLength: 3, activeRemainingMs: rem, avgMs: AVG, capacity: 2 });
  check(wA[0] === 2 * 60 * 1000 && wA[1] === 5 * 60 * 1000 && wA[2] === 2 * 60 * 1000 + AVG, '진행 중인 팀의 남은 시간을 반영해 대기 순서를 매김');
  check(waitEst.remainingMs({ phase: 'waiting' }, Date.now(), AVG) === 0, '대기 중인 팀은 슬롯을 쓰지 않음');
  check(waitEst.remainingMs({ phase: 'done', phaseAt: { done: Date.now() } }, Date.now(), AVG) === 0, '종료된 팀은 슬롯을 쓰지 않음');
  const now = 1_000_000;
  const mid = waitEst.remainingMs({ phase: 'escape', phaseAt: { escape: now - 3 * 60 * 1000 } }, now, AVG);
  check(mid === 5 * 60 * 1000, '진행 중이면 남은 시간 = 평균 - 이미 지난 시간');
  const ot = waitEst.remainingMs({ phase: 'interrogation', phaseAt: { escape: now - 20 * 60 * 1000 } }, now, AVG);
  check(ot === waitEst.OVERTIME_REMAINING_MS, '평균보다 오래 걸려도 남은 시간을 0으로 두지 않음');
  const justV = waitEst.remainingMs({ phase: 'verdict', phaseAt: { verdict: now } }, now, AVG);
  check(justV === waitEst.VERDICT_REMAINING_MS, '판결이 난 팀은 최대 1분으로 잡음');
  const lateV = waitEst.remainingMs({ phase: 'verdict', phaseAt: { verdict: now - 90 * 1000 } }, now, AVG);
  check(lateV === 0, '판결 후 1분이 지났으면 남은 시간 0');
  check(waitEst.formatWait(0) === '곧 시작' && waitEst.formatWait(15000) === '곧 시작', '20초 이하는 "곧 시작"');
  check(waitEst.formatWait(30000) === '약 1분' && waitEst.formatWait(AVG) === '약 8분', '대기 시간은 분 단위로 반올림해 표시');
  const built = waitEst.buildQueueEstimates({
    queue: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    active: [], results: [], now, defaultSessionSec: 480, parallelSessions: 1,
  });
  check(built.avgMs === 480000 && built.capacity === 1 && built.waits[0] === 0 && built.waits[2] === 960000, 'buildQueueEstimates: 기본 시간·동시 1판으로 대기 배열을 만듦');
  const built2 = waitEst.buildQueueEstimates({
    queue: [{ id: 'A' }],
    active: [{ id: 'X', phase: 'escape', phaseAt: { escape: now - 1000 } }, { id: 'Y', phase: 'interrogation', phaseAt: { escape: now - 2000 } }],
    results: [], now, defaultSessionSec: 480, parallelSessions: 1,
  });
  check(built2.capacity === 2, '이미 2판이 돌아가면 동시 수용은 2로 올라감');

  await startServer();
  console.log('\n[1] 운영자 PIN');
  const lobby = await connect('lobby');
  lobby.on('ops:list', (d) => (lastList = d));
  r = await emit(lobby, 'op', { action: 'register', teamName: 'x' });
  check(!r.ok && r.auth, '로그인 없이 운영자 동작 불가');
  r = await emit(lobby, 'op:auth', { pin: '1234' });
  check(!r.ok, 'config.json 의 1234 는 환경변수 ADMIN_PIN 이 있으면 거절');
  r = await emit(lobby, 'op:auth', { pin: ENV_PIN });
  check(r.ok, '환경변수 ADMIN_PIN 으로 로그인 성공');
  const inv = await connect('investigator');
  check((await emit(inv, 'inv:watch', { id: 'T1' })).auth === true, '수사관 화면도 PIN 필요');
  await emit(inv, 'op:auth', { pin: ENV_PIN });
  const board = await connect('board');
  let boardData = null;
  board.on('board:data', (d) => (boardData = d));
  board.emit('board:watch');

  console.log('\n[2] 팀 등록 · 대기열');
  const t1 = await emit(lobby, 'op', { action: 'register', teamName: '1팀', members: ['김철수', '이영희'] });
  const t2 = await emit(lobby, 'op', { action: 'register', teamName: '독수리', members: ['박민수', ''] });
  const t3 = await emit(lobby, 'op', { action: 'register', teamName: '', members: [] });
  let L = await opList();
  await sleep(150);
  const qWait = (boardData.sessions || []).filter((s) => s.phase === 'waiting').sort((a, b) => a.queuePos - b.queuePos);
  check(qWait.length === 3 && qWait[0].waitMs === 0, '현황판: 대기 맨 앞 팀은 곧 시작 (waitMs 0)');
  check(Math.abs(qWait[1].waitMs - 480000) < 50 && Math.abs(qWait[2].waitMs - 960000) < 50, '현황판: 둘째·셋째 팀은 기본 한 판(8분)·두 판만큼 대기');
  check(boardData.avgSessionSec === 480 && boardData.parallelSessions === 1, '현황판: 끝난 판이 없으면 기본 8분·동시 1판');
  check(L.sessions.length === 3 && t1.id && t2.id && t3.id, '3팀 등록');
  check(L.sessions.find((s) => s.id === t3.id).teamName === '3팀', '팀 이름 비우면 자동 번호');
  await emit(lobby, 'op', { action: 'move', id: t3.id, dir: 'up' });
  L = await opList();
  check(L.sessions.filter((s) => s.phase === 'waiting').map((s) => s.id).join() === [t1.id, t3.id, t2.id].join(), '대기열 순서 바꾸기 (▲)');
  await emit(lobby, 'op', { action: 'remove', id: t3.id });
  L = await opList();
  check(L.sessions.length === 2, '대기열에서 삭제');
  const S1 = L.sessions.find((s) => s.id === t1.id);
  const S2 = L.sessions.find((s) => s.id === t2.id);
  check(S2.suspects[1].name === '용의자 B', '이름 없으면 "용의자 B"');
  const codes = [S1.suspects[0].code, S1.suspects[1].code, S2.suspects[0].code, S2.suspects[1].code];
  check(new Set(codes).size === 4 && codes.every((c) => /^\d{4}$/.test(c)), '용의자별 참가 코드 4개가 모두 다름');
  r = await emit(lobby, 'op', { action: 'arrest', id: t1.id, coins: 20 });
  check(!r.ok, '시작 전에는 체포 불가');
  check((await emit(lobby, 'op', { action: 'start', id: t1.id })).ok, '1팀 시작 → 방탈출');
  check((await emit(lobby, 'op', { action: 'start', id: t2.id })).ok, '독수리 시작 → 방탈출 (동시에 2세션)');
  L = await opList();
  check(L.sessions.every((s) => s.phase === 'escape'), '두 세션 모두 방탈출 단계');

  console.log('\n[3] 조사실 기기 접속');
  const A1 = await connect('A1'), B1 = await connect('B1'), A2 = await connect('A2'), B2 = await connect('B2');
  r = await emit(A1, 'sus:join', { code: '0000' });
  check(!r.ok, '틀린 코드는 거절');
  const jA1 = await emit(A1, 'sus:join', { code: codes[0] });
  const jB1 = await emit(B1, 'sus:join', { code: codes[1] });
  const jA2 = await emit(A2, 'sus:join', { code: codes[2] });
  const jB2 = await emit(B2, 'sus:join', { code: codes[3] });
  check(jA1.ok && jB1.ok && jA2.ok && jB2.ok && jA1.seat === 0 && jB1.seat === 1, '4개 기기가 각자 코드로 접속');
  const X = await connect('intruder');
  r = await emit(X, 'sus:join', { code: codes[0] });
  check(!r.ok && /이미 다른 기기/.test(r.error), '이미 연결된 자리에 다른 기기는 못 들어옴');
  await sleep(150);
  check(A1.__log.some((p) => p.includes('"phase":"escape"')), '방탈출 중 용의자 화면은 대기 상태를 받음');

  console.log('\n[4] 체포 → 심문');
  const invS1 = next(inv, 'inv:session', (d) => d.id === t1.id);
  await emit(inv, 'inv:watch', { id: t1.id });
  await invS1;
  check((await emit(lobby, 'op', { action: 'arrest', id: t1.id, coins: -3 })).ok === false, '음수 코인은 거절');
  r = await emit(lobby, 'op', { action: 'arrest', id: t1.id, coins: 25 });
  check(r.ok, '1팀 체포 (자루 코인 25)');
  await emit(lobby, 'op', { action: 'arrest', id: t2.id });
  L = await opList();
  check(L.sessions.every((s) => s.phase === 'interrogation'), '두 조사실 기기가 연결돼 있으면 체포 즉시 심문으로');
  const sv = (s) => { for (let i = s.__log.length - 1; i >= 0; i--) { const p = JSON.parse(s.__log[i]); if (p[0] === 'sus:state') return p[1]; } return null; };
  check(sv(A1).chat.length === 1 && sv(A1).chat[0].from === 'inv', '심문 시작 시 형사의 첫 대사가 자동으로 나옴');
  check(sv(A1).sackCoins === 25 && sv(B1).sackCoins === 25 && sv(A2).sackCoins === 20, '팀 자루 하나의 코인 수 표시 (안 넣으면 기본값 20)');
  check(sv(A1).rules && sv(A1).rules.CC === 3 && sv(A1).rules.DC === 5 && sv(A1).rules.CD === 0 && sv(A1).rules.DD === 1, '용의자에게 캔디 보상표 표시');

  console.log('\n[5] 채팅 격리');
  await emit(inv, 'op', { action: 'send', id: t1.id, seat: 0, text: 'SECRET_TO_A1 네 동료는 벌써 다 불었어.' });
  await emit(inv, 'op', { action: 'send', id: t1.id, seat: 1, text: 'SECRET_TO_B1' });
  await emit(B1, 'sus:send', { text: 'SECRET_FROM_B1 저는 아무것도 몰라요' });
  await emit(A1, 'sus:send', { text: 'SECRET_FROM_A1' });
  await emit(A2, 'sus:send', { text: 'SECRET_FROM_A2' });
  await sleep(200);
  const inA1 = A1.__log.join('\n'), inB1 = B1.__log.join('\n'), inA2 = A2.__log.join('\n'), inB2 = B2.__log.join('\n');
  check(inA1.includes('SECRET_TO_A1') && !inA1.includes('SECRET_TO_B1') && !inA1.includes('SECRET_FROM_B1'), 'A1은 자기 채팅만 받음 (B1 채팅 없음)');
  check(inB1.includes('SECRET_FROM_B1') && !inB1.includes('SECRET_TO_A1') && !inB1.includes('SECRET_FROM_A1'), 'B1은 자기 채팅만 받음 (A1 채팅 없음)');
  check(!inA2.includes('SECRET_') || (inA2.includes('SECRET_FROM_A2') && !inA2.includes('A1') && !inA2.includes('B1')), '다른 팀(독수리) 기기는 1팀 채팅을 못 받음');
  check(!inB2.includes('SECRET_FROM_A2'), '같은 팀이라도 B2는 A2 채팅을 못 받음');
  const invLast = await new Promise((res) => { inv.emit('inv:watch', { id: t1.id }); inv.once('inv:session', res); });
  check(invLast.chats[0].some((m) => m.text.includes('SECRET_FROM_A1')) && invLast.chats[1].some((m) => m.text.includes('SECRET_FROM_B1')), '수사관은 A, B 채팅을 모두 봄');
  const bd = JSON.stringify(boardData);
  check(boardData && !bd.includes('SECRET_') && !codes.some((c) => bd.includes('"' + c + '"')) && !bd.includes('token'), '현황판(PIN 없음)에는 채팅·참가 코드·토큰이 없음');
  const opl = JSON.stringify(L);
  check(!opl.includes('SECRET_') && !opl.includes('token'), '운영자 목록에도 채팅 내용·토큰은 없음');

  console.log('\n[6] 선택 숨기기');
  A1.__log.length = 0; B1.__log.length = 0; inv.__log.length = 0; board.__log.length = 0;
  r = await emit(A1, 'sus:choose', { choice: 'C' });
  check(r.ok, 'A1 협력 선택');
  r = await emit(A1, 'sus:choose', { choice: 'D' });
  check(!r.ok, '한 번 고르면 바꿀 수 없음');
  r = await emit(A1, 'sus:choose', { choice: 'X' });
  check(!r.ok, '잘못된 값 거절');
  await sleep(200);
  const b1v = sv(B1);
  check(b1v.myChoice === null && b1v.verdict === null && !('partnerChosen' in b1v) && !B1.__log.join('').includes('"C"'), 'B1은 A1이 골랐는지도, 무엇을 골랐는지도 모름');
  const iv = JSON.parse(inv.__log.filter((p) => p.includes('inv:session')).pop())[1];
  check(iv.suspects[0].chosen === true && iv.suspects[1].chosen === false && iv.verdict === null && !JSON.stringify(iv).includes('"choices"'), '수사관은 "선택 완료" 여부만 보고 내용은 모름');
  check(!board.__log.join('').includes('"C"'), '현황판에도 판결 전 선택 내용 없음');

  console.log('\n[7] 새로고침/재접속');
  const tokB1 = jB1.token;
  B1.disconnect();
  await sleep(150);
  L = await opList();
  check(!L.sessions.find((s) => s.id === t1.id).suspects[1].connected, '연결 끊기면 운영자 화면에 표시');
  const B1b = await connect('B1b');
  r = await emit(B1b, 'sus:resume', { sid: t1.id, seat: 1, token: 'wrong' });
  check(!r.ok, '틀린 토큰으로는 복귀 불가');
  const st = next(B1b, 'sus:state');
  r = await emit(B1b, 'sus:resume', { sid: t1.id, seat: 1, token: tokB1 });
  const back = await st;
  check(r.ok && back.chat.some((m) => m.text.includes('SECRET_FROM_B1')) && back.phase === 'interrogation', '새로고침 후 토큰으로 복귀 → 채팅 기록 그대로');
  check(!JSON.stringify(back).includes('SECRET_TO_A1'), '복귀해도 상대 채팅은 안 옴');

  console.log('\n[8] 판결 · 보상 (3가지 경우)');
  const vA = next(A1, 'sus:state', (d) => d.phase === 'verdict');
  const vB = next(B1b, 'sus:state', (d) => d.phase === 'verdict');
  r = await emit(B1b, 'sus:choose', { choice: 'D' });
  const [va, vb] = await Promise.all([vA, vB]);
  check(va.verdict.myPayout === 0 && vb.verdict.myPayout === 5, '1팀 A 협력 / B 배반 → 캔디 A 0, B 5');
  check(va.verdict.partnerChoice === 'D' && vb.verdict.partnerChoice === 'C', '판결 후 서로의 선택 동시 공개');
  await emit(A2, 'sus:choose', { choice: 'D' });
  const v2 = next(A2, 'sus:state', (d) => d.phase === 'verdict');
  await emit(B2, 'sus:choose', { choice: 'D' });
  const v2a = await v2;
  await sleep(150);
  check(v2a.verdict.myPayout === 1 && sv(B2).verdict.myPayout === 1, '독수리 둘 다 배반 → 캔디 1 / 1');
  L = await opList();
  check(L.stats.teams === 2 && L.stats.bothBetray === 1 && L.stats.mixed === 1 && L.stats.cooperate === 1 && L.stats.betray === 3, '누적 통계: 2팀, 둘다배반 1, 엇갈림 1, 협력 1 / 배반 3');
  check(L.stats.confiscated === 45 && L.stats.candies === 7, '누적: 압수 코인 45, 지급 캔디 7');
  // 선택 다시 받기 → 둘 다 협력
  r = await emit(lobby, 'op', { action: 'reopenChoices', id: t2.id });
  check(r.ok, '실수 대비: 선택 다시 받기');
  await sleep(100);
  check(sv(A2).phase === 'interrogation' && sv(A2).myChoice === null && sv(A2).verdict === null, '다시 받기 후 용의자 화면 초기화');
  await emit(A2, 'sus:choose', { choice: 'C' });
  const v3 = next(B2, 'sus:state', (d) => d.phase === 'verdict');
  await emit(B2, 'sus:choose', { choice: 'C' });
  const v3b = await v3;
  await sleep(100);
  check(v3b.verdict.myPayout === 3 && sv(A2).verdict.myPayout === 3, '독수리 둘 다 협력 → 캔디 3 / 3');
  L = await opList();
  check(L.stats.teams === 2 && L.stats.bothCooperate === 1 && L.stats.bothBetray === 0 && L.stats.candies === 11, '다시 받으면 이전 결과는 통계에서 빠지고 새 결과로 대체');
  check(boardData.stats.teams === 2 && JSON.stringify(boardData).includes('"verdict":{'), '현황판에 판결·통계 반영');

  console.log('\n[9] 단계 강제 변경 · 종료 · 기기 해제');
  r = await emit(lobby, 'op', { action: 'finish', id: t1.id });
  check(r.ok, '1팀 종료');
  await sleep(100);
  check(sv(A1).phase === 'done' && sv(A1).verdict.myPayout === 0, '종료 후에도 용의자 화면에 결과 유지');
  const t4 = await emit(lobby, 'op', { action: 'register', teamName: '테스트4' });
  r = await emit(lobby, 'op', { action: 'setPhase', id: t4.id, phase: 'verdict' });
  check(!r.ok, '둘 다 선택 안 했으면 판결로 강제 이동 불가');
  r = await emit(lobby, 'op', { action: 'setPhase', id: t4.id, phase: 'interrogation' });
  L = await opList();
  const s4 = L.sessions.find((s) => s.id === t4.id);
  check(r.ok && s4.phase === 'interrogation' && s4.coins === baseCfg.defaultCoins && s4.queuePos === -1, '강제로 심문 단계로 (코인은 기본값, 대기열에서 빠짐)');
  r = await emit(lobby, 'op', { action: 'reset', id: t4.id });
  L = await opList();
  check(r.ok && L.sessions.find((s) => s.id === t4.id).phase === 'waiting' && L.sessions.find((s) => s.id === t4.id).queuePos === 0, '처음부터: 대기열 맨 앞으로');
  await sleep(150);
  const t4b = (boardData.sessions || []).find((s) => s.id === t4.id);
  check(t4b && t4b.waitMs != null && t4b.waitMs >= 0 && t4b.waitMs <= waitEst.VERDICT_REMAINING_MS, '현황판: 판결 중인 팀이 있으면 대기 1팀은 그 남은 시간(최대 1분)만큼 기다림');
  const closed = next(A2, 'sus:closed');
  await emit(lobby, 'op', { action: 'unbind', id: t2.id, seat: 0 });
  await closed;
  check(true, '기기 해제 → 그 기기는 코드 화면으로');
  r = await emit(X, 'sus:join', { code: codes[2] });
  check(r.ok, '해제 뒤 다른 기기가 같은 코드로 이어받기');
  r = await emit(A2, 'sus:send', { text: 'after unbind' });
  check(!r.ok, '해제된 기기는 더 이상 메시지 못 보냄');

  console.log('\n[10] 서버 재시작 후 상태 유지');
  await sleep(300);
  await stopServer();
  // 보상표를 바꾸고 재시작: 이미 체포된 팀은 체포 때 보상표 그대로, 새 팀은 새 보상표
  fs.writeFileSync(CFG, JSON.stringify(Object.assign({}, baseCfg, { payoff: { CC: 4, CD: 1, DC: 7, DD: 2 } })));
  await startServer();
  const R = await connect('afterRestart');
  const L2p = new Promise((res) => R.once('ops:list', res));
  r = await emit(R, 'op:auth', { pin: ENV_PIN });
  const L2 = await L2p;
  check(r.ok && L2.sessions.length === 3 && L2.stats.teams === 2, '재시작 후 세션 3개, 누적 통계 유지');
  const R2 = await connect('A1-after');
  const st2 = next(R2, 'sus:state');
  r = await emit(R2, 'sus:resume', { sid: t1.id, seat: 0, token: jA1.token });
  const sv2 = await st2;
  check(r.ok && sv2.phase === 'done' && sv2.verdict.myPayout === 0 && sv2.chat.some((m) => m.text.includes('SECRET_TO_A1')), '재시작 후에도 용의자 토큰으로 복귀 + 채팅·판결 유지');
  check(sv2.rules && sv2.rules.CC === 3 && sv2.rules.DC === 5, '보상표는 체포 시점에 고정 (설정을 바꿔도 기존 팀은 3/0/5/1)');
  await emit(R, 'op', { action: 'setPhase', id: t4.id, phase: 'interrogation' });
  const i4p = new Promise((res) => R.once('inv:session', res));
  await emit(R, 'inv:watch', { id: t4.id });
  const i4 = await i4p;
  check(i4.payoff.CC === 4 && i4.payoff.DC === 7, '새로 체포된 팀은 바뀐 보상표 (4/1/7/2)');
  await emit(R, 'op', { action: 'reset', id: t4.id });
  const del = next(R2, 'sus:closed');
  await emit(R, 'op', { action: 'remove', id: t1.id });
  await del;
  check(true, '세션 삭제 → 용의자 기기에 알림');

  console.log('\n[11] 무차별 코드 입력 방지');
  const Z = await connect('brute');
  let blocked = false;
  for (let i = 0; i < 10; i++) {
    const rr = await emit(Z, 'sus:join', { code: String(1000 + i) });
    if (rr.error && rr.error.includes('1분')) blocked = true;
  }
  check(blocked, '1분 안에 8번 넘게 틀리면 잠시 막힘');

  console.log('\n[12] 오래된 세션 자동 정리');
  await sleep(300);
  await stopServer();
  const SP = path.join(TMP, 'state.json');
  const stj = JSON.parse(fs.readFileSync(SP, 'utf8'));
  stj.sessions[t2.id].updatedAt = Date.now() - 7 * 3600 * 1000; // 종료되지 않은 세션: 12시간 기준이라 남아야 함
  stj.sessions[t2.id].phase = 'verdict';
  stj.sessions[t4.id].updatedAt = Date.now() - 13 * 3600 * 1000; // 12시간 넘게 방치 → 삭제
  fs.writeFileSync(SP, JSON.stringify(stj));
  await startServer();
  const C = await connect('cleanup');
  const L3p = new Promise((res) => C.once('ops:list', res));
  await emit(C, 'op:auth', { pin: ENV_PIN });
  const L3 = await L3p;
  check(L3.sessions.length === 1 && L3.sessions[0].id === t2.id && L3.stats.teams === 2, '12시간 넘게 방치된 세션은 지우고, 누적 통계는 남김');

  sockets.forEach((s) => s.close());
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n결과: ${passes}개 통과, ${fails}개 실패`);
  process.exit(fails ? 1 : 0);
})().catch(async (e) => {
  console.error('테스트 오류:', e);
  if (proc) proc.kill();
  process.exit(1);
});

'use strict';
// 현황판 대기 시간 예상. 서버와 테스트가 함께 사용합니다.
// 한 판 길이는 끝난 세션의 평균(시작→판결)을 쓰고, 아직 데이터가 없으면 defaultSessionSec 를 씁니다.
// 동시에 몇 판을 돌리는지는 현재 진행 중인 수와 parallelSessions 중 큰 값을 용량으로 봅니다.

const DEFAULT_SESSION_SEC = 480; // 8분: 방탈출·체포·심문·판결을 합친 기본 한 판
const MIN_AVG_MS = 60 * 1000;
const MAX_AVG_MS = 30 * 60 * 1000;
const RECENT_LIMIT = 15;
const VERDICT_REMAINING_MS = 60 * 1000; // 판결 난 팀은 곧 끝나므로 최대 1분으로 잡음
const OVERTIME_REMAINING_MS = 45 * 1000; // 평균보다 오래 걸려도 슬롯은 비어 있지 않음
const SOON_MS = 20 * 1000;

function startedAt(session) {
  const p = (session && session.phaseAt) || {};
  return p.escape || p.arrest || p.interrogation || p.verdict || p.done || session.createdAt || 0;
}

function sessionDurationMs(row, endAt) {
  if (row && row.durationMs > 0) return row.durationMs;
  const start = (row && row.startedAt) || startedAt(row || {});
  const end = endAt || (row && (row.at || row.endedAt));
  if (start && end && end > start) return end - start;
  return null;
}

function isSaneDuration(ms) {
  return Number.isFinite(ms) && ms >= MIN_AVG_MS && ms <= MAX_AVG_MS;
}

function averageDurationMs(results, defaultSessionSec, sessions) {
  const def = Number(defaultSessionSec);
  const fallback = (Number.isFinite(def) && def > 0 ? def : DEFAULT_SESSION_SEC) * 1000;
  const have = {};
  const durs = [];
  (results || []).forEach((r) => {
    const d = sessionDurationMs(r);
    if (isSaneDuration(d)) {
      durs.push(d);
      if (r.sid) have[r.sid] = true;
    }
  });
  (sessions || []).forEach((s) => {
    if (!s || have[s.id]) return;
    if (s.phase !== 'verdict' && s.phase !== 'done') return;
    const end = (s.phaseAt && (s.phaseAt.verdict || s.phaseAt.done)) || s.updatedAt;
    const d = sessionDurationMs({ startedAt: startedAt(s), at: end });
    if (isSaneDuration(d)) durs.push(d);
  });
  const recent = durs.slice(-RECENT_LIMIT);
  if (!recent.length) return fallback;
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  return Math.round(Math.min(MAX_AVG_MS, Math.max(MIN_AVG_MS, avg)));
}

function remainingMs(session, now, avgMs) {
  if (!session || session.phase === 'waiting' || session.phase === 'done') return 0;
  if (session.phase === 'verdict') {
    const at = session.phaseAt && session.phaseAt.verdict;
    if (at) return Math.max(0, VERDICT_REMAINING_MS - (now - at));
    return VERDICT_REMAINING_MS;
  }
  const start = startedAt(session);
  if (!start) return avgMs;
  const left = avgMs - (now - start);
  return left > 0 ? left : OVERTIME_REMAINING_MS;
}

function estimateQueueWaits(opts) {
  opts = opts || {};
  const queueLength = Math.max(0, Math.round(Number(opts.queueLength) || 0));
  const avgMs = Math.max(1, Number(opts.avgMs) || DEFAULT_SESSION_SEC * 1000);
  const remainings = Array.isArray(opts.activeRemainingMs) ? opts.activeRemainingMs : [];
  const cap = Math.max(1, Math.round(Number(opts.capacity) || 1), remainings.length);
  const slots = remainings.map((ms) => Math.max(0, Number(ms) || 0));
  while (slots.length < cap) slots.push(0);
  const waits = [];
  for (let i = 0; i < queueLength; i++) {
    slots.sort((a, b) => a - b);
    const startAt = slots[0];
    waits.push(startAt);
    slots[0] = startAt + avgMs;
  }
  return waits;
}

function formatWait(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= SOON_MS) return '곧 시작';
  const min = Math.max(1, Math.round(n / 60000));
  return '약 ' + min + '분';
}

function buildQueueEstimates(opts) {
  opts = opts || {};
  const queue = opts.queue || [];
  const active = (opts.active || []).filter((s) => s && s.phase !== 'waiting' && s.phase !== 'done');
  const avgMs = averageDurationMs(opts.results, opts.defaultSessionSec, opts.sessions);
  const capacity = Math.max(1, Math.round(Number(opts.parallelSessions) || 1), active.length);
  const activeRemainingMs = active.map((s) => remainingMs(s, opts.now || Date.now(), avgMs));
  const waits = estimateQueueWaits({
    queueLength: queue.length,
    activeRemainingMs,
    avgMs,
    capacity,
  });
  return { avgMs, capacity, waits, activeRemainingMs };
}

module.exports = {
  DEFAULT_SESSION_SEC,
  MIN_AVG_MS,
  MAX_AVG_MS,
  VERDICT_REMAINING_MS,
  OVERTIME_REMAINING_MS,
  startedAt,
  sessionDurationMs,
  averageDurationMs,
  remainingMs,
  estimateQueueWaits,
  formatWait,
  buildQueueEstimates,
};

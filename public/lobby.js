(function () {
  'use strict';
  var VH = window.VH, $ = VH.$, esc = VH.esc;
  var data = null;
  var openTools = {};
  var socket = VH.operator(function () {});
  socket.on('ops:list', function (d) { data = d; VH.syncNow(d.now); render(); });
  $('logout').addEventListener('click', VH.logout);

  $('regForm').addEventListener('submit', function (e) {
    e.preventDefault();
    VH.op(socket, 'register', { teamName: $('teamName').value, members: [$('memA').value, $('memB').value] }, function (r) {
      if (r.ok) {
        $('teamName').value = ''; $('memA').value = ''; $('memB').value = '';
        VH.toast('대기열에 추가했어요.');
      }
    });
  });
  $('resetStats').addEventListener('click', function () {
    VH.confirmBox('누적 통계(협력/배반 비율 등)를<br>모두 지울까요?', '지우기', 'red', function () {
      socket.emit('op:resetStats', {}, function () { VH.toast('누적 통계를 지웠어요.'); });
    });
  });

  fetch('/api/info').then(function (r) { return r.json(); }).then(function (i) {
    $('addr').innerHTML = (/^https:/.test(i.baseUrl) ? '기기 접속 주소: <b>' : '같은 와이파이의 기기에서: <b>') + esc(i.baseUrl) + '</b><br>' +
      (i.lan.length > 1 ? '다른 주소: ' + i.lan.map(esc).join(', ') + '<br>' : '') +
      '운영진 화면 모음: ' + esc(i.baseUrl) + '/staff';
  }).catch(function () {});

  function members(s) {
    var a = s.members[0], b = s.members[1];
    return a || b ? esc(a || '?') + ' · ' + esc(b || '?') : '<span class="muted">이름 없음</span>';
  }
  function phaseTimer(s) {
    var at = s.phaseAt[s.phase] || s.createdAt;
    var ms = VH.serverNow() - at;
    var over = s.phase === 'escape' && data.config.escapeTimeLimitSec && ms > data.config.escapeTimeLimitSec * 1000;
    return '<span class="timer' + (over ? ' over' : '') + '" data-at="' + at + '" data-ph="' + s.phase + '">' + VH.elapsed(ms) + '</span>';
  }

  function render() {
    if (!data) return;
    var q = data.sessions.filter(function (s) { return s.phase === 'waiting'; });
    $('qCount').textContent = q.length + '팀';
    $('queue').innerHTML = q.length ? q.map(function (s, i) {
      return '<div class="queue-item"><div class="qno">' + (i + 1) + '</div>' +
        '<div class="qname">' + esc(s.teamName) + '<small>' + members(s) + '</small></div>' +
        '<div class="btns">' +
        '<button class="btn small light icon-btn" data-a="up" data-id="' + s.id + '" ' + (i === 0 ? 'disabled' : '') + ' title="위로">▲</button>' +
        '<button class="btn small light icon-btn" data-a="down" data-id="' + s.id + '" ' + (i === q.length - 1 ? 'disabled' : '') + ' title="아래로">▼</button>' +
        '<button class="btn small light icon-btn" data-a="qr" data-id="' + s.id + '" title="조사실 코드">🔑</button>' +
        '<button class="btn small red icon-btn" data-a="remove" data-id="' + s.id + '" title="삭제">✕</button>' +
        '<button class="btn small green" data-a="start" data-id="' + s.id + '">▶ 시작</button>' +
        '</div></div>';
    }).join('') : '<p class="muted">대기 중인 팀이 없어요.</p>';

    var act = data.sessions.filter(function (s) { return s.phase !== 'waiting' && s.phase !== 'done'; });
    act.sort(function (a, b) { return a.no - b.no; });
    $('active').innerHTML = act.length ? act.map(card).join('') : '<p class="muted">진행 중인 세션이 없어요. 대기열에서 ▶ 시작을 누르세요.</p>';

    var done = data.sessions.filter(function (s) { return s.phase === 'done'; });
    done.sort(function (a, b) { return (b.phaseAt.done || 0) - (a.phaseAt.done || 0); });
    $('doneCount').textContent = done.length ? done.length + '팀' : '';
    $('done').innerHTML = done.length ? done.map(doneRow).join('') : '<p class="muted">아직 종료된 팀이 없어요.</p>';

    var st = data.stats;
    var tot = st.cooperate + st.betray;
    $('stats').innerHTML = '판결 난 팀 <b>' + st.teams + '</b> · 협력 ' + (tot ? Math.round(st.cooperate / tot * 100) : 0) + '% / 배반 ' + (tot ? Math.round(st.betray / tot * 100) : 0) + '%<br>' +
      '둘 다 협력 ' + st.bothCooperate + ' · 둘 다 배반 ' + st.bothBetray + ' · 엇갈림 ' + st.mixed + '<br>지급 캔디 🍬' + st.candies + '개';
  }

  function card(s) {
    var main = '';
    if (s.phase === 'escape') main = '<button class="btn red" data-a="arrest" data-id="' + s.id + '">🚨 체포</button>';
    else if (s.phase === 'arrest') main = '<button class="btn" data-a="begin" data-id="' + s.id + '">💬 심문 시작</button>';
    else if (s.phase === 'interrogation') {
      if (s.awaitingReveal) main += '<button class="btn gold" data-a="reveal" data-id="' + s.id + '">📣 결과 공개</button>';
      main += '<a class="btn" href="/investigator?id=' + s.id + '">💬 수사관 화면</a>';
    }
    else if (s.phase === 'verdict') main = '<button class="btn green" data-a="finish" data-id="' + s.id + '">🏁 종료 (캔디 지급 완료)</button>';
    else if (s.phase === 'done') main = '<button class="btn light" data-a="remove" data-id="' + s.id + '">목록에서 지우기</button>';
    var sus = s.suspects.map(function (u, i) {
      return '<div class="sus-row"><span><span class="dot ' + (u.connected ? 'on' : u.joined ? 'off' : '') + '"></span>용의자 ' + u.label + ' · ' + esc(u.name) +
        (s.phase === 'interrogation' ? ' · <span class="chosen ' + (u.chosen ? 'yes' : 'no') + '">' + (u.chosen ? '선택 완료' : '고민 중') + '</span>' : '') + '</span>' +
        '<span>코드 <span class="code">' + u.code + '</span> <button class="btn small light" data-a="qr1" data-id="' + s.id + '" data-seat="' + i + '">QR</button>' +
        (u.joined ? ' <button class="btn small ghost" data-a="unbind" data-id="' + s.id + '" data-seat="' + i + '">기기 해제</button>' : '') + '</span></div>';
    }).join('');
    var vd = '';
    if (s.verdict) {
      vd = '<div class="sess-meta">⚖️ ' + VH.OUTCOME_KO[s.verdict.outcome] + ' — A ' + VH.CHOICE_SHORT[s.verdict.choices[0]] + ' 🍬' + s.verdict.payout[0] + ' / B ' + VH.CHOICE_SHORT[s.verdict.choices[1]] + ' 🍬' + s.verdict.payout[1] + '</div>';
    }
    var tools = openTools[s.id] ? '<div class="card" style="background:#191e2b;margin-bottom:0">' +
      '<label>단계 강제 변경 (실수했을 때)</label><div class="sess-actions" style="margin-top:0">' +
      VH.PHASES.map(function (p) { return '<button class="btn small ' + (p === s.phase ? 'gold' : 'light') + '" data-a="phase" data-ph="' + p + '" data-id="' + s.id + '">' + VH.PHASE_KO[p] + '</button>'; }).join('') +
      '</div><div class="sess-actions">' +
      (s.awaitingReveal ? '<button class="btn small gold" data-a="reveal" data-id="' + s.id + '">결과 공개</button>' : '') +
      (s.phase === 'interrogation' || s.phase === 'verdict' || s.phase === 'done' ? '<button class="btn small light" data-a="reopen" data-id="' + s.id + '">선택 다시 받기</button>' : '') +
      '<button class="btn small light" data-a="reset" data-id="' + s.id + '">처음부터 (대기열로)</button>' +
      '<button class="btn small red" data-a="remove" data-id="' + s.id + '">삭제</button></div></div>' : '';
    return '<div class="sess"><div class="sess-head"><span class="sess-name">' + esc(s.teamName) + '</span>' + VH.phaseBadge(s.phase) +
      (s.awaitingReveal ? ' <span class="badge ph-ready">📢 공개 대기</span>' : '') + '</div>' +
      '<div class="sess-meta">' + members(s) + ' · 이 단계 ' + phaseTimer(s) + '</div>' +
      VH.phaseSteps(s.phase) + sus + vd +
      '<div class="sess-actions">' + main + '<button class="btn light" data-a="tools" data-id="' + s.id + '">⚙️ 관리</button></div>' + tools + '</div>';
  }

  function doneRow(s) {
    var when = s.phaseAt && s.phaseAt.done ? VH.clock(s.phaseAt.done) : '';
    var res = '';
    if (s.verdict) {
      res = '<span class="done-res">⚖️ ' + VH.OUTCOME_KO[s.verdict.outcome] + ' · A ' + VH.CHOICE_SHORT[s.verdict.choices[0]] + ' 🍬' + s.verdict.payout[0] + ' / B ' + VH.CHOICE_SHORT[s.verdict.choices[1]] + ' 🍬' + s.verdict.payout[1] + '</span>';
    }
    return '<div class="done-item"><div class="done-main"><div class="nm">' + esc(s.teamName) + '</div>' +
      '<div class="done-meta"><span class="muted">' + members(s) + (when ? ' · 종료 ' + when : '') + '</span>' + res + '</div></div>' +
      '<div class="btns"><button class="btn small light" data-a="remove" data-id="' + s.id + '">목록에서 지우기</button></div></div>';
  }

  function find(id) { for (var i = 0; i < data.sessions.length; i++) if (data.sessions[i].id === id) return data.sessions[i]; return null; }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-a]') : null;
    if (!b || !data) return;
    var a = b.getAttribute('data-a'), id = b.getAttribute('data-id'), s = find(id);
    if (!s) return;
    var seat = Number(b.getAttribute('data-seat'));
    if (a === 'up' || a === 'down') VH.op(socket, 'move', { id: id, dir: a });
    else if (a === 'start') VH.op(socket, 'start', { id: id });
    else if (a === 'remove') VH.confirmBox('<b>' + esc(s.teamName) + '</b>을(를) 삭제할까요?', '삭제', 'red', function () { VH.op(socket, 'remove', { id: id }); });
    else if (a === 'qr') VH.showBothQR(s);
    else if (a === 'qr1') VH.showQR('용의자 ' + s.suspects[seat].label + ' 조사실', s.suspects[seat].code, s.teamName + ' · ' + s.suspects[seat].name);
    else if (a === 'unbind') VH.confirmBox('용의자 ' + s.suspects[seat].label + ' 기기 연결을 해제할까요?<br><span class="muted" style="font-size:17px">새 기기에서 코드를 다시 입력하면 이어서 진행돼요.</span>', '해제', 'red', function () { VH.op(socket, 'unbind', { id: id, seat: seat }); });
    else if (a === 'arrest') VH.confirmBox('<b>' + esc(s.teamName) + '</b>을(를) 체포할까요?', '체포', 'red', function () { VH.op(socket, 'arrest', { id: id }); });
    else if (a === 'begin') VH.op(socket, 'beginInterrogation', { id: id });
    else if (a === 'reveal') VH.op(socket, 'reveal', { id: id });
    else if (a === 'finish') VH.op(socket, 'finish', { id: id });
    else if (a === 'reopen') VH.confirmBox('두 사람의 선택과 판결을 지우고<br>다시 고르게 할까요?', '다시 받기', 'red', function () { VH.op(socket, 'reopenChoices', { id: id }); });
    else if (a === 'reset') VH.confirmBox('<b>' + esc(s.teamName) + '</b>의 채팅·선택을 모두 지우고<br>대기열 맨 앞으로 보낼까요?', '처음부터', 'red', function () { VH.op(socket, 'reset', { id: id }); });
    else if (a === 'phase') VH.confirmBox('<b>' + esc(s.teamName) + '</b>을(를)<br>\'' + VH.PHASE_KO[b.getAttribute('data-ph')] + '\' 단계로 바꿀까요?', '바꾸기', 'red', function () { VH.op(socket, 'setPhase', { id: id, phase: b.getAttribute('data-ph') }); });
    else if (a === 'tools') { openTools[id] = !openTools[id]; render(); }
  });

  setInterval(function () {
    var ts = document.querySelectorAll('.timer[data-at]');
    for (var i = 0; i < ts.length; i++) {
      var ms = VH.serverNow() - Number(ts[i].getAttribute('data-at'));
      ts[i].textContent = VH.elapsed(ms);
      if (ts[i].getAttribute('data-ph') === 'escape' && data && data.config.escapeTimeLimitSec) ts[i].classList.toggle('over', ms > data.config.escapeTimeLimitSec * 1000);
    }
  }, 1000);
})();

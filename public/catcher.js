(function () {
  'use strict';
  var VH = window.VH, $ = VH.$, esc = VH.esc;
  var data = null;
  var socket = VH.operator(function () {});
  socket.on('ops:list', function (d) { data = d; VH.syncNow(d.now); render(); });
  $('logout').addEventListener('click', VH.logout);

  function names(s) { return s.suspects.map(function (u) { return esc(u.name); }).join(' · '); }
  function render() {
    var esc1 = data.sessions.filter(function (s) { return s.phase === 'escape'; });
    var lim = data.config.escapeTimeLimitSec;
    $('escape').innerHTML = esc1.length ? esc1.map(function (s) {
      var at = s.phaseAt.escape;
      return '<div class="card arrest-card"><div class="sess-head"><span class="sess-name">' + esc(s.teamName) + '</span>' +
        '<span class="catch-timer">⏱ <span class="timer" data-at="' + at + '">' + VH.elapsed(VH.serverNow() - at) + '</span>' + (lim ? ' <span class="muted catch-lim">/ ' + VH.elapsed(lim * 1000) + '</span>' : '') + '</span></div>' +
        '<div class="sess-meta">' + names(s) + '</div>' +
        '<button class="btn arrest" data-id="' + s.id + '">🚨 체포</button></div>';
    }).join('') : '<div class="card muted center">방탈출 중인 팀이 없어요.<br>로비에서 팀을 시작하면 여기에 나타나요.</div>';

    var arr = data.sessions.filter(function (s) { return s.phase === 'arrest' || s.phase === 'interrogation'; });
    $('arrested').innerHTML = arr.length ? arr.map(function (s) {
      return '<div class="sess catch-arr"><div class="sess-head"><span class="sess-name">' + esc(s.teamName) + '</span>' + VH.phaseBadge(s.phase) + '</div>' +
        (s.phase === 'arrest' ? '<div class="sess-meta">조사실 기기: A ' + (s.suspects[0].connected ? '✅' : '❌') + ' · B ' + (s.suspects[1].connected ? '✅' : '❌') + '</div>' : '<div class="sess-meta">심문 중</div>') +
        '<div class="sess-actions"><button class="btn small light" data-qr="' + s.id + '">조사실 QR</button></div></div>';
    }).join('') : '<p class="muted">없음</p>';
  }
  function find(id) { for (var i = 0; i < data.sessions.length; i++) if (data.sessions[i].id === id) return data.sessions[i]; return null; }
  document.addEventListener('click', function (e) {
    if (!data || !e.target.closest) return;
    var b = e.target.closest('.arrest');
    var s;
    if (b && (s = find(b.getAttribute('data-id')))) {
      VH.confirmBox('<b>' + esc(s.teamName) + '</b>을(를) 체포할까요?', '체포', 'red', function () {
        VH.op(socket, 'arrest', { id: s.id }, function (r) { if (r.ok) VH.toast(s.teamName + ' 체포! 조사실로 데려가세요.'); });
      });
      return;
    }
    b = e.target.closest('[data-qr]');
    if (b && (s = find(b.getAttribute('data-qr')))) VH.showBothQR(s);
  });
  setInterval(function () {
    var ts = document.querySelectorAll('.timer[data-at]');
    var lim = data ? data.config.escapeTimeLimitSec * 1000 : 0;
    for (var i = 0; i < ts.length; i++) {
      var ms = VH.serverNow() - Number(ts[i].getAttribute('data-at'));
      ts[i].textContent = VH.elapsed(ms);
      ts[i].classList.toggle('over', !!lim && ms > lim);
    }
  }, 1000);
})();

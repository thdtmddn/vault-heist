(function () {
  'use strict';
  var VH = window.VH, $ = VH.$, esc = VH.esc;
  var list = null, cur = null, curId = null;
  var params = {};
  location.search.replace(/[?&]([^=&]+)=([^&]*)/g, function (m, k, v) { params[k] = decodeURIComponent(v); });
  var side = params.side || VH.LS.get('vh_side') || 'both';
  if (['A', 'B', 'both'].indexOf(side) < 0) side = 'both';
  curId = params.id || VH.LS.get('vh_inv_sid') || null;
  var built = '';
  var chatSig = ['', ''];

  function watch() {
    if (!curId) return;
    socket.emit('inv:watch', { id: curId }, function (r) {
      if (!r || !r.ok) { curId = null; cur = null; VH.LS.del('vh_inv_sid'); renderDetail(); }
    });
  }
  var ready = function () { watch(); };
  ready.again = watch;
  var socket = VH.operator(ready);
  $('logout').addEventListener('click', VH.logout);

  socket.on('ops:list', function (d) { list = d; VH.syncNow(d.now); renderTabs(); if (!curId) renderDetail(); });
  socket.on('inv:session', function (s) { if (s.id !== curId) return; cur = s; renderDetail(); });
  socket.on('inv:closed', function (m) { if (m.id === curId) { curId = null; cur = null; VH.LS.del('vh_inv_sid'); renderDetail(); VH.toast('세션이 삭제됐어요.'); } });

  function renderTabs() {
    var tabs = $('sideTabs').querySelectorAll('[data-side]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-side') === side);
    if (!list) return;
    var ss = list.sessions.filter(function (s) { return s.phase === 'arrest' || s.phase === 'interrogation' || s.phase === 'verdict' || (s.phase === 'done' && s.id === curId); });
    var esc1 = list.sessions.filter(function (s) { return s.phase === 'escape'; });
    $('sessTabs').innerHTML = (ss.length ? ss.map(function (s) {
      var waiting = s.suspects.filter(function (u) { return !u.chosen; }).length;
      return '<button class="btn small ' + (s.id === curId ? 'on' : 'light') + '" data-sid="' + s.id + '">' + esc(s.teamName) + ' · ' + VH.PHASE_KO[s.phase] +
        (s.phase === 'interrogation' ? ' (' + (2 - waiting) + '/2 선택)' : '') + '</button>';
    }).join('') : '<span class="muted">체포된 팀이 없어요.</span>') +
      (esc1.length ? ' <span class="muted" style="margin-left:8px">방탈출 중: ' + esc1.map(function (s) { return esc(s.teamName); }).join(', ') + '</span>' : '');
  }

  function seats() { return side === 'A' ? [0] : side === 'B' ? [1] : [0, 1]; }

  function buildCols() {
    var key = curId + '|' + side;
    if (built === key) return;
    built = key;
    chatSig = ['', ''];
    var lines = (list && list.config.pressureLines) || [];
    $('cols').className = 'inv-cols' + (side === 'both' ? ' both' : ' single');
    $('cols').innerHTML = seats().map(function (seat) {
      return '<div class="inv-col card" style="margin:0" data-col="' + seat + '">' +
        '<div class="inv-col-head"><span class="nm" id="nm' + seat + '"></span><span id="st' + seat + '"></span></div>' +
        '<div class="chat"><div class="chat-log" id="log' + seat + '"></div>' +
        '<div class="quick">' + lines.map(function (l, i) { return '<button class="btn" type="button" data-q="' + i + '" data-seat="' + seat + '">' + esc(l) + '</button>'; }).join('') + '</div>' +
        '<form class="chat-form" data-seat="' + seat + '" autocomplete="off"><input class="big" id="in' + seat + '" maxlength="500" placeholder="용의자 ' + (seat ? 'B' : 'A') + '에게 메시지…" autocomplete="off">' +
        '<button class="btn" type="submit">보내기</button></form></div></div>';
    }).join('');
  }

  function renderDetail() {
    renderTabs();
    if (!curId || !cur) {
      $('none').classList.remove('hidden');
      $('detail').classList.add('hidden');
      built = '';
      return;
    }
    $('none').classList.add('hidden');
    $('detail').classList.remove('hidden');
    var s = cur;
    $('dName').textContent = s.teamName;
    $('dBadge').innerHTML = VH.phaseBadge(s.phase);
    $('dMeta').innerHTML = s.coins != null ? '자루 <span class="coins">' + s.coins + '</span>개 압수' : '';
    $('dSteps').innerHTML = VH.phaseSteps(s.phase);
    var act = '';
    if (s.phase === 'arrest') act += '<span class="muted">기기 둘 다 연결되면 자동 시작</span><button class="btn" data-act="begin">💬 심문 시작</button>';
    if (s.phase === 'verdict') act += '<button class="btn green" data-act="finish">🏁 종료 (캔디 지급 완료)</button>';
    if (s.phase === 'interrogation' || s.phase === 'verdict') act += '<button class="btn light" data-act="reopen">선택 다시 받기</button>';
    $('dActions').innerHTML = act;
    if (s.verdict) {
      var v = s.verdict;
      $('dVerdict').innerHTML = '<b>⚖️ ' + VH.OUTCOME_KO[v.outcome] + '</b>' + [0, 1].map(function (i) {
        return '<span class="vchip ' + v.choices[i] + '">' + (i ? 'B' : 'A') + ' ' + VH.CHOICE_EMOJI[v.choices[i]] + ' ' + VH.CHOICE_SHORT[v.choices[i]] + ' → 🍬' + v.payout[i] + '</span>';
      }).join('');
    } else $('dVerdict').innerHTML = '';

    buildCols();
    seats().forEach(function (seat) {
      var u = s.suspects[seat];
      $('nm' + seat).innerHTML = '<span class="dot ' + (u.connected ? 'on' : u.joined ? 'off' : '') + '"></span>' + u.label + ' · ' + esc(u.name);
      var st = '';
      if (s.phase === 'interrogation') st = '<span class="chosen ' + (u.chosen ? 'yes' : 'no') + '">' + (u.chosen ? '✅ 선택 완료' : '🤔 고민 중') + '</span>';
      else if (s.verdict) st = '<span class="chosen yes">' + VH.CHOICE_EMOJI[s.verdict.choices[seat]] + ' ' + VH.CHOICE_SHORT[s.verdict.choices[seat]] + '</span>';
      st += ' <button class="btn small light" data-qrs="' + seat + '">' + (u.connected ? '코드 ' : '🔑 ') + u.code + '</button>';
      $('st' + seat).innerHTML = st;
      var chat = s.chats[seat];
      var sig = chat.length + ':' + (chat.length ? chat[chat.length - 1].id : '');
      if (sig !== chatSig[seat]) {
        chatSig[seat] = sig;
        var log = $('log' + seat);
        log.innerHTML = chat.length ? chat.map(function (m) {
          var mine = m.from === 'inv';
          return '<div class="msg ' + (mine ? 'me' : 'them') + '"><span class="who">' + (mine ? '수사관' : esc(u.name)) + ' · ' + VH.clock(m.t) + '</span>' + esc(m.text) + '</div>';
        }).join('') : '<p class="muted center">' + (u.connected ? '아직 대화가 없어요.' : '조사실 기기가 아직 연결되지 않았어요. 🔑 버튼의 QR/코드로 연결하세요.') + '</p>';
        log.scrollTop = log.scrollHeight;
      }
      var canChat = s.phase === 'arrest' || s.phase === 'interrogation' || s.phase === 'verdict' || s.phase === 'done';
      $('in' + seat).disabled = !canChat;
    });
  }

  function send(seat, text, done) {
    VH.op(socket, 'send', { id: curId, seat: seat, text: text }, done);
  }
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.getAttribute || f.getAttribute('data-seat') == null) return;
    e.preventDefault();
    var seat = Number(f.getAttribute('data-seat'));
    var inp = $('in' + seat);
    var t = inp.value.trim();
    if (!t) return;
    send(seat, t, function (r) { if (r.ok) inp.value = ''; });
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var b = e.target.closest('[data-side]');
    if (b) { side = b.getAttribute('data-side'); VH.LS.set('vh_side', side); renderDetail(); return; }
    b = e.target.closest('[data-sid]');
    if (b) { curId = b.getAttribute('data-sid'); cur = null; VH.LS.set('vh_inv_sid', curId); built = ''; watch(); renderTabs(); return; }
    b = e.target.closest('[data-q]');
    if (b && list) {
      var line = list.config.pressureLines[Number(b.getAttribute('data-q'))];
      if (line) send(Number(b.getAttribute('data-seat')), line);
      return;
    }
    b = e.target.closest('[data-qrs]');
    if (b && cur) { var u = cur.suspects[Number(b.getAttribute('data-qrs'))]; VH.showQR('용의자 ' + u.label + ' 조사실', u.code, cur.teamName + ' · ' + u.name); return; }
    b = e.target.closest('[data-act]');
    if (b && cur) {
      var a = b.getAttribute('data-act');
      if (a === 'begin') VH.op(socket, 'beginInterrogation', { id: curId });
      else if (a === 'finish') VH.op(socket, 'finish', { id: curId });
      else if (a === 'reopen') VH.confirmBox('두 사람의 선택과 판결을 지우고<br>다시 고르게 할까요?', '다시 받기', 'red', function () { VH.op(socket, 'reopenChoices', { id: curId }); });
    }
  });
})();

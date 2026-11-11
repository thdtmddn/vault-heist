(function () {
  'use strict';
  var VH = window.VH, $ = VH.$, esc = VH.esc;
  var KEY = 'vh_sus';
  var view = null;
  var lastChatSig = '';

  function getSess() { try { var s = VH.LS.get(KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function setSess(s) { VH.LS.set(KEY, JSON.stringify(s)); }
  function clearSess() { VH.LS.del(KEY); }

  function show(id) {
    var list = document.querySelectorAll('.screen');
    for (var i = 0; i < list.length; i++) list[i].classList.toggle('hidden', list[i].id !== id);
  }

  var socket = io({ transports: ['websocket', 'polling'] });
  window.__vhSocket = socket;
  VH.connBanner(socket);

  var urlCode = '';
  try { urlCode = (new URLSearchParams(location.search).get('code') || '').replace(/\D/g, ''); } catch (e) {
    var m = /[?&]code=(\d+)/.exec(location.search); urlCode = m ? m[1] : '';
  }

  function join(code, manual) {
    var s = getSess();
    socket.emit('sus:join', { code: code, token: s && s.token }, function (r) {
      if (r && r.ok) {
        setSess({ sid: r.sid, seat: r.seat, token: r.token, code: code });
        $('joinErr').textContent = '';
        if (urlCode) { urlCode = ''; try { history.replaceState(null, '', location.pathname); } catch (e) {} }
      } else {
        show('scrJoin');
        $('joinCode').value = code;
        $('joinErr').textContent = (r && r.error) || '입장하지 못했어요.';
      }
    });
  }

  socket.on('connect', function () {
    if (urlCode) return join(urlCode);
    var s = getSess();
    if (!s) return show('scrJoin');
    socket.emit('sus:resume', s, function (r) {
      if (!r || !r.ok) { clearSess(); view = null; show('scrJoin'); }
    });
  });
  socket.on('sus:closed', function () {
    clearSess(); view = null; lastChatSig = '';
    show('scrJoin');
    $('joinCode').value = '';
    $('joinErr').textContent = '세션이 끝났거나 연결이 해제됐어요. 새 코드를 입력하세요.';
  });
  socket.on('sus:state', function (v) {
    view = v;
    render();
  });

  $('joinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var c = $('joinCode').value.replace(/\D/g, '');
    if (!c) { $('joinErr').textContent = '코드를 입력하세요.'; return; }
    join(c, true);
  });
  $('chatForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('chatInput').value.trim();
    if (!t) return;
    socket.emit('sus:send', { text: t }, function (r) {
      if (r && r.ok) $('chatInput').value = '';
      else VH.toast((r && r.error) || '보내지 못했어요.', true);
    });
  });

  function renderChat() {
    var sig = view.chat.length + ':' + (view.chat.length ? view.chat[view.chat.length - 1].id : '');
    if (sig === lastChatSig) return;
    lastChatSig = sig;
    var log = $('chatLog');
    if (!view.chat.length) {
      log.innerHTML = '<p class="muted center">수사관이 곧 말을 걸 거예요.</p>';
      return;
    }
    log.innerHTML = view.chat.map(function (m) {
      var mine = m.from === 'sus';
      return '<div class="msg ' + (mine ? 'me' : 'them inv-them') + '"><span class="who">' + (mine ? '나' : '🕵️ 수사관') + ' · ' + VH.clock(m.t) + '</span>' + esc(m.text) + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function verdictText(v) {
    var me = v.myChoice, other = v.partnerChoice;
    if (other == null) return me === 'C' ? '당신은 끝까지 입을 다물었습니다.' : '당신은 동료를 불었습니다.';
    if (me === 'C' && other === 'C') return '두 사람 모두 끝까지 입을 다물었습니다. 둘 다 캔디를 받습니다.';
    if (me === 'D' && other === 'C') return '당신은 동료를 불었고, 동료는 입을 다물었습니다. 캔디를 혼자 가장 많이 받습니다.';
    if (me === 'C' && other === 'D') return '당신은 입을 다물었지만, 동료가 당신을 불었습니다.';
    return '두 사람 모두 서로를 불었습니다. 캔디를 조금만 받습니다.';
  }

  function sideHtml() {
    var v = view, h = '';
    if (v.phase === 'arrest') {
      h += '<div class="card center"><h2>🚨 체포되었습니다</h2><p>곧 수사관이 조사를 시작합니다.</p></div>';
    } else if (v.phase === 'interrogation') {
      if (v.canChoose) {
        h += '<div class="card choice-panel"><h3>최종 진술을 선택하세요</h3>' +
          '<div class="choices">' +
          '<button class="choice C" type="button" data-c="C"><span class="emo">🤐</span>협력<small>입 다물기</small></button>' +
          '<button class="choice D" type="button" data-c="D"><span class="emo">🗣️</span>배반<small>동료 불기</small></button>' +
          '</div><p class="muted center" style="margin-bottom:0">한 번 고르면 바꿀 수 없어요</p></div>';
      } else {
        h += '<div class="locked">✅ 진술 완료<br><span style="font-size:18px;font-weight:600">' + VH.CHOICE_EMOJI[v.myChoice] + ' ' + VH.CHOICE_KO[v.myChoice] +
          '</span><br><span class="muted" style="font-size:17px;font-weight:600">판결을 기다리는 중…</span></div>';
      }
      if (v.rules) {
        h += '<div class="card"><b>🍬 진술에 따라 받는 캔디</b><table class="rules">' +
          '<tr><td>🤐 둘 다 입을 다물면</td><td>' + v.rules.CC + '개</td></tr>' +
          '<tr><td>🗣️ 나만 동료를 불면</td><td>' + v.rules.DC + '개</td></tr>' +
          '<tr><td>🤐 나만 입을 다물면</td><td>' + v.rules.CD + '개</td></tr>' +
          '<tr><td>🗣️ 둘 다 서로를 불면</td><td>' + v.rules.DD + '개</td></tr></table></div>';
      }
    } else if (v.verdict) {
      var vd = v.verdict;
      h += '<div class="card verdict-hero"><h2>⚖️ 판결</h2>' +
        '<p style="font-size:20px;font-weight:700">' + esc(verdictText(vd)) + '</p>' +
        '<div class="muted">내가 받는 캔디</div><div class="big-num">' + vd.myPayout + '</div><div class="unit">🍬 캔디 ' + vd.myPayout + '개</div></div>';
      h += '<div class="verdict-box"><div class="vcell ' + vd.myChoice + '"><div class="nm">나</div><div class="ch">' + VH.CHOICE_EMOJI[vd.myChoice] + ' ' + VH.CHOICE_SHORT[vd.myChoice] + '</div><div class="pay">🍬 ' + vd.myPayout + '개</div></div>';
      if (vd.partnerChoice) {
        h += '<div class="vcell ' + vd.partnerChoice + '"><div class="nm">동료 (' + esc(vd.partnerName) + ')</div><div class="ch">' + VH.CHOICE_EMOJI[vd.partnerChoice] + ' ' + VH.CHOICE_SHORT[vd.partnerChoice] + '</div><div class="pay">🍬 ' + vd.partnerPayout + '개</div></div>';
      }
      h += '</div>';
      if (v.phase === 'done') h += '<div class="card center"><h3>🏁 체험이 끝났습니다. 수고하셨어요!</h3></div>';
    }
    return h;
  }

  var lastSide = '';
  function render() {
    if (!view) return;
    var s = getSess();
    if (view.phase === 'waiting' || view.phase === 'escape') {
      show('scrWait');
      $('waitInfo').textContent = '용의자 ' + view.label + ' · ' + view.teamName + ' — 기기 연결 완료';
      lastChatSig = '';
      return;
    }
    show('scrRoom');
    $('susMain').className = 'sus-main two' + (view.verdict ? ' verdict' : '');
    document.title = '조사실 ' + view.label;
    $('roomLabel').textContent = view.label + ' · ' + view.myName;
    $('chatInput').disabled = !view.canChat;
    renderChat();
    var html = sideHtml();
    if (html !== lastSide) {
      lastSide = html;
      $('side').innerHTML = html;
      var btns = $('side').querySelectorAll('.choice');
      for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', onChoice);
    }
  }

  function onChoice(e) {
    var c = e.currentTarget.getAttribute('data-c');
    VH.confirmBox(VH.CHOICE_EMOJI[c] + ' <b>' + VH.CHOICE_KO[c] + '</b><br>로 최종 진술할까요?<br><span class="muted" style="font-size:17px">확정하면 바꿀 수 없어요.</span>',
      '확정', c === 'C' ? 'green' : 'red', function () {
        socket.emit('sus:choose', { choice: c }, function (r) {
          if (!r || !r.ok) VH.toast((r && r.error) || '선택하지 못했어요.', true);
        });
      });
  }
})();

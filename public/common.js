// 공통 도우미 (구형 브라우저 호환: ?. ?? 사용 안 함)
(function () {
  'use strict';
  var memStore = {};
  function store(kind) {
    var st = null;
    try {
      st = window[kind];
      st.setItem('__vh__', '1');
      st.removeItem('__vh__');
    } catch (e) { st = null; }
    return {
      get: function (k) { try { if (st) return st.getItem(k); } catch (e) {} return Object.prototype.hasOwnProperty.call(memStore, kind + k) ? memStore[kind + k] : null; },
      set: function (k, v) { memStore[kind + k] = v; try { if (st) st.setItem(k, v); } catch (e) {} },
      del: function (k) { delete memStore[kind + k]; try { if (st) st.removeItem(k); } catch (e) {} },
    };
  }
  var LS = store('localStorage');

  var PHASES = ['waiting', 'escape', 'arrest', 'interrogation', 'verdict', 'done'];
  var PHASE_KO = { waiting: '대기', escape: '방탈출', arrest: '체포', interrogation: '심문', verdict: '판결', done: '종료' };
  var PHASE_EMOJI = { waiting: '⏳', escape: '🔐', arrest: '🚨', interrogation: '💬', verdict: '⚖️', done: '🏁' };
  var CHOICE_KO = { C: '협력 (입 다물기)', D: '배반 (동료 불기)' };
  var CHOICE_SHORT = { C: '협력', D: '배반' };
  var CHOICE_EMOJI = { C: '🤐', D: '🗣️' };
  var OUTCOME_KO = { CC: '둘 다 협력', DD: '둘 다 배반', CD: '엇갈림', DC: '엇갈림' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function elapsed(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + pad(s % 60);
  }
  function clock(t) {
    var d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  var toastTimer;
  function toast(msg, bad) {
    var t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast hidden';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast hidden'; }, 3200);
  }
  function phaseSteps(phase) {
    var idx = PHASES.indexOf(phase);
    return '<div class="steps">' + PHASES.map(function (p, i) {
      return '<span class="step ' + (i < idx ? 'past' : i === idx ? 'now ph-' + p : '') + '">' + PHASE_KO[p] + '</span>';
    }).join('<span class="arrow">›</span>') + '</div>';
  }
  function phaseBadge(phase) {
    return '<span class="badge ph-' + phase + '">' + PHASE_EMOJI[phase] + ' ' + PHASE_KO[phase] + '</span>';
  }

  // 서버 시계와의 차이 보정 (태블릿 시계가 틀려도 타이머가 맞도록)
  var skew = 0;
  function syncNow(serverNow) { if (serverNow) skew = serverNow - Date.now(); }
  function serverNow() { return Date.now() + skew; }

  function connBanner(socket) {
    var b = document.createElement('div');
    b.className = 'conn-banner hidden';
    b.textContent = '서버와 연결이 끊겼어요. 다시 연결하는 중…';
    document.body.appendChild(b);
    socket.on('connect', function () { b.className = 'conn-banner hidden'; });
    socket.on('disconnect', function () { b.className = 'conn-banner'; });
    // 태블릿이 잠들었다 깨어날 때 바로 다시 연결
    function wake() { if (!socket.connected) socket.connect(); }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); });
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
  }

  // 운영자 PIN 로그인: 성공하면 onReady(socket) 호출, 재연결 시 자동 재로그인
  function operator(onReady) {
    var socket = io({ transports: ['websocket', 'polling'] });
    window.__vhSocket = socket;
    connBanner(socket);
    var ov = document.createElement('div');
    ov.className = 'login-overlay hidden';
    ov.innerHTML = '<form class="card login-card" autocomplete="off"><h2>🔑 운영자 로그인</h2>' +
      '<p class="muted center">운영자 PIN을 입력하세요</p>' +
      '<input id="pinInput" class="big code" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="off">' +
      '<button class="btn" type="submit">들어가기</button><p id="pinErr" class="err center"></p></form>';
    document.body.appendChild(ov);
    var started = false;
    function tryAuth(pin, manual) {
      socket.emit('op:auth', { pin: pin }, function (r) {
        if (r && r.ok) {
          LS.set('vh_pin', pin);
          ov.className = 'login-overlay hidden';
          if (!started) { started = true; onReady(socket); } else if (onReady.again) onReady.again();
        } else {
          LS.del('vh_pin');
          ov.className = 'login-overlay';
          if (manual) $('pinErr').textContent = (r && r.error) || 'PIN이 틀렸어요.';
          setTimeout(function () { var i = $('pinInput'); if (i) i.focus(); }, 50);
        }
      });
    }
    ov.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      tryAuth($('pinInput').value.trim(), true);
    });
    socket.on('connect', function () {
      var pin = LS.get('vh_pin');
      if (pin) tryAuth(pin, false);
      else { ov.className = 'login-overlay'; setTimeout(function () { $('pinInput').focus(); }, 50); }
    });
    return socket;
  }
  function logout() { LS.del('vh_pin'); location.reload(); }

  function op(socket, action, data, done) {
    var m = data || {};
    m.action = action;
    socket.emit('op', m, function (r) {
      if (!r || !r.ok) {
        toast((r && r.error) || '실패했어요.', true);
        if (r && r.auth) location.reload();
      }
      if (done) done(r || {});
    });
  }

  // 큰 QR 보기 창
  function showQR(title, code, sub) {
    var ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = '<div class="card modal-card center"><h2>' + esc(title) + '</h2>' +
      '<img class="qr big" alt="QR" src="/api/qr.svg?code=' + encodeURIComponent(code) + '">' +
      '<div class="joincode">' + esc(code) + '</div><p class="muted" id="qrUrl"></p>' + (sub ? '<p>' + esc(sub) + '</p>' : '') +
      '<button class="btn light" type="button">닫기</button></div>';
    document.body.appendChild(ov);
    fetch('/api/info').then(function (r) { return r.json(); }).then(function (i) {
      var u = ov.querySelector('#qrUrl'); if (u) u.textContent = i.baseUrl + '/?code=' + code;
    }).catch(function () {});
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.querySelector('button').addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  }
  // 두 용의자 QR 한 번에 보기
  function showBothQR(s) {
    var ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = '<div class="card modal-card center" style="max-width:760px"><h2>🔑 ' + esc(s.teamName) + ' 조사실 코드</h2><div class="row2">' +
      s.suspects.map(function (u) {
        return '<div><b>용의자 ' + u.label + '</b><div class="muted">' + esc(u.name) + '</div><img class="qr" style="width:220px;max-width:38vw" alt="QR" src="/api/qr.svg?code=' + u.code + '"><div class="joincode" style="font-size:44px">' + u.code + '</div></div>';
      }).join('') + '</div><p class="muted">조사실 태블릿 카메라로 QR을 찍거나, 첫 화면에 코드를 입력하세요.</p>' +
      '<button class="btn light block" type="button">닫기</button></div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.querySelector('button').addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  }
  function confirmBox(html, okText, cls, onOk) {
    var ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = '<div class="card modal-card center"><div class="confirm-msg">' + html + '</div>' +
      '<div class="row2"><button class="btn light" type="button" data-x="no">취소</button>' +
      '<button class="btn ' + (cls || '') + '" type="button" data-x="ok">' + esc(okText) + '</button></div></div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.querySelector('[data-x=no]').addEventListener('click', close);
    ov.querySelector('[data-x=ok]').addEventListener('click', function () { close(); onOk(); });
    return ov;
  }

  // 압수 코인 입력 창 (팀 자루 1개, 기록용 · 보상과는 별개)
  function coinDialog(title, def, okText, onOk) {
    var ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = '<div class="card modal-card coin-card center"><h2>' + esc(title) + '</h2>' +
      '<p class="muted" style="margin:0 0 .6rem">자루에 든 골드코인 수 (기록용 · 비워 두면 기본값)</p>' +
      '<div class="stepper"><button class="btn light" type="button" data-d="-1">−</button>' +
      '<input class="big" id="coin0" type="number" inputmode="numeric" min="0" max="9999" value="' + def + '">' +
      '<button class="btn light" type="button" data-d="1">+</button></div>' +
      '<div class="row2" style="margin-top:1rem"><button class="btn light" type="button" data-x="no">취소</button>' +
      '<button class="btn red" type="button" data-x="ok">' + esc(okText) + '</button></div></div>';
    document.body.appendChild(ov);
    var inp = ov.querySelector('#coin0');
    function val() { var n = Math.round(Number(inp.value)); return isFinite(n) && n >= 0 ? n : 0; }
    var steps = ov.querySelectorAll('[data-d]');
    for (var k = 0; k < steps.length; k++) {
      steps[k].addEventListener('click', function (e) { inp.value = Math.max(0, val() + Number(e.currentTarget.getAttribute('data-d'))); });
    }
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.querySelector('[data-x=no]').addEventListener('click', close);
    ov.querySelector('[data-x=ok]').addEventListener('click', function () { var c = inp.value.trim() === '' ? null : val(); close(); onOk(c); });
  }

  window.VH = {
    coinDialog: coinDialog,
    LS: LS, PHASES: PHASES, PHASE_KO: PHASE_KO, PHASE_EMOJI: PHASE_EMOJI, CHOICE_KO: CHOICE_KO, CHOICE_SHORT: CHOICE_SHORT,
    CHOICE_EMOJI: CHOICE_EMOJI, OUTCOME_KO: OUTCOME_KO,
    esc: esc, $: $, elapsed: elapsed, clock: clock, toast: toast, phaseSteps: phaseSteps, phaseBadge: phaseBadge,
    syncNow: syncNow, serverNow: serverNow, connBanner: connBanner, operator: operator, logout: logout, op: op,
    showQR: showQR, showBothQR: showBothQR, confirmBox: confirmBox,
  };
})();

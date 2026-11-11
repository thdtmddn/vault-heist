// 실제 브라우저(헤드리스 크롬)로 각 역할 화면을 눌러 보며 여러 화면 크기에서 스크린샷을 찍고
// 레이아웃(가로 스크롤, 잘림, 페이지 세로 스크롤, 버튼 크기)을 검사합니다.
// 사용법: npm run screenshots   (크롬/크로미움 필요, 서버는 임시 폴더로 자동 실행)
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(__dirname, '..', 'screenshots');
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-shot-'));

// 데스크톱 16:9 (수사관·로비·현황판·용의자·스태프)
const DESKTOP = [
  { n: '1280x720', w: 1280, h: 720 },
  { n: '1366x768', w: 1366, h: 768 },
  { n: '1536x864', w: 1536, h: 864 },
  { n: '1920x1080', w: 1920, h: 1080 },
];
// 잡는 사람: 휴대폰 세로
const PHONE = [
  { n: '360x800', w: 360, h: 800 },
  { n: '390x844', w: 390, h: 844 },
  { n: '412x915', w: 412, h: 915 },
];

let fails = 0;
const check = (c, m) => { if (!c) { console.log('  ✘ ' + m); fails++; } else if (process.env.VERBOSE) console.log('  ✔ ' + m); return c; };
const ok = (m) => console.log('  ✔ ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: TMP, ADMIN_PIN: '' }), stdio: ['ignore', 'pipe', 'inherit'] });
  srv.stdout.resume();
  await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('켜졌어요') && res()));
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });
  const errors = [];
  async function open(url, size, mobile) {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, locale: 'ko-KR', hasTouch: !!mobile, isMobile: !!mobile, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(url + ': ' + e.message));
    await p.goto(BASE + url);
    return p;
  }
  async function login(p) {
    await p.waitForSelector('.login-overlay:not(.hidden)');
    await p.fill('#pinInput', '1234');
    await p.click('.login-card button');
    await p.waitForSelector('.login-overlay.hidden', { state: 'attached' });
  }

  // 레이아웃 검사 + 크기별 스크린샷
  // opts.mustSee: 화면 안에 완전히 보여야 하는 선택자들 / opts.noPageScroll: 페이지 세로 스크롤 금지(16:9)
  async function capture(p, name, sizes, opts) {
    opts = opts || {};
    for (const s of sizes) {
      await p.setViewportSize({ width: s.w, height: s.h });
      await sleep(250);
      const dir = path.join(OUT, s.n);
      fs.mkdirSync(dir, { recursive: true });
      await p.screenshot({ path: path.join(dir, name + '.png'), fullPage: !!opts.full });
      const r = await p.evaluate((mustSee) => {
        const W = window.innerWidth, H = window.innerHeight;
        const de = document.documentElement;
        const out = { hScroll: de.scrollWidth - W, vScroll: Math.max(de.scrollHeight, document.body.scrollHeight) - H, cut: [], small: [], hidden: [], textOverflow: [] };
        const vis = (e) => { const st = getComputedStyle(e); return e.offsetParent !== null && st.visibility !== 'hidden'; };
        document.querySelectorAll('button, .btn, input, .card, .sess, .bsess, .kpi, .msg, .choice').forEach((e) => {
          if (!vis(e) || e.closest('.hidden')) return;
          const b = e.getBoundingClientRect();
          if (b.width === 0) return;
          if (b.right > W + 1 || b.left < -1) out.cut.push((e.className || e.tagName) + ':' + (e.textContent || '').trim().slice(0, 12));
          if ((e.tagName === 'BUTTON' || e.classList.contains('btn')) && b.height < 47.5 && !e.closest('.modal-x')) out.small.push((e.textContent || '').trim().slice(0, 12) + '(' + Math.round(b.height) + ')');
          if (e.tagName === 'BUTTON' && e.scrollWidth > e.clientWidth + 2) out.textOverflow.push((e.textContent || '').trim().slice(0, 15));
        });
        (mustSee || []).forEach((sel) => {
          const e = document.querySelector(sel);
          if (!e) { out.hidden.push(sel + '(없음)'); return; }
          const b = e.getBoundingClientRect();
          if (b.top < -1 || b.bottom > H + 1 || b.left < -1 || b.right > W + 1 || b.height < 1) out.hidden.push(sel + ' [' + Math.round(b.top) + '..' + Math.round(b.bottom) + ' / ' + H + ']');
        });
        return out;
      }, opts.mustSee || []);
      const tag = name + ' @' + s.n;
      check(r.hScroll <= 1, tag + ': 가로 스크롤 없음 (' + r.hScroll + ')');
      check(!r.cut.length, tag + ': 화면 밖으로 잘린 요소 없음 ' + r.cut.slice(0, 4).join(' | '));
      if (opts.noPageScroll) check(r.vScroll <= 1, tag + ': 페이지 세로 스크롤 없음 (' + r.vScroll + 'px 넘침)');
      check(!r.hidden.length, tag + ': 핵심 요소가 화면 안에 보임 ' + r.hidden.join(' | '));
      check(!r.small.length, tag + ': 버튼 높이 48px 이상 ' + r.small.slice(0, 5).join(' | '));
      check(!r.textOverflow.length, tag + ': 버튼 글자 넘침 없음 ' + r.textOverflow.slice(0, 3).join(' | '));
    }
    ok(name + ' (' + sizes.map((s) => s.n).join(', ') + ')');
  }
  const big = DESKTOP[3];
  const WIDE = DESKTOP;

  // ---- 로비 ----
  const lobby = await open('/lobby', big);
  await login(lobby);
  for (const t of [['1팀', '김철수', '이영희'], ['독수리', '박민수', '최지우'], ['3팀', '', ''], ['고양이', '정하늘', '한바다'], ['5조 어벤져스', '강하늘', '윤봄']]) {
    await lobby.fill('#teamName', t[0]); await lobby.fill('#memA', t[1]); await lobby.fill('#memB', t[2]);
    await lobby.click('#regForm button[type=submit]');
    await sleep(120);
  }
  await lobby.waitForFunction(() => document.querySelectorAll('.queue-item').length === 5);
  await lobby.click('.queue-item [data-a=start]'); await sleep(150);
  await lobby.click('.queue-item [data-a=start]'); await sleep(150);
  await lobby.click('.queue-item [data-a=start]'); await sleep(200);
  await lobby.waitForFunction(() => document.querySelectorAll('#active .sess').length === 3);
  const codes = await lobby.$$eval('#active .sus-row .code', (els) => els.map((e) => e.textContent.trim()));
  ok('로비: 5팀 등록, 3팀 시작, 코드 ' + codes.length + '개');

  // ---- 용의자 화면들 ----
  const join = await open('/', big);
  await join.waitForSelector('#scrJoin:not(.hidden)');
  await capture(join, 's1_join', WIDE, { noPageScroll: true, mustSee: ['#joinCode', '#joinForm button'] });
  const susA = await open('/?code=' + codes[0], big);
  const susB = await open('/?code=' + codes[1], big);
  const susA2 = await open('/?code=' + codes[2], big);
  const susB2 = await open('/?code=' + codes[3], big);
  await susA.waitForSelector('#scrWait:not(.hidden)');
  await capture(susA, 's2_wait', WIDE, { noPageScroll: true, mustSee: ['#scrWait h1'] });

  // ---- 잡는 사람 (휴대폰 세로) ----
  const catcher = await open('/catcher', PHONE[1], true);
  await login(catcher);
  await catcher.waitForSelector('.arrest');
  await capture(catcher, 'c1_catcher', PHONE, { mustSee: ['.arrest'] });
  await catcher.click('.arrest');
  await catcher.waitForSelector('.modal [data-x=ok]');
  await capture(catcher, 'c2_confirm', PHONE, { mustSee: ['.modal [data-x=ok]'] });
  await catcher.click('.modal [data-x=ok]');
  await sleep(300);
  await catcher.click('.arrest');
  await catcher.waitForSelector('.modal [data-x=ok]');
  await catcher.click('.modal [data-x=ok]');
  await susA.waitForSelector('#scrRoom:not(.hidden)');
  await sleep(300);
  await capture(catcher, 'c3_catcher_after', PHONE, { mustSee: ['.arrest'] });

  // ---- 수사관 A+B ----
  const inv = await open('/investigator', big);
  await login(inv);
  await inv.waitForSelector('#sessTabs [data-sid]');
  await inv.click('#sessTabs [data-sid]');
  await inv.waitForSelector('#log0');
  await inv.click('[data-side=both]');
  await inv.waitForSelector('#log1');
  const longMsgs = ['네 동료는 벌써 다 불었어.', '지금 말하면 코인은 전부 네 거야.'];
  await inv.click('#cols [data-col="0"] .quick [data-q="0"]');
  await inv.fill('#in1', '네가 먼저 말하면 선처해 줄게. 어떻게 할래?');
  await inv.click('#cols [data-col="1"] .chat-form button');
  await susA.waitForFunction(() => document.getElementById('chatLog').textContent.includes('벌써 다 불었어'));
  for (const t of ['저는 아무것도 몰라요!', '진짜예요. 그냥 구경만 했어요.', '제 동료가 그럴 리가 없어요.']) {
    await susA.fill('#chatInput', t); await susA.click('#chatForm button'); await sleep(80);
  }
  await susB.waitForFunction(() => document.getElementById('chatLog').textContent.includes('선처'));
  check(!(await susB.textContent('#chatLog')).includes('벌써 다 불었어'), 'B 화면에는 A에게 보낸 대사가 안 보임');
  await susB.fill('#chatInput', '음... 생각 좀 해볼게요'); await susB.click('#chatForm button');
  for (let i = 1; i < 6; i++) { await inv.click('#cols [data-col="0"] .quick [data-q="' + i + '"]'); await sleep(60); }
  await inv.waitForFunction(() => document.getElementById('log0').textContent.includes('구경만') && document.getElementById('log1').textContent.includes('생각 좀'));
  await sleep(200);
  await capture(susA, 's3_interrogation', WIDE, { noPageScroll: true, mustSee: ['#chatInput', '#chatForm button', '.choice.C', '.choice.D'] });
  await susA.click('.choice.C');
  await susA.waitForSelector('.modal');
  await capture(susA, 's4_confirm', WIDE, { noPageScroll: true, mustSee: ['.modal [data-x=ok]'] });
  await susA.click('.modal [data-x=ok]');
  await susA.waitForSelector('.locked');
  await capture(susA, 's5_chosen', WIDE, { noPageScroll: true, mustSee: ['.locked', '#chatInput'] });
  await inv.waitForFunction(() => document.getElementById('st0').textContent.includes('선택 완료'));
  await capture(inv, 'i1_investigator_AB', WIDE, { noPageScroll: true, mustSee: ['#in0', '#in1', '#cols [data-col="1"] .chat-form button', '#cols [data-col="0"] .quick'] });

  // ---- 수사관 A만 / B만 ----
  const inv2 = await open('/investigator?side=A', big);
  await login(inv2);
  await inv2.waitForSelector('#sessTabs [data-sid]');
  const tabs = await inv2.$$('#sessTabs [data-sid]');
  await tabs[1].click();
  await inv2.waitForSelector('#log0');
  check(!(await inv2.$('#log1')), '수사관 A만 모드: B 채팅창 없음');
  await inv2.click('#cols .quick [data-q="2"]');
  await susA2.waitForFunction(() => document.getElementById('chatLog').textContent.includes('주범'));
  await capture(inv2, 'i2_investigator_A_only', WIDE, { noPageScroll: true, mustSee: ['#in0', '#cols .chat-form button', '#cols .quick [data-q="9"]'] });
  await inv2.click('[data-side=B]');
  await inv2.waitForSelector('#log1');
  await capture(inv2, 'i3_investigator_B_only', WIDE, { noPageScroll: true, mustSee: ['#in1', '#cols .quick [data-q="9"]'] });

  // ---- 둘 다 선택 → 공개 대기 (바로 판결이 나지 않음) ----
  await susB.click('.choice.D');
  await susB.click('.modal [data-x=ok]');
  await susA.waitForSelector('.await-reveal');
  await susB.waitForSelector('.await-reveal');
  check(!(await susA.$('.verdict-hero')) && !(await susB.$('.verdict-hero')), '공개 전에는 용의자 화면에 판결이 안 뜸');
  await inv.waitForSelector('[data-act=reveal]');
  await capture(susA, 's5b_waiting_reveal', WIDE, { noPageScroll: true, mustSee: ['.await-reveal'] });
  await capture(inv, 'i5_investigator_reveal', WIDE, { noPageScroll: true, mustSee: ['[data-act=reveal]', '.reveal-hint'] });

  // ---- 판결 (수사관이 결과 공개) ----
  await inv.click('[data-act=reveal]');
  await susA.waitForSelector('.verdict-hero');
  await susB.waitForSelector('.verdict-hero');
  check((await susA.textContent('.big-num')).trim() === '0' && (await susB.textContent('.big-num')).trim() === '5', '판결: A 협력 캔디 0 / B 배반 캔디 5');
  await capture(susB, 's6_verdict_B', WIDE, { noPageScroll: true, mustSee: ['.big-num', '.verdict-box'] });
  await capture(susA, 's7_verdict_A', [big], { noPageScroll: true, mustSee: ['.big-num', '.verdict-box'] });
  await inv.waitForSelector('#dVerdict .vchip');
  await capture(inv, 'i4_investigator_verdict', WIDE, { noPageScroll: true, mustSee: ['#dVerdict', '#in0'] });
  await susA2.click('.choice.D'); await susA2.click('.modal [data-x=ok]');
  await susB2.click('.choice.D'); await susB2.click('.modal [data-x=ok]');
  await susB2.waitForSelector('.await-reveal');
  await inv2.waitForSelector('[data-act=reveal]');
  await inv2.click('[data-act=reveal]'); // A만/B만 모드에서도 공개 가능
  await susB2.waitForSelector('.verdict-hero');
  check((await susA2.textContent('.big-num')).trim() === '1' && (await susB2.textContent('.big-num')).trim() === '1', '판결: 둘 다 배반 → 캔디 1 / 1');
  await lobby.click('#active [data-a=finish]');
  await sleep(200);
  await susA.waitForFunction(() => document.body.textContent.includes('체험이 끝났습니다'));
  await capture(susA, 's8_done', WIDE, { noPageScroll: true, mustSee: ['.big-num'] });

  // ---- 현황판 / 스태프 ----
  // 먼저 대기 2팀일 때: 행 높이가 늘어나지 않는지 확인
  const board = await open('/board', big);
  await board.waitForFunction(() => document.querySelectorAll('.bq-item').length === 2);
  await sleep(300);
  await capture(board, 'b1_board', WIDE, { noPageScroll: true, mustSee: ['#qTotal', '#queue', '.bq-item', '.bq-wait', '.kpis', '#kRet', '#recent'] });
  const qHeights = await board.$$eval('.bq-item', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  check(qHeights.length === 2 && qHeights.every((h) => Math.abs(h - qHeights[0]) <= 2) && qHeights[0] >= 50 && qHeights[0] <= 140, '대기 2팀일 때 행 높이가 고정됨 (' + qHeights.join(', ') + 'px)');
  const qTxt = await board.textContent('#queue');
  check(qTxt.includes('약') && (qTxt.includes('분') || qTxt.includes('곧 시작')), '현황판 대기열에 예상 대기 시간이 보임');
  check((await board.textContent('#qTotal')).includes('2팀'), '현황판 상단에 대기 2팀이 보임');
  const boardTxt = await board.textContent('body');
  check(!codes.some((c) => boardTxt.includes(c)), '현황판에 참가 코드가 보이지 않음');
  // 긴 대기열: 앞부분 + "+N팀 더"
  for (const tm of [['호랑이', '', ''], ['여우', '', ''], ['늑대', '', ''], ['토끼', '', ''], ['곰', '', ''], ['사자', '', ''], ['원숭이', '', '']]) {
    await lobby.fill('#teamName', tm[0]); await lobby.fill('#memA', tm[1]); await lobby.fill('#memB', tm[2]);
    await lobby.click('#regForm button[type=submit]');
    await sleep(80);
  }
  await lobby.waitForFunction(() => document.querySelectorAll('.queue-item').length >= 9);
  await board.waitForFunction(() => (document.getElementById('qTotal') || {}).textContent && document.getElementById('qTotal').textContent.indexOf('9팀') >= 0);
  await sleep(200);
  await capture(board, 'b2_board_long', WIDE, { noPageScroll: true, mustSee: ['#qTotal', '.bq-item', '.bq-more'] });
  const staff = await open('/staff', big);
  await staff.waitForSelector('.links .card img');
  await sleep(300);
  await capture(staff, 'f1_staff', WIDE, { noPageScroll: true, mustSee: ['.links .card:last-child img'] });

  // ---- 로비 (데스크톱) ----
  console.log('  … 로비 캡처');
  await lobby.waitForSelector('#done .done-item');
  check(!!(await lobby.$('#done .done-item')), '로비에 종료된 팀 블록이 있음');
  await capture(lobby, 'l1_lobby', DESKTOP, { full: true, mustSee: ['#teamName', '#regForm button[type=submit]'] });
  await lobby.click('#active [data-a=tools]');
  await sleep(200);
  await lobby.click('.queue-item [data-a=qr]');
  await lobby.waitForSelector('.modal img.qr');
  await capture(lobby, 'l3_lobby_qr', DESKTOP, { mustSee: ['.modal .btn.light'] });
  await lobby.click('.modal .btn.light');

  // 새로고침해도 이어짐
  await susA.reload();
  await susA.waitForSelector('.verdict-hero');
  ok('조사실 기기 새로고침 → 판결 화면 그대로');
  await inv.reload();
  await inv.waitForSelector('#dVerdict .vchip');
  ok('수사관 새로고침 → PIN 다시 안 묻고 같은 세션으로');
  check(errors.length === 0, '페이지 자바스크립트 오류 없음' + (errors.length ? ': ' + errors.join(' / ') : ''));

  await browser.close();
  srv.kill('SIGTERM');
  console.log(fails ? `\n✘ ${fails}개 실패` : '\n모두 통과');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

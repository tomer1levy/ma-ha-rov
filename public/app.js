(() => {
  'use strict';

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const socket = io();
  const isHost = ['/', '/host'].includes(window.location.pathname.replace(/\/$/, '') || '/');
  const params = new URLSearchParams(window.location.search);
  let code = (params.get('room') || '').toUpperCase();
  let token = null;
  let playerId = null;
  let playerName = '';
  let state = null;
  let myState = null;
  let questions = null;
  let editing = false;
  let draft = '';
  let guessValue = null;
  let inviteBase = window.location.origin;
  let socketOnline = false;
  let ready = false;
  let lastError = '';
  let toastTimer;

  const $ = (selector) => app.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const getStorage = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const setStorage = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
  }
  function emit(event, data) {
    return new Promise((resolve, reject) => {
      socket.timeout(7000).emit(event, data, (e, result) => {
        if (e) return reject(new Error('החיבור לא מגיב. נסו שוב.'));
        if (!result?.ok) return reject(new Error(result?.error || 'הפעולה נכשלה.'));
        resolve(result);
      });
    });
  }
  async function act(event, data) {
    try { return await emit(event, data); }
    catch (e) { toast(e.message); return null; }
  }
  function setRoute(room) {
    const url = new URL(window.location.href);
    url.searchParams.set('room', room);
    window.history.replaceState(null, '', url.pathname + url.search);
  }
  function linkToRoom() { return `${inviteBase.replace(/\/$/, '')}/play?room=${encodeURIComponent(code)}`; }
  function roomHeader() {
    return `<header class="topbar"><div class="brand"><span class="brand-dot">?</span> מה הרוב?</div>
      <div class="pills"><span class="pill"><span class="status-dot" style="background:${socketOnline ? '#5eead4' : '#fbc974'}"></span>${socketOnline ? 'מחוברים בזמן אמת' : 'מתחברים מחדש…'}</span>${code ? `<span class="pill">חדר <b class="mono">${esc(code)}</b></span>` : ''}</div></header>`;
  }
  function scoreboard(players = [], compact = false) {
    if (!players.length) return '<div class="no-players">השחקנים יופיעו כאן כשיצטרפו.</div>';
    return `<div>${players.map((p, i) => `<div class="score-row"><div><span class="rank">${i + 1}.</span><b>${esc(p.name)}</b>${!p.connected ? ' <span class="tiny-muted">(לא מחובר)</span>' : ''}${!compact && p.earned !== null && p.earned > 0 ? `<div class="tiny-muted">+${p.earned} בסבב האחרון</div>` : ''}</div><div class="score">${p.score}</div></div>`).join('')}</div>`;
  }
  function progress() {
    const label = { waiting: 'חדר המתנה', voting: 'בחירה אישית', guessing: 'הימור על התוצאות', results: 'חשיפת תוצאות', finished: 'סיום המשחק' }[state.phase];
    const seq = state.phase === 'waiting' ? 0 : state.phase === 'voting' ? 1 : state.phase === 'guessing' ? 2 : 3;
    return `<div class="round-head"><div><div class="eyebrow">${state.phase === 'waiting' ? 'מתארגנים' : `סבב ${state.round} מתוך ${state.totalRounds}`}</div><span class="text-muted">${label}</span></div><div class="steps">${['בוחרים', 'מהמרים', 'מגלים'].map((x, i) => `<span class="step ${i + 1 === seq ? 'current' : i + 1 < seq ? 'done' : ''}">${x}</span>`).join('')}</div></div>`;
  }
  function resultPanel() {
    if (!state?.result || !state.question) return '';
    const r = state.result;
    return `<div class="results-numbers"><div><div class="label">${esc(state.question.a)}</div><strong>${r.aCount}</strong><div class="small">${r.percentA}% מהמצביעים</div></div><div><div class="label">${esc(state.question.b)}</div><strong>${r.bCount}</strong><div class="small">${100 - r.percentA}% מהמצביעים</div></div></div>
      <div class="bar-container"><div class="bar-a" style="width:${r.percentA}%">${r.percentA >= 19 ? r.percentA + '%' : ''}</div><div class="bar-b" style="width:${100 - r.percentA}%">${100 - r.percentA >= 19 ? 100 - r.percentA + '%' : ''}</div></div><p class="small">${plural(r.total, 'משתתף הצביע', 'משתתפים הצביעו')} בסבב הזה.</p>`;
  }
  function votingPanel(disabled = false, selected = null) {
    return `<div class="question">${esc(state.question.question)}</div><div class="choices"><button type="button" data-action="vote" data-choice="a" class="choice ${selected === 'a' ? 'active' : ''}" ${disabled ? 'disabled' : ''}><small>אפשרות א׳</small>${esc(state.question.a)}</button><button type="button" data-action="vote" data-choice="b" class="choice ${selected === 'b' ? 'active' : ''}" ${disabled ? 'disabled' : ''}><small>אפשרות ב׳</small>${esc(state.question.b)}</button></div>`;
  }
  function hostView() {
    if (!code || !state) {
      const oldCode = getStorage('majority:last-host');
      return `${roomHeader()}<section class="panel"><div class="eyebrow">מחשב ראשי</div><h1 class="hero">משחק דילמות.<br>הקהל מחליט.</h1><p class="lead">מקרינים שאלות על המסך, המשתתפים בוחרים בטלפון ומנחשים את התפלגות התשובות. ניקוד חי וטבלת מובילים.</p>
        <button class="btn" data-action="create">צור חדר משחק חדש</button>${oldCode && getStorage(`majority:host:${oldCode}`) ? `<button class="btn secondary" data-action="resume" data-code="${esc(oldCode)}" style="margin-inline-start:10px">חזור לחדר ${esc(oldCode)}</button>` : ''}</section><div class="footer">לא נדרשת התקנה בטלפונים: הכול עובד בדפדפן.</div>`;
    }
    const isWaiting = state.phase === 'waiting';
    const base = `${roomHeader()}<div class="grid-host"><main><section class="panel">${progress()}`;
    let main = '';
    if (isWaiting) {
      main = `<div class="eyebrow">כולם בפנים?</div><h1 class="hero">מוכנים לגלות<br>מה הרוב חושב?</h1><p class="lead">תנו לכולם לסרוק את הקוד ולהצטרף. לאחר מכן התחילו את המשחק.</p><div class="pills"><span class="pill">${plural(state.players.length, 'משתתף', 'משתתפים')} בחדר</span><span class="pill">${plural(state.totalRounds, 'שאלה', 'שאלות')}</span></div><div class="space-top"><button class="btn" data-action="next">התחל משחק <span aria-hidden="true">←</span></button></div>`;
    } else if (state.phase === 'voting') {
      main = votingPanel(true) + `<div class="space-top"><div class="between"><b>הצביעו: ${state.votedCount} / ${state.players.length}</b><span class="small">אפשר להמתין לכולם</span></div><div class="progress"><div class="progress-fill" style="width:${state.players.length ? (100 * state.votedCount / state.players.length) : 0}%"></div></div><button class="btn full margin-top" data-action="lock" ${state.votedCount === 0 ? 'disabled' : ''}>סגור הצבעה ועבור להימורים</button></div>`;
    } else if (state.phase === 'guessing') {
      main = `<div class="eyebrow">ההצבעות נסגרו — התוצאות עדיין סודיות</div><div class="question">כמה מתוך ${state.guessTotal} הצביעו ל־<span style="color:var(--purple)">${esc(state.question.a)}</span>?</div><p class="lead">כל משתתף מהמר על מספר האנשים שבחרו באפשרות א׳.</p><div class="between"><b>שלחו הימור: ${state.guessCount} / ${state.guessTotal}</b><span class="small">ההימור נשאר סודי</span></div><div class="progress"><div class="progress-fill" style="width:${state.guessTotal ? 100 * state.guessCount / state.guessTotal : 0}%"></div></div><button class="btn mint full margin-top" data-action="reveal">חשוף תוצאות וחלק ניקוד</button>`;
    } else if (state.phase === 'results') {
      main = `<div class="question">${esc(state.question.question)}</div>${resultPanel()}<button class="btn full space-top" data-action="next">${state.index + 1 >= state.totalRounds ? 'הצג תוצאות סופיות' : 'לשאלה הבאה ←'}</button>`;
    } else {
      const winners = state.players.length ? state.players.filter(p => p.score === state.players[0].score) : [];
      main = `<div class="eyebrow">סיימנו!</div><div class="winner">🏆 ${winners.length ? esc(winners.map(p => p.name).join(' ו־')) : 'המשחק הסתיים'}</div><p class="lead">${winners.length ? `עם ${winners[0].score} נקודות. ` : ''}הנה טבלת הדירוג הסופית.</p>${scoreboard(state.players)}<button class="btn secondary margin-top" data-action="restart">משחק חדש עם אותם משתתפים</button>`;
    }
    const left = `${base}${main}</section>${isWaiting ? `<section class="panel space-top"><div class="between"><h3>שאלות המשחק</h3><button class="btn tiny secondary" data-action="toggle-edit">${editing ? 'סגור עריכה' : 'ערוך שאלות'}</button></div>${editing ? `<p class="small">שאלה אחת בכל שורה, בפורמט: שאלה | אפשרות א׳ | אפשרות ב׳. אפשר לשים עד 100 שאלות.</p><textarea id="questions-draft" class="textarea" spellcheck="false">${esc(draft)}</textarea><div class="margin-top"><button class="btn tiny mint" data-action="save-questions">שמור שאלות</button></div>` : `<p class="small">${plural(state.totalRounds, 'שאלה מוכנה', 'שאלות מוכנות')}. אפשר להחליף את כולן לפני שמתחילים.</p>`}</section>` : ''}</main>`;
    const showQr = state.phase === 'waiting' || state.phase === 'voting';
    const sidebar = `<aside><section class="panel"><h2>${showQr ? 'הצטרפות למשחק' : 'טבלת המובילים'}</h2>${showQr ? `<div class="center"><div class="label">קוד החדר</div><div class="code">${esc(code)}</div><img class="qr" alt="קוד QR להצטרפות" src="/api/qr?value=${encodeURIComponent(linkToRoom())}"><div class="join-link">${esc(linkToRoom())}</div><button class="btn tiny secondary margin-top" data-action="copy-link">העתק קישור</button></div><div class="divider"></div>` : ''}<h3>${state.phase === 'finished' ? 'הדירוג הסופי' : `משתתפים (${state.players.length})`}</h3>${scoreboard(state.players, true)}</section><section class="panel space-top"><h3>כלי מנהל</h3><button class="btn secondary tiny" data-action="fullscreen">מסך מלא</button>${showQr ? `<div class="divider"></div><label class="label" for="base-url">כתובת להצטרפות (ל־QR)</label><div class="form-row"><input class="input" id="base-url" value="${esc(inviteBase)}" placeholder="http://192.168.1.10:3000"><button class="btn tiny outline" data-action="update-url">עדכן</button></div><p class="muted-list">אם הטלפונים לא פותחים את הקישור, ודאו שיש להם חיבור לאינטרנט ושהכתובת מתחילה ב־https://.</p>` : ''}</section></aside></div><div class="footer">מה הרוב? • אין צורך באפליקציה • הסבב מתקדם לפי החלטת המנחה</div>`;
    return left + sidebar;
  }
  function playerView() {
    if (!code || !playerId || !state || !myState) {
      return `${roomHeader()}<main class="player-layout"><section class="panel"><div class="eyebrow">הצטרפות למשחק</div><h1 class="hero">מה אתם חושבים?<br>ומה חושב הרוב?</h1><p class="lead">בחרו בין שתי אפשרויות, נחשו כמה אנשים הסכימו איתכם — וצברו נקודות.</p><form id="join-form" class="stack"><div><label class="label" for="room-code">קוד החדר</label><input class="input" id="room-code" name="room" autocomplete="off" value="${esc(code)}" maxlength="6" required placeholder="לדוגמה: ABC123" dir="ltr" style="text-align:center;letter-spacing:.1em;text-transform:uppercase"></div><div><label class="label" for="player-name">איך קוראים לכם?</label><input class="input" id="player-name" name="name" maxlength="32" required value="${esc(playerName)}" placeholder="השם שיופיע בטבלת הניקוד"></div><button class="btn full" type="submit">אני בפנים!</button></form></section></main>`;
    }
    const head = `${roomHeader()}<main class="player-layout"><section class="panel">${progress()}`;
    let content = '';
    if (state.phase === 'waiting') {
      content = `<div class="welcome-box"><div class="eyebrow">ברוכים הבאים</div><h1 style="font-size:31px;margin:0 0 9px">${esc(playerName)}, אתם במשחק! 🎉</h1><div class="text-muted">המנחה יתחיל את המשחק כשכולם יהיו מוכנים.</div></div><div class="between"><span>משתתפים בחדר</span><b>${state.players.length}</b></div><div class="note margin-top">בכל סבב קודם בוחרים אפשרות, אחר כך מנחשים כמה בחרו באפשרות א׳. הניקוד נקבע לפי דיוק ההימור.</div>`;
    } else if (state.phase === 'voting') {
      content = votingPanel(false, myState.vote) + `<div class="note margin-top">${myState.vote ? '✓ הבחירה נשמרה! אפשר לשנות אותה עד שהמנחה יסגור את ההצבעה.' : 'בחרו לפי ההעדפה האישית שלכם. בינתיים אף אחד לא רואה את התפלגות התשובות.'}</div>`;
    } else if (state.phase === 'guessing') {
      const n = state.guessTotal;
      if (!myState.vote) {
        content = `<div class="question">סבב הניחושים התחיל</div><div class="note">לא הצבעתם לפני סגירת ההצבעה, ולכן לא תוכלו להמר בסבב הזה. אפשר להצטרף לסבב הבא.</div>`;
      } else {
        if (guessValue === null) guessValue = Number.isInteger(myState.guess) ? myState.guess : Math.round(n / 2);
        guessValue = Math.min(n, Math.max(0, guessValue));
        content = `<div class="eyebrow">זמן להמר</div><div class="question">כמה מתוך ${n} בחרו ב־<span style="color:var(--purple)">${esc(state.question.a)}</span>?</div><div class="guess-val" id="guess-number">${guessValue}</div><div class="guess-caption" id="guess-caption">מתוך ${n} מצביעים (${n ? Math.round(100 * guessValue / n) : 0}%)</div><input class="slider" type="range" min="0" max="${n}" value="${guessValue}" step="1" id="guess-slider" aria-label="ההימור על מספר האנשים שבחרו באפשרות א׳"><div class="between"><span class="small">0 בחרו בא׳</span><span class="small">כולם בחרו בא׳</span></div><button class="btn mint full margin-top" data-action="guess">${Number.isInteger(myState.guess) ? 'עדכן הימור' : 'שלח הימור'}</button><div class="note margin-top">${Number.isInteger(myState.guess) ? `✓ ניחוש שמור: ${myState.guess} מתוך ${n}. אפשר לשנות עד חשיפת התוצאות.` : 'ההתפלגות עדיין מוסתרת. הניחוש יכול להיות בין 0 למספר המצביעים.'}</div>`;
      }
    } else if (state.phase === 'results') {
      content = `<div class="question">${esc(state.question.question)}</div>${resultPanel()}${Number.isInteger(myState.guess) ? `<div class="welcome-box margin-top"><div class="label">הניחוש שלכם: ${myState.guess} בחרו בא׳</div><div class="big-number">+${myState.earned}</div><div>נקודות בסבב הזה</div></div>` : `<div class="note margin-top">לא הוגש ניחוש בסבב הזה.</div>`}<div class="between"><b>סה״כ ניקוד אישי</b><span class="score">${myState.score}</span></div><div class="note margin-top">ממתינים לשאלה הבאה מהמנחה…</div>`;
    } else {
      const winners = state.players.length ? state.players.filter(p => p.score === state.players[0].score) : [];
      content = `<div class="eyebrow">סוף המשחק</div><div class="winner">🏆 ${esc(winners.map(p => p.name).join(' ו־') || 'כל הכבוד לכולם!')}</div><div class="welcome-box margin-top"><div class="label">הניקוד הסופי שלכם</div><div class="big-number">${myState.score}</div></div><h3>טבלת הניקוד</h3>${scoreboard(state.players)}`;
    }
    return `${head}${content}</section>${state.phase !== 'finished' && state.phase !== 'waiting' ? `<section class="panel space-top"><div class="between"><span class="small">${esc(playerName)}</span><b class="score">${myState.score} נק׳</b></div></section>` : ''}</main>`;
  }
  function render() { app.innerHTML = isHost ? hostView() : playerView(); }

  async function restore() {
    if (isHost) {
      if (!code) return render();
      token = getStorage(`majority:host:${code}`);
      if (!token) { code = ''; state = null; return render(); }
      const result = await act('host:attach', { code, token });
      if (!result) { code = ''; state = null; return render(); }
    } else {
      if (!code) return render();
      playerId = getStorage(`majority:player:${code}`);
      playerName = getStorage(`majority:name:${code}`) || '';
      if (playerId && playerName) {
        const result = await act('player:join', { code, name: playerName, playerId });
        if (!result) { playerId = null; myState = null; state = null; render(); }
      } else render();
    }
  }

  socket.on('connect', () => {
    socketOnline = true;
    if (ready) { state = null; myState = null; }
    ready = true;
    restore();
    render();
  });
  socket.on('disconnect', () => { socketOnline = false; render(); });
  socket.on('room:state', next => {
    if (!code || next.code !== code) return;
    const prevPhase = state?.phase;
    const prevIndex = state?.index;
    state = next;
    if (next.index !== prevIndex || next.phase !== prevPhase) guessValue = null;
    render();
  });
  socket.on('player:state', next => {
    myState = next;
    playerId = next.id;
    playerName = next.name;
    render();
  });
  socket.on('host:questions', next => {
    questions = next;
    if (!editing) draft = next.map(q => `${q.question} | ${q.a} | ${q.b}`).join('\n');
  });

  app.addEventListener('submit', async event => {
    if (event.target.id !== 'join-form') return;
    event.preventDefault();
    const form = event.target;
    const room = String(form.elements.room.value).trim().toUpperCase();
    const name = String(form.elements.name.value).trim();
    playerName = name;
    const response = await act('player:join', { code: room, name, playerId: room === code ? playerId : null });
    if (!response) return;
    code = response.code;
    playerId = response.id;
    playerName = response.name;
    setStorage(`majority:player:${code}`, playerId);
    setStorage(`majority:name:${code}`, playerName);
    setRoute(code);
    render();
  });

  app.addEventListener('input', event => {
    if (event.target.id === 'questions-draft') draft = event.target.value;
    if (event.target.id === 'guess-slider') {
      guessValue = Number(event.target.value);
      $('#guess-number').textContent = guessValue;
      $('#guess-caption').textContent = `מתוך ${state.guessTotal} מצביעים (${Math.round(100 * guessValue / state.guessTotal)}%)`;
    }
  });

  app.addEventListener('click', async event => {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    const action = control.dataset.action;
    if (action === 'create') {
      const result = await act('host:create', {});
      if (!result) return;
      code = result.code; token = result.token;
      setStorage(`majority:host:${code}`, token);
      setStorage('majority:last-host', code);
      setRoute(code);
      render();
    } else if (action === 'resume') {
      code = control.dataset.code;
      setRoute(code);
      restore();
    } else if (action === 'toggle-edit') {
      editing = !editing;
      if (editing && !draft && questions) draft = questions.map(q => `${q.question} | ${q.a} | ${q.b}`).join('\n');
      render();
    } else if (action === 'save-questions') {
      const rows = draft.split('\n').map(s => s.trim()).filter(Boolean);
      const parsed = rows.map(row => row.split('|').map(x => x.trim()));
      if (!rows.length || parsed.some(items => items.length !== 3 || items.some(item => !item))) {
        return toast('יש להזין שאלה אחת בכל שורה: שאלה | אפשרות א׳ | אפשרות ב׳');
      }
      const qs = parsed.map(([question, a, b]) => ({ question, a, b }));
      if (await act('host:questions:set', { code, questions: qs })) {
        editing = false;
        toast(`${qs.length} שאלות נשמרו בהצלחה.`);
        render();
      }
    } else if (action === 'next') {
      await act('host:next', { code });
    } else if (action === 'lock') {
      await act('host:lock', { code });
    } else if (action === 'reveal') {
      await act('host:reveal', { code });
    } else if (action === 'restart') {
      await act('host:restart', { code });
    } else if (action === 'vote') {
      const prev = myState?.vote;
      if (myState) { myState.vote = control.dataset.choice; render(); }
      const result = await act('player:vote', { code, choice: control.dataset.choice });
      if (!result && myState) { myState.vote = prev; render(); }
    } else if (action === 'guess') {
      const response = await act('player:guess', { code, guess: guessValue });
      if (response) toast('ההימור נשמר!');
    } else if (action === 'copy-link') {
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(linkToRoom());
        else window.prompt('העתיקו את הקישור:', linkToRoom());
        toast('הקישור מוכן לשיתוף.');
      } catch { window.prompt('העתיקו את הקישור:', linkToRoom()); }
    } else if (action === 'update-url') {
      const input = $('#base-url')?.value.trim().replace(/\/$/, '');
      if (!/^https?:\/\/[^\s]+$/i.test(input || '')) return toast('נא להזין כתובת מלאה שמתחילה ב־http:// או https://');
      inviteBase = input;
      render();
      toast('הקישור וקוד ה־QR עודכנו.');
    } else if (action === 'fullscreen') {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => toast('לא ניתן להיכנס למסך מלא בדפדפן זה.'));
    }
  });

  fetch('/api/info').then(r => r.json()).then(data => {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      inviteBase = data.suggestedBase || window.location.origin;
      render();
    }
  }).catch(() => {});
  render();
})();

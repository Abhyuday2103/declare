import * as E from './engine.js';
import { firebaseConfig } from './firebase-config.js';

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('dc_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('dc_' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem('dc_' + k); } catch (e) { /* storage blocked */ } },
};
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

// ---------- servers ----------
// Practice: the whole game runs in this browser.
class LocalServer {
  constructor(name, bots) {
    this.mode = 'local';
    this.uid = 'me';
    this.st = E.createTable('PRACTICE', 'me', name);
    for (let i = 0; i < bots; i++) E.dispatch(this.st, 'me', { type: 'addBot' });
    this.timer = setInterval(() => {
      let acted = false;
      try { acted = E.runBots(this.st, Date.now()); } catch (e) { console.error(e); }
      if (acted) this.emit();
    }, 150);
  }
  watch(cb) { this.cb = cb; this.emit(); }
  emit() { this.st.now = Date.now(); if (this.cb) this.cb(E.viewFor(this.st, this.uid)); }
  async act(a) {
    const snap = structuredClone(this.st);
    try { E.dispatch(this.st, this.uid, a, Date.now()); } catch (e) { this.st = snap; throw e; }
    this.emit();
  }
  stop() { clearInterval(this.timer); }
}

// Online: the Firebase function owns the deck and every card. This browser only ever sees its own view.
let fb = null;
async function firebase() {
  if (fb) return fb;
  if (!firebaseConfig) throw new Error('Online play is not set up yet. Add your Firebase config (see README).');
  const base = new URL('./p2p/', import.meta.url).href; // online play runs host-to-player now, see p2p/core.js
  const [appM, authM, fsM, fnM] = await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js', 'firebase-functions.js'].map((f) => import(base + f)));
  const app = appM.initializeApp(firebaseConfig);
  const auth = authM.getAuth(app);
  await auth.authStateReady();
  if (!auth.currentUser) await authM.signInAnonymously(auth);
  const db = fsM.initializeFirestore(app, { experimentalForceLongPolling: true });
  const call = fnM.httpsCallable(fnM.getFunctions(app), 'dc', { timeout: 15000 });
  const ref = (id) => fsM.doc(db, 'dtables', id, 'views', auth.currentUser.uid);
  fb = {
    uid: auth.currentUser.uid,
    call: async (data) => { try { return (await call(data)).data; } catch (e) { throw new Error(e.message || 'Request failed'); } },
    watch: (id, cb) => fsM.onSnapshot(ref(id), (s) => { if (s.exists()) cb(JSON.parse(s.data().json)); }, () => { /* poll covers it */ }),
    get: async (id) => { const s = await fsM.getDoc(ref(id)); return s.exists() ? JSON.parse(s.data().json) : null; },
  };
  return fb;
}
class CloudServer {
  constructor(api, code) { this.mode = 'cloud'; this.api = api; this.code = code; this.uid = api.uid; this.ticking = false; }
  watch(cb) {
    this.cb = cb;
    this.unsub = this.api.watch(this.code, cb);
    this.poll = setInterval(() => this.refresh(), 3000);
    this.botTimer = setInterval(() => this.tick(), 500);
    this.onVis = () => { if (document.visibilityState === 'visible') this.relisten(); };
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('online', this.onVis);
  }
  relisten() { if (this.unsub) this.unsub(); this.unsub = this.api.watch(this.code, this.cb); this.refresh(); }
  async refresh() { try { const v = await this.api.get(this.code); if (v) this.cb(v); } catch (e) { /* next poll */ } }
  async tick() {
    // Computer players at an online table move when someone's browser nudges the server.
    const v = view;
    if (this.ticking || !v || v.phase !== 'play' || !v.botAt) return;
    const botTurn = v.players.find((p) => p.uid === v.turn && p.bot);
    const botGive = v.pendingGive && v.players.find((p) => p.uid === v.pendingGive.uid && p.bot);
    if (!botTurn && !botGive && !v.snapOpen) return;
    if (srvNow() < v.botAt) return;
    this.ticking = true;
    try { const r = await this.api.call({ op: 'tick', tableId: this.code }); if (r && r.view) this.cb(r.view); } catch (e) { /* ignore */ }
    setTimeout(() => { this.ticking = false; }, 600);
  }
  async act(a) {
    const r = await withTimeout(this.api.call({ op: 'act', tableId: this.code, action: a }), 12000);
    if (r && r.view) this.cb(r.view);
  }
  stop() {
    if (this.unsub) this.unsub();
    clearInterval(this.poll); clearInterval(this.botTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('online', this.onVis);
  }
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('That took too long. Check your connection and try again.')), ms))]);
}

// ---------- app state ----------
let server = null;
let view = null;
let offset = 0;
const srvNow = () => Date.now() + offset;
const ui = { mode: null, sel: null, busy: false, lastMoved: 0, declareOpen: false };

function onView(v) {
  if (!v) return;
  if (view && v.handNo === view.handNo && v.seq < view.seq && v.id === view.id) return; // stale
  if (v.serverNow) offset = v.serverNow - Date.now();
  if (view && view.handNo !== v.handNo) Object.assign(ui, { mode: null, sel: null, declareOpen: false });
  view = v;
  render();
}
async function act(a) {
  if (!server || ui.busy) return;
  ui.busy = true;
  try { await server.act(a); }
  catch (e) { toast(e.message); }
  finally { ui.busy = false; render(); }
}

// ---------- home ----------
const nameInput = $('#name');
nameInput.value = store.get('name', '');
const getName = () => {
  const n = nameInput.value.trim();
  if (!n) { nameInput.focus(); toast('Put your name in first.'); return null; }
  store.set('name', n);
  return n;
};
if (globalThis.DC_PRACTICE_ONLY) {
  $('#create').closest('.panel').hidden = true;
} else if (!firebaseConfig) {
  $('#online-note').hidden = false;
  $('#online-note').textContent = 'Online play turns on once the Firebase config is added. Practice works now.';
}
$('#practice').onclick = () => {
  const n = getName(); if (!n) return;
  start(new LocalServer(n, Number($('#bots').value)));
  act({ type: 'start' });
};
$('#create').onclick = async () => {
  const n = getName(); if (!n) return;
  try {
    const api = await firebase();
    const r = await api.call({ op: 'create', name: n });
    store.set('table', r.tableId);
    start(new CloudServer(api, r.tableId));
    onView(r.view);
  } catch (e) { toast(e.message); }
};
async function joinTable(code) {
  const n = getName(); if (!n) return;
  code = String(code || '').toUpperCase().trim();
  if (code.length !== 5) { toast('Table codes are 5 letters.'); return; }
  try {
    const api = await firebase();
    const r = await api.call({ op: 'act', tableId: code, action: { type: 'join', name: n } });
    store.set('table', code);
    start(new CloudServer(api, code));
    onView(r.view);
  } catch (e) {
    // Already seated (game running)? Just reconnect.
    try {
      const api = await firebase();
      const r = await api.call({ op: 'view', tableId: code });
      store.set('table', code);
      start(new CloudServer(api, code));
      onView(r.view);
    } catch (e2) { toast(e.message); }
  }
}
$('#join').onclick = () => joinTable($('#code').value);
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinTable($('#code').value); });

function start(s) {
  if (server) server.stop();
  server = s;
  view = null;
  Object.assign(ui, { mode: null, sel: null, declareOpen: false });
  server.watch(onView);
}
function leave() {
  if (server) server.stop();
  server = null; view = null;
  store.del('table');
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  render();
}
$('#leave').onclick = leave;
$('#lobby-leave').onclick = leave;

// Invite link ?t=CODE, or rejoin the last table after a refresh.
(function boot() {
  let code = null;
  try { code = new URLSearchParams(location.search).get('t'); } catch (e) { /* ignore */ }
  if (code) { $('#code').value = code.toUpperCase(); if (nameInput.value) joinTable(code); else nameInput.focus(); return; }
  const last = store.get('table', null);
  if (last && firebaseConfig && nameInput.value) joinTable(last);
})();

// ---------- lobby ----------
$('#copy-link').onclick = async () => {
  const url = location.origin + location.pathname + '?t=' + view.id;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied.'); }
  catch (e) { toast(url); }
};
$('#add-bot').onclick = () => act({ type: 'addBot' });
$('#start').onclick = () => act({ type: 'start' });
$('#again').onclick = () => act({ type: 'again' });
$('#to-lobby').onclick = () => act({ type: 'lobby' });

// ---------- sheets ----------
document.querySelectorAll('.rules-open').forEach((b) => { b.onclick = () => { $('#rules').hidden = false; }; });
document.querySelectorAll('.close-sheet').forEach((b) => { b.onclick = () => { b.closest('.overlay').hidden = true; }; });
document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o && o.id !== 'result') o.hidden = true; }));
$('#lastlog').onclick = () => {
  $('#loglist').innerHTML = (view ? view.log : []).map((l) => `<li>${esc(l.m)}</li>`).join('');
  $('#logsheet').hidden = false;
};

// ---------- cards ----------
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
function faceHTML(c, extra = '') {
  const red = E.isRed(c) ? ' red' : '';
  return `<div class="card face${red} ${extra}"><span class="rk">${esc(E.rank(c))}</span><span class="val">${E.value(c)}</span><span class="su">${SUIT[E.suit(c)]}</span>`;
}
function cardEl(c, cls = '') {
  return c ? faceHTML(c, cls) + '</div>' : `<div class="card none ${cls}"></div>`;
}

// What tapping a card does right now. Returns an action or a ui step, or null if the card isn't usable.
function cardUse(uid, slot) {
  const v = view;
  if (!v || v.phase !== 'play') return null;
  const mine = uid === v.me;
  if (ui.mode === 'snap') return { snap: true };
  if (v.pendingGive) return v.pendingGive.uid === v.me && mine ? { give: true } : null;
  if (v.turn !== v.me) return null;
  if (v.step === 'decide') return mine ? { swap: true } : null;
  if (v.step !== 'power' || !v.power) return null;
  const { kind, stage } = v.power;
  if (kind === 'own' || (kind === 'king' && stage === 'own')) return mine ? { peekOwn: true } : null;
  if (kind === 'other' || (kind === 'king' && stage === 'other')) return mine ? null : { peekOther: true };
  if (kind === 'queen' || (kind === 'king' && stage === 'swap')) {
    if (ui.sel && ui.sel.uid === uid && ui.sel.slot !== slot) return { pick: true }; // change pick within same player
    return { pick: true };
  }
  return null;
}
function onCard(uid, slot) {
  const u = cardUse(uid, slot);
  if (!u || ui.busy) return;
  if (u.snap) { ui.mode = null; return act({ type: 'snap', uid, slot }); }
  if (u.give) return act({ type: 'give', slot });
  if (u.swap) return act({ type: 'swap', slot });
  if (u.peekOwn) return act({ type: 'peekOwn', slot });
  if (u.peekOther) return act({ type: 'peekOther', uid, slot });
  if (u.pick) {
    if (!ui.sel || ui.sel.uid === uid) { ui.sel = ui.sel && ui.sel.uid === uid && ui.sel.slot === slot ? null : { uid, slot }; return render(); }
    const a = ui.sel; ui.sel = null;
    return act({ type: 'powerSwap', a, b: { uid, slot } });
  }
}

function slotHTML(p, s, i, size) {
  const v = view;
  if (!s) return `<div class="slot-empty" aria-label="Empty spot"></div>`;
  const use = cardUse(p.uid, i);
  const now = srvNow();
  const showing = s.c && (s.until === 0 || s.until === undefined || s.until > now);
  const moved = v.movedAt && now - v.movedAt < 2600 && v.moved.some((m) => m.uid === p.uid && m.slot === i);
  const sel = ui.sel && ui.sel.uid === p.uid && ui.sel.slot === i;
  const cls = [use ? 'target' : '', sel ? 'sel' : '', moved ? 'moved' : '', showing && s.until ? 'peek' : '', showing && s.wrong ? 'wrong' : ''].join(' ');
  const attrs = `data-uid="${esc(p.uid)}" data-slot="${i}" ${use ? 'role="button" tabindex="0"' : ''} aria-label="${esc(p.name)} card ${i + 1}"`;
  const inner = showing ? faceHTML(s.c, cls).replace('<div ', `<div ${attrs} `) : `<div class="card back ${cls}" ${attrs}>`;
  return inner + (size === 'me' ? `<span class="idx">${i + 1}</span>` : '') + '</div>';
}
// Slots 0 and 1 are the top row, 2 and 3 the bottom row. Penalty cards add columns to the right: 4 top, 5 bottom, and so on.
function place(i) {
  if (i < 4) return `grid-row:${i < 2 ? 1 : 2};grid-column:${(i % 2) + 1}`;
  return `grid-row:${i % 2 ? 2 : 1};grid-column:${Math.floor(i / 2) + 1}`;
}
function cols(p) { return Math.max(2, Math.ceil(p.slots.length / 2)); }
function gridInner(p, size) { return p.slots.map((s, i) => slotHTML(p, s, i, size).replace(/^<div /, `<div style="${place(i)}" `)).join(''); }
function gridHTML(p, size) {
  return `<div class="grid c${Math.min(cols(p), 5)}">${gridInner(p, size)}</div>`;
}

// ---------- status line and buttons ----------
function statusAndActions() {
  const v = view;
  const me = v.players.find((p) => p.uid === v.me);
  const turnP = v.players.find((p) => p.uid === v.turn);
  const myTurn = v.turn === v.me;
  const name = (uid) => (v.players.find((p) => p.uid === uid) || {}).name || '?';
  const btn = (id, text, cls = '', dis = false) => `<button class="btn ${cls}" data-act="${id}" ${dis ? 'disabled' : ''}>${esc(text)}</button>`;
  let status = '', go = false, buttons = '';

  if (v.phase === 'peek') {
    if (!me.ready) { status = 'Memorize your bottom two cards.'; go = true; buttons = btn('ready', 'Memorized', 'primary'); }
    else status = 'Waiting for ' + v.players.filter((p) => !p.ready).map((p) => p.name).join(', ') + '.';
    return { status, go, buttons };
  }
  if (v.phase !== 'play') return { status, go, buttons };

  const snapBtn = () => {
    if (ui.mode === 'snap') return btn('snapCancel', 'Cancel snap');
    return btn('snap', 'Snap', 'danger', !v.snapOpen || !!v.pendingGive || !v.pileTop);
  };

  if (ui.mode === 'snap') {
    return { status: `Tap the card you want to throw on the ${E.label(v.pileTop)}.`, go: true, buttons: snapBtn() };
  }
  if (v.pendingGive) {
    if (v.pendingGive.uid === v.me) return { status: `Pick one of your cards to give ${name(v.pendingGive.toUid)}.`, go: true, buttons: '' };
    return { status: `${name(v.pendingGive.uid)} is handing ${name(v.pendingGive.toUid)} a card.`, go: false, buttons: '' };
  }

  if (myTurn) {
    go = true;
    if (v.step === 'draw') {
      const wait = Math.max(0, v.drawLockUntil - srvNow());
      status = me.count <= 2 ? 'Your turn. Draw, or declare your total.' : 'Your turn. Draw a card.';
      buttons = btn('draw', wait > 0 ? `Draw (${Math.ceil(wait / 1000)})` : 'Draw', 'primary', wait > 0);
      if (me.count <= 2) {
        buttons += ui.declareOpen
          ? `<input id="declare-num" type="number" inputmode="numeric" min="0" max="99" placeholder="Total" aria-label="Your total">${btn('declareGo', 'Declare', 'primary')}${btn('declareCancel', 'Cancel')}`
          : btn('declareOpen', 'Declare');
      }
    } else if (v.step === 'decide') {
      status = 'Tap one of your cards to swap it in, or throw this one.';
      buttons = btn('throw', 'Throw it on the pile', 'primary');
    } else if (v.step === 'power') {
      const k = v.power.kind, s = v.power.stage;
      if (k === 'own') status = 'Tap one of your cards to look at it.';
      else if (k === 'other') status = "Tap someone else's card to look at it.";
      else if (k === 'jack') status = 'Use the Jack to skip the next player?';
      else if (k === 'queen') status = ui.sel ? 'Now tap a card from a different player. Blind swap.' : 'Pick two cards from two different players to swap blind.';
      else if (k === 'king' && s === 'own') status = 'King. Look at one of your cards first.';
      else if (k === 'king' && s === 'other') status = "King. Now look at one of someone else's cards.";
      else if (k === 'king' && s === 'swap') status = ui.sel ? 'Now tap a card from a different player.' : 'Swap any two cards between two players, or finish.';
      if (k === 'jack') buttons = btn('useJack', 'Skip next player', 'primary') + btn('pass', "Don't use");
      else if (k === 'king' && s !== 'swap') buttons = btn('skipPeek', 'Skip this look') + btn('pass', 'Finish turn');
      else buttons = btn('pass', k === 'king' || k === 'queen' ? 'No swap, finish' : "Don't use");
    }
  } else {
    status = `${turnP ? turnP.name : ''}'s turn.`;
    if (v.step === 'decide') status = `${turnP.name} is deciding what to do with their draw.`;
    if (v.step === 'power') status = `${turnP.name} is using a ${powerName(v.power)}.`;
  }
  buttons += snapBtn();
  return { status, go, buttons };
}
function powerName(p) {
  return { own: '7 or 8 (look at own)', other: '9 or 10 (look at someone)', jack: 'Jack (skip)', queen: 'Queen (blind swap)', king: 'King (look and swap)' }[p.kind] || 'power';
}
$('#actions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const a = b.dataset.act;
  if (a === 'snap') { ui.mode = 'snap'; ui.sel = null; return render(); }
  if (a === 'snapCancel') { ui.mode = null; return render(); }
  if (a === 'declareOpen') { ui.declareOpen = true; render(); const i = $('#declare-num'); if (i) i.focus(); return; }
  if (a === 'declareCancel') { ui.declareOpen = false; return render(); }
  if (a === 'declareGo') {
    const n = Number(($('#declare-num') || {}).value);
    if (!Number.isInteger(n) || n < 0) { toast('Enter your total as a whole number.'); return; }
    ui.declareOpen = false;
    return act({ type: 'declare', total: n });
  }
  act({ type: a });
});
$('#actions').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'declare-num') { e.preventDefault(); $('[data-act="declareGo"]').click(); }
});
function cardClick(e) {
  const c = e.target.closest('[data-uid]');
  if (!c) return;
  onCard(c.dataset.uid, Number(c.dataset.slot));
}
$('#opps').addEventListener('click', cardClick);
$('#my-grid').addEventListener('click', cardClick);
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-uid][role="button"]')) { e.preventDefault(); cardClick(e); }
  if (e.key === 'Escape' && ui.mode) { ui.mode = null; ui.sel = null; render(); }
});

// ---------- render ----------
function show(id) { ['home', 'lobby', 'table'].forEach((s) => { $('#' + s).hidden = s !== id; }); }
let lastHTML = {};
function setHTML(el, html) { if (lastHTML[el.id] !== html) { el.innerHTML = html; lastHTML[el.id] = html; } }

function render() {
  const v = view;
  if (!server || !v) { show('home'); $('#result').hidden = true; return; }
  if (v.phase === 'lobby') return renderLobby(v);
  show('table');
  const me = v.players.find((p) => p.uid === v.me);
  const opps = v.players.filter((p) => p.uid !== v.me);
  $('#table-code').textContent = server.mode === 'local' ? 'Practice' : 'Table ' + v.id;

  setHTML($('#opps'), opps.map((p) => `
    <div class="seat ${v.turn === p.uid && v.phase === 'play' ? 'turn' : ''}">
      <div class="seat-name"><span>${esc(p.name)}</span><span class="mono">${p.count}</span></div>
      ${gridHTML(p, 'opp')}
    </div>`).join(''));
  $('#opps').classList.toggle('many', opps.length >= 3);

  $('#deck-count').textContent = v.deckCount + ' left';
  const pile = $('#pile');
  if (v.pileTop) { pile.outerHTML = faceHTML(v.pileTop, 'big').replace('<div ', '<div id="pile" ') + '</div>'; }
  else { pile.outerHTML = '<div id="pile" class="card big none"></div>'; }

  const dw = $('#drawn-wrap');
  dw.hidden = !v.drawn;
  if (v.drawn) {
    const d = $('#drawn');
    d.outerHTML = v.drawn === 'X' ? '<div id="drawn" class="card back big"></div>' : faceHTML(v.drawn, 'big peek').replace('<div ', '<div id="drawn" ') + '</div>';
    $('#drawn-label').textContent = v.drawn === 'X' ? `${(v.players.find((p) => p.uid === v.turn) || {}).name}'s draw` : 'Your draw';
  }

  $('#me-name').textContent = me.name;
  $('#me-count').textContent = me.count + (me.count === 1 ? ' card' : ' cards');
  document.querySelector('.mine').classList.toggle('turn', v.turn === v.me && v.phase === 'play');
  $('#my-grid').className = 'grid c' + Math.min(cols(me), 5);
  setHTML($('#my-grid'), gridInner(me, 'me'));

  const { status, go, buttons } = statusAndActions();
  const st = $('#status');
  st.textContent = status;
  st.classList.toggle('go', go);
  const actions = $('#actions');
  const typed = $('#declare-num') ? $('#declare-num').value : '';
  setHTML(actions, buttons);
  if (typed && $('#declare-num')) $('#declare-num').value = typed;
  const last = v.log[v.log.length - 1];
  $('#lastlog').textContent = last ? last.m : '';

  renderResult(v);
}
function renderLobby(v) {
  show('lobby');
  $('#result').hidden = true;
  $('#lobby-code').textContent = v.id;
  const host = v.hostUid === v.me;
  $('#lobby-players').innerHTML = v.players.map((p) => `
    <li><span>${esc(p.name)} ${p.uid === v.hostUid ? '<small>host</small>' : ''}${p.bot ? '<small>computer</small>' : ''}${p.uid === v.me ? '<small>you</small>' : ''}</span>
    ${host && p.uid !== v.me ? `<button class="link" data-kick="${esc(p.uid)}">Remove</button>` : ''}</li>`).join('');
  $('#lobby-players').querySelectorAll('[data-kick]').forEach((b) => { b.onclick = () => act({ type: 'kick', uid: b.dataset.kick }); });
  $('#host-tools').hidden = !host;
  $('#lobby-wait').hidden = host;
  $('#add-bot').disabled = v.players.length >= E.MAX_PLAYERS;
  $('#start').disabled = v.players.length < 2;
}
function renderResult(v) {
  const r = $('#result');
  if (v.phase !== 'over' || !v.result) { r.hidden = true; return; }
  r.hidden = false;
  const w = v.result.find((x) => x.uid === v.winner);
  $('#res-title').textContent = v.winner === v.me ? 'You win' : `${w ? w.name : ''} wins`;
  $('#res-sub').textContent = v.how === 'declare' ? 'Called Declare and got the total right.' : v.how === 'empty' ? 'Got rid of every card.' : 'Lowest hand when the cards ran out.';
  const rows = v.result.slice().sort((a, b) => (a.uid === v.winner ? -1 : b.uid === v.winner ? 1 : a.total - b.total));
  setHTML($('#res-list'), rows.map((x) => `
    <div class="resrow ${x.uid === v.winner ? 'win' : ''}">
      <div class="who">${esc(x.name)}<br><span class="mono">${x.count} ${x.count === 1 ? 'card' : 'cards'}</span></div>
      <div class="cards">${x.slots.filter(Boolean).map((c) => cardEl(c)).join('')}</div>
      <div class="tot">${x.total}</div>
    </div>`).join(''));
  const host = v.hostUid === v.me;
  $('#res-host').hidden = !host;
  $('#res-wait').hidden = host;
  $('#to-lobby').hidden = server && server.mode === 'local';
}

// Peeks flip back, the draw countdown ticks, highlights fade.
setInterval(() => { if (server && view && view.phase !== 'lobby') render(); }, 250);
render();

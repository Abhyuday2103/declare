// Declare rules engine. The same file runs in the browser (practice vs computer players)
// and inside the Firebase function (online tables). Keep docs/engine.js and functions/engine.js identical.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const MAX_PLAYERS = 4;
export const T = {
  PEEK: 3000,        // how long a 7/8, 9/10 peek stays face up
  KPEEK: 4000,       // King peeks stay up a bit longer so you can decide the swap
  WRONG: 2500,       // a wrong snap shows the card to everyone, then it goes back
  LOCK: 2000,        // after a card hits the pile, the next draw waits this long so people can snap
  BOT_GAP: 900,      // computer players pause this long between moves
  BOT_DRAW: 1200,    // extra wait before a computer player draws
};

export const rank = (c) => c.slice(0, -1);
export const suit = (c) => c.slice(-1);
export const isRed = (c) => suit(c) === 'H' || suit(c) === 'D';
export function value(c) {
  const r = rank(c);
  if (r === 'A') return 1;
  if (r === 'J') return 11;
  if (r === 'Q') return 12;
  if (r === 'K') return isRed(c) ? 13 : 0;
  return Number(r);
}
export function powerOf(c) {
  const r = rank(c);
  if (r === '7' || r === '8') return 'own';
  if (r === '9' || r === '10') return 'other';
  if (r === 'J') return 'jack';
  if (r === 'Q') return 'queen';
  if (r === 'K') return 'king';
  return null;
}
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const label = (c) => rank(c) + SUIT_SYM[suit(c)];

const BOT_NAMES = ['Raju', 'Pinky', 'Bunty', 'Chintu', 'Golu', 'Sweety', 'Monu', 'Dolly'];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return shuffle(d);
}
function cleanName(n) {
  return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
}
function fail(msg) { throw new Error(msg); }

export const cardsLeft = (p) => p.slots.filter(Boolean).length;
export const handTotal = (p) => p.slots.filter(Boolean).reduce((s, c) => s + value(c), 0);

// ---------- table setup ----------
export function createTable(id, hostUid, name) {
  return {
    v: 1, id, hostUid, phase: 'lobby', seq: 0, now: 0, handNo: 0, starter: 0,
    players: [{ uid: hostUid, name: cleanName(name), bot: false, slots: [], ready: false }],
    deck: [], pile: [], turn: 0, step: 'draw', drawn: null, power: null, skipNext: false,
    snapOpen: false, drawLockUntil: 0, snapReadyAt: 0, pendingGive: null,
    reveals: {}, publicReveal: null, moved: [], movedAt: 0,
    log: [], winner: null, how: null, result: null, know: {}, botAt: 0,
  };
}

const P = (st, uid) => st.players.find((p) => p.uid === uid);
const idx = (st, uid) => st.players.findIndex((p) => p.uid === uid);
const nm = (st, uid) => (P(st, uid) || {}).name || '?';
function log(st, m) {
  st.log.push({ t: st.now, m });
  if (st.log.length > 40) st.log.splice(0, st.log.length - 40);
}
function setMoved(st, list) { st.moved = list; st.movedAt = st.now; }

// ---------- what computer players remember ----------
// st.know[botUid]["ownerUid:slot"] = card. Kept exact: every time cards move, the memory moves with them,
// the same way a person at the table watches where cards go.
const key = (uid, slot) => uid + ':' + slot;
const bots = (st) => st.players.filter((p) => p.bot);
function knowSet(st, viewer, uid, slot, card) {
  if (st.know[viewer]) st.know[viewer][key(uid, slot)] = card;
}
function knowAll(st, uid, slot, card) { for (const b of bots(st)) knowSet(st, b.uid, uid, slot, card); }
function knowDel(st, uid, slot) { for (const b of bots(st)) if (st.know[b.uid]) delete st.know[b.uid][key(uid, slot)]; }
function knowMove(st, fu, fs, tu, ts) {
  for (const b of bots(st)) {
    const m = st.know[b.uid]; if (!m) continue;
    const v = m[key(fu, fs)];
    delete m[key(fu, fs)];
    if (v) m[key(tu, ts)] = v; else delete m[key(tu, ts)];
  }
}
function knowSwap(st, a, b) {
  for (const bt of bots(st)) {
    const m = st.know[bt.uid]; if (!m) continue;
    const ka = key(a.uid, a.slot), kb = key(b.uid, b.slot);
    const va = m[ka], vb = m[kb];
    delete m[ka]; delete m[kb];
    if (va) m[kb] = va;
    if (vb) m[ka] = vb;
  }
}

// ---------- deck ----------
function drawCard(st) {
  if (!st.deck.length && st.pile.length > 1) {
    const top = st.pile.pop();
    st.deck = shuffle(st.pile);
    st.pile = [top];
    log(st, 'Deck ran out. The pile got shuffled back in.');
  }
  return st.deck.pop() || null;
}
function penalty(st, p) {
  const c = drawCard(st);
  if (!c) return false;
  let s = p.slots.indexOf(null);
  if (s === -1) { s = p.slots.length; p.slots.push(c); } else p.slots[s] = c;
  knowDel(st, p.uid, s);
  st.moved.push({ uid: p.uid, slot: s });
  st.movedAt = st.now;
  return true;
}

// ---------- hand flow ----------
function startHand(st) {
  st.handNo++;
  st.deck = newDeck();
  st.pile = [];
  st.know = {};
  for (const p of st.players) {
    p.slots = [st.deck.pop(), st.deck.pop(), st.deck.pop(), st.deck.pop()];
    p.ready = p.bot;
    if (p.bot) {
      st.know[p.uid] = {};
      knowSet(st, p.uid, p.uid, 2, p.slots[2]);
      knowSet(st, p.uid, p.uid, 3, p.slots[3]);
    }
  }
  st.starter = st.starter % st.players.length;
  st.turn = st.starter;
  Object.assign(st, {
    phase: 'peek', step: 'draw', drawn: null, power: null, skipNext: false, snapOpen: false,
    drawLockUntil: 0, snapReadyAt: 0, pendingGive: null, reveals: {}, publicReveal: null,
    moved: [], movedAt: 0, winner: null, how: null, result: null,
  });
  st.log = [];
  log(st, 'Cards are dealt. Look at your bottom two, then tap Memorized.');
  maybeBegin(st);
}
function maybeBegin(st) {
  if (st.phase === 'peek' && st.players.every((p) => p.ready)) {
    st.phase = 'play';
    st.drawLockUntil = st.now;
    log(st, `Game on. ${st.players[st.turn].name} goes first.`);
  }
}
function finish(st, uid, how) {
  st.phase = 'over';
  st.winner = uid;
  st.how = how;
  st.snapOpen = false;
  st.drawn = null;
  st.power = null;
  st.pendingGive = null;
  st.result = st.players.map((p) => ({ uid: p.uid, name: p.name, slots: p.slots.slice(), total: handTotal(p), count: cardsLeft(p) }));
  const why = how === 'declare' ? 'called Declare and nailed it' : how === 'empty' ? 'got rid of every card' : 'had the lowest hand when the cards ran out';
  log(st, `${nm(st, uid)} wins. They ${why}.`);
  st.starter = (st.starter + 1) % st.players.length;
}
function checkWin(st) {
  if (st.phase !== 'play' || st.pendingGive) return;
  const done = st.players.find((p) => cardsLeft(p) === 0);
  if (done) finish(st, done.uid, 'empty');
}
function endByLowest(st) {
  const best = st.players.slice().sort((a, b) => handTotal(a) - handTotal(b) || cardsLeft(a) - cardsLeft(b))[0];
  finish(st, best.uid, 'lowest');
}
function endTurn(st) {
  st.power = null;
  st.drawn = null;
  st.step = 'draw';
  const n = st.players.length;
  let next = (st.turn + 1) % n;
  if (st.skipNext) {
    log(st, `${st.players[next].name} gets skipped.`);
    next = (next + 1) % n;
    st.skipNext = false;
  }
  st.turn = next;
  checkWin(st);
}
function discard(st, p, c, how) {
  st.pile.push(c);
  st.drawn = null;
  st.snapOpen = true;
  st.drawLockUntil = st.now + T.LOCK;
  st.snapReadyAt = st.now + 1500 + Math.floor(Math.random() * 1300);
  log(st, `${p.name} ${how} ${label(c)}.`);
  const pw = powerOf(c);
  if (pw) {
    st.step = 'power';
    st.power = { kind: pw, stage: pw === 'king' ? 'own' : null, peeked: null };
  } else endTurn(st);
}
function reveal(st, uid, list, ms) {
  const r = st.reveals[uid] && st.reveals[uid].until > st.now ? st.reveals[uid] : { cards: [], until: 0 };
  r.cards = r.cards.concat(list);
  r.until = st.now + ms;
  st.reveals[uid] = r;
}
function ownCard(p, slot) {
  const s = Number(slot);
  if (!Number.isInteger(s) || !p.slots[s]) fail('Pick one of your cards.');
  return s;
}
function anyCard(st, uid, slot) {
  const p = P(st, uid);
  const s = Number(slot);
  if (!p || !Number.isInteger(s) || !p.slots[s]) fail('Pick a card that is on the table.');
  return { p, s };
}

// ---------- actions ----------
export function dispatch(st, uid, a, now = Date.now()) {
  st.now = now;
  for (const u of Object.keys(st.reveals)) if (st.reveals[u].until <= now) delete st.reveals[u];
  if (st.publicReveal && st.publicReveal.until <= now) st.publicReveal = null;
  const me = P(st, uid);
  const type = a && a.type;

  if (type === 'join') {
    if (me) { me.name = cleanName(a.name); return bump(st); }
    if (st.phase !== 'lobby') fail('This game already started. Ask the host to go back to the lobby.');
    if (st.players.length >= MAX_PLAYERS) fail('Table is full (4 players max).');
    st.players.push({ uid, name: cleanName(a.name), bot: false, slots: [], ready: false });
    return bump(st);
  }
  if (!me) fail('You are not at this table.');

  switch (type) {
    case 'addBot': {
      if (uid !== st.hostUid) fail('Only the host can add computer players.');
      if (st.phase !== 'lobby') fail('Add players from the lobby.');
      if (st.players.length >= MAX_PLAYERS) fail('Table is full (4 players max).');
      const used = new Set(st.players.map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot';
      st.players.push({ uid: 'bot_' + Math.random().toString(36).slice(2, 9), name, bot: true, slots: [], ready: true });
      break;
    }
    case 'kick': {
      if (uid !== st.hostUid) fail('Only the host can remove players.');
      if (st.phase !== 'lobby') fail('Remove players from the lobby.');
      if (a.uid === st.hostUid) fail('The host stays.');
      st.players = st.players.filter((p) => p.uid !== a.uid);
      break;
    }
    case 'start': {
      if (uid !== st.hostUid) fail('Only the host can start.');
      if (st.phase !== 'lobby') fail('Already started.');
      if (st.players.length < 2) fail('Need at least 2 players. Add a computer player or share the code.');
      startHand(st);
      break;
    }
    case 'again': {
      if (uid !== st.hostUid) fail('Only the host can deal again.');
      if (st.phase !== 'over') fail('Finish this game first.');
      startHand(st);
      break;
    }
    case 'lobby': {
      if (uid !== st.hostUid) fail('Only the host can do that.');
      if (st.phase !== 'over') fail('Finish this game first.');
      st.phase = 'lobby';
      for (const p of st.players) { p.slots = []; p.ready = p.bot; }
      break;
    }
    case 'ready': {
      if (st.phase !== 'peek') fail('Not the time for that.');
      me.ready = true;
      maybeBegin(st);
      break;
    }
    default:
      play(st, me, type, a);
  }
  return bump(st);
}
function bump(st) {
  st.seq++;
  st.botAt = st.now + T.BOT_GAP;
  return st;
}

function play(st, me, type, a) {
  if (st.phase !== 'play') fail('The game is not running right now.');
  if (st.pendingGive && type !== 'give') fail(`Waiting for ${nm(st, st.pendingGive.uid)} to hand over a card.`);
  const myTurn = st.players[st.turn].uid === me.uid;
  const needTurn = (step) => {
    if (!myTurn) fail(`It's ${st.players[st.turn].name}'s turn.`);
    if (st.step !== step) fail('Not the time for that.');
  };

  switch (type) {
    case 'draw': {
      needTurn('draw');
      if (st.now < st.drawLockUntil) fail('Hold on a second. People can still snap.');
      const c = drawCard(st);
      if (!c) return endByLowest(st);
      st.drawn = c;
      st.step = 'decide';
      st.snapOpen = false;
      log(st, `${me.name} drew a card.`);
      return;
    }
    case 'declare': {
      needTurn('draw');
      const n = cardsLeft(me);
      if (n > 2) fail('You can only declare with 2 cards or fewer.');
      const guess = Number(a.total);
      if (!Number.isInteger(guess) || guess < 0 || guess > 99) fail('Enter a whole number.');
      st.snapOpen = false;
      if (guess === handTotal(me)) {
        log(st, `${me.name} declared ${guess}.`);
        return finish(st, me.uid, 'declare');
      }
      log(st, `${me.name} declared ${guess} and was wrong. Penalty card.`);
      st.moved = [];
      penalty(st, me);
      return endTurn(st);
    }
    case 'throw': {
      needTurn('decide');
      setMoved(st, []);
      return discard(st, me, st.drawn, 'threw the card they drew,');
    }
    case 'swap': {
      needTurn('decide');
      const s = ownCard(me, a.slot);
      const out = me.slots[s];
      me.slots[s] = st.drawn;
      knowDel(st, me.uid, s);
      if (me.bot) knowSet(st, me.uid, me.uid, s, st.drawn);
      setMoved(st, [{ uid: me.uid, slot: s }]);
      return discard(st, me, out, `swapped their card ${s + 1} and threw`);
    }
    case 'peekOwn': {
      needTurn('power');
      const pw = st.power;
      if (!(pw.kind === 'own' || (pw.kind === 'king' && pw.stage === 'own'))) fail('Your power does not do that.');
      const s = ownCard(me, a.slot);
      reveal(st, me.uid, [{ uid: me.uid, slot: s, card: me.slots[s] }], pw.kind === 'king' ? T.KPEEK : T.PEEK);
      knowSet(st, me.uid, me.uid, s, me.slots[s]);
      log(st, `${me.name} looked at their card ${s + 1}.`);
      setMoved(st, []);
      if (pw.kind === 'own') return endTurn(st);
      pw.stage = 'other';
      return;
    }
    case 'peekOther': {
      needTurn('power');
      const pw = st.power;
      if (!(pw.kind === 'other' || (pw.kind === 'king' && pw.stage === 'other'))) fail('Your power does not do that.');
      if (a.uid === me.uid) fail("Pick someone else's card.");
      const { p, s } = anyCard(st, a.uid, a.slot);
      reveal(st, me.uid, [{ uid: p.uid, slot: s, card: p.slots[s] }], pw.kind === 'king' ? T.KPEEK : T.PEEK);
      knowSet(st, me.uid, p.uid, s, p.slots[s]);
      log(st, `${me.name} looked at ${p.name}'s card ${s + 1}.`);
      if (pw.kind === 'other') return endTurn(st);
      pw.stage = 'swap';
      pw.peeked = { uid: p.uid, slot: s };
      return;
    }
    case 'useJack': {
      needTurn('power');
      if (st.power.kind !== 'jack') fail('Your power does not do that.');
      st.skipNext = true;
      log(st, `${me.name} used the Jack.`);
      return endTurn(st);
    }
    case 'powerSwap': {
      needTurn('power');
      const pw = st.power;
      if (!(pw.kind === 'queen' || (pw.kind === 'king' && pw.stage === 'swap'))) fail('Your power does not do that.');
      const A = a.a || {}, B = a.b || {};
      if (A.uid === B.uid) fail('Swap cards between two different players.');
      const x = anyCard(st, A.uid, A.slot), y = anyCard(st, B.uid, B.slot);
      const tmp = x.p.slots[x.s];
      x.p.slots[x.s] = y.p.slots[y.s];
      y.p.slots[y.s] = tmp;
      knowSwap(st, { uid: x.p.uid, slot: x.s }, { uid: y.p.uid, slot: y.s });
      setMoved(st, [{ uid: x.p.uid, slot: x.s }, { uid: y.p.uid, slot: y.s }]);
      log(st, `${me.name} swapped ${x.p.name}'s card ${x.s + 1} with ${y.p.name}'s card ${y.s + 1}.`);
      return endTurn(st);
    }
    case 'skipPeek': {
      needTurn('power');
      const pw = st.power;
      if (pw.kind !== 'king' || pw.stage === 'swap') fail('Nothing to skip.');
      pw.stage = pw.stage === 'own' ? 'other' : 'swap';
      return;
    }
    case 'pass': {
      needTurn('power');
      log(st, `${me.name} didn't use the power.`);
      return endTurn(st);
    }
    case 'snap': {
      if (!st.snapOpen || !st.pile.length) fail('Snapping is closed. Wait for the next card on the pile.');
      const { p, s } = anyCard(st, a.uid, a.slot);
      const card = p.slots[s];
      const top = st.pile[st.pile.length - 1];
      if (rank(card) === rank(top)) {
        st.pile.push(card);
        p.slots[s] = null;
        knowDel(st, p.uid, s);
        setMoved(st, [{ uid: p.uid, slot: s }]);
        st.snapReadyAt = st.now + 1500 + Math.floor(Math.random() * 1300);
        if (p.uid === me.uid) {
          log(st, `${me.name} snapped their own ${label(card)}.`);
          return checkWin(st);
        }
        log(st, `${me.name} snapped ${p.name}'s ${label(card)}. Now they hand ${p.name} a card.`);
        st.pendingGive = { uid: me.uid, toUid: p.uid, toSlot: s };
        return;
      }
      st.publicReveal = { uid: p.uid, slot: s, card, until: st.now + T.WRONG };
      knowAll(st, p.uid, s, card);
      st.moved = [];
      penalty(st, me);
      const whose = p.uid === me.uid ? 'their own' : `${p.name}'s`;
      log(st, `${me.name} snapped ${whose} card ${s + 1} and missed (${label(card)}). Penalty card.`);
      return;
    }
    case 'give': {
      const g = st.pendingGive;
      if (!g || g.uid !== me.uid) fail('Nothing to hand over.');
      const s = ownCard(me, a.slot);
      const to = P(st, g.toUid);
      to.slots[g.toSlot] = me.slots[s];
      me.slots[s] = null;
      knowMove(st, me.uid, s, to.uid, g.toSlot);
      setMoved(st, [{ uid: me.uid, slot: s }, { uid: to.uid, slot: g.toSlot }]);
      st.pendingGive = null;
      log(st, `${me.name} gave ${to.name} their card ${s + 1}.`);
      return checkWin(st);
    }
    default:
      fail('Unknown move.');
  }
}

// ---------- what each person is allowed to see ----------
export function viewFor(st, uid) {
  const now = st.now;
  const rv = st.reveals[uid] && st.reveals[uid].until > now ? st.reveals[uid] : null;
  const pr = st.publicReveal && st.publicReveal.until > now ? st.publicReveal : null;
  const turnUid = st.players[st.turn] ? st.players[st.turn].uid : null;
  const players = st.players.map((p) => ({
    uid: p.uid, name: p.name, bot: p.bot, ready: p.ready, count: cardsLeft(p),
    slots: p.slots.map((c, i) => {
      if (!c) return null;
      if (st.phase === 'over') return { c };
      if (st.phase === 'peek' && p.uid === uid && !p.ready && (i === 2 || i === 3)) return { c, until: 0 };
      if (rv) { const hit = rv.cards.find((x) => x.uid === p.uid && x.slot === i); if (hit) return { c, until: rv.until }; }
      if (pr && pr.uid === p.uid && pr.slot === i) return { c, until: pr.until, wrong: true };
      return {};
    }),
  }));
  const pw = st.power ? { kind: st.power.kind, stage: st.power.stage } : null;
  return {
    id: st.id, me: uid, hostUid: st.hostUid, phase: st.phase, seq: st.seq, serverNow: now, handNo: st.handNo,
    players, turn: turnUid, step: st.step,
    drawn: st.drawn ? (turnUid === uid ? st.drawn : 'X') : null,
    pileTop: st.pile.length ? st.pile[st.pile.length - 1] : null,
    pileUnder: st.pile.length > 1 ? st.pile[st.pile.length - 2] : null,
    pileCount: st.pile.length, deckCount: st.deck.length,
    power: pw, skipNext: st.skipNext, snapOpen: st.snapOpen, drawLockUntil: st.drawLockUntil,
    pendingGive: st.pendingGive, moved: st.moved, movedAt: st.movedAt,
    log: st.log.slice(-14), winner: st.winner, how: st.how, result: st.phase === 'over' ? st.result : null,
    botAt: st.players.some((p) => p.bot) ? st.botAt : 0,
  };
}

// ---------- computer players ----------
function botMem(st, b) { return st.know[b.uid] || (st.know[b.uid] = {}); }
function ownInfo(st, b) {
  const m = botMem(st, b);
  const known = [], unknown = [];
  b.slots.forEach((c, i) => {
    if (!c) return;
    const k = m[key(b.uid, i)];
    if (k) known.push({ slot: i, card: k, v: value(k) }); else unknown.push(i);
  });
  return { known, unknown };
}
function othersCards(st, b) {
  const list = [];
  for (const p of st.players) {
    if (p.uid === b.uid) continue;
    p.slots.forEach((c, i) => { if (c) list.push({ uid: p.uid, slot: i }); });
  }
  return list;
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function botTurnMove(st, b) {
  const { known, unknown } = ownInfo(st, b);
  const worst = known.slice().sort((x, y) => y.v - x.v)[0];
  if (st.step === 'draw') {
    if (cardsLeft(b) <= 2 && unknown.length === 0) return { type: 'declare', total: known.reduce((s, k) => s + k.v, 0) };
    if (st.now < Math.max(st.drawLockUntil + T.BOT_DRAW, st.snapReadyAt + 400)) return null;
    return { type: 'draw' };
  }
  if (st.step === 'decide') {
    const v = value(st.drawn);
    if (v <= 3) {
      if (worst && worst.v > 6) return { type: 'swap', slot: worst.slot };
      if (unknown.length) return { type: 'swap', slot: pick(unknown) };
      if (worst && worst.v > v) return { type: 'swap', slot: worst.slot };
      return { type: 'throw' };
    }
    if (v <= 6) {
      if (worst && worst.v > v + 1) return { type: 'swap', slot: worst.slot };
      if (!worst && unknown.length && v <= 4) return { type: 'swap', slot: pick(unknown) };
      return { type: 'throw' };
    }
    return { type: 'throw' };
  }
  if (st.step === 'power') {
    const pw = st.power;
    const m = botMem(st, b);
    const unknownOthers = othersCards(st, b).filter((x) => !m[key(x.uid, x.slot)]);
    const knownOthers = othersCards(st, b).filter((x) => m[key(x.uid, x.slot)]).map((x) => ({ ...x, v: value(m[key(x.uid, x.slot)]) }));
    if (pw.kind === 'own') return unknown.length ? { type: 'peekOwn', slot: pick(unknown) } : { type: 'pass' };
    if (pw.kind === 'other') return unknownOthers.length ? { type: 'peekOther', ...pick(unknownOthers) } : { type: 'pass' };
    if (pw.kind === 'jack') return { type: 'useJack' };
    if (pw.kind === 'queen' || (pw.kind === 'king' && pw.stage === 'swap')) {
      const low = knownOthers.sort((x, y) => x.v - y.v)[0];
      if (worst && low && worst.v - low.v >= 3) return { type: 'powerSwap', a: { uid: b.uid, slot: worst.slot }, b: { uid: low.uid, slot: low.slot } };
      if (worst && worst.v >= 10 && unknownOthers.length) return { type: 'powerSwap', a: { uid: b.uid, slot: worst.slot }, b: pick(unknownOthers) };
      return { type: 'pass' };
    }
    if (pw.kind === 'king' && pw.stage === 'own') return unknown.length ? { type: 'peekOwn', slot: pick(unknown) } : { type: 'skipPeek' };
    if (pw.kind === 'king' && pw.stage === 'other') return unknownOthers.length ? { type: 'peekOther', ...pick(unknownOthers) } : { type: 'skipPeek' };
  }
  return { type: 'pass' };
}
function botSnap(st) {
  if (!st.snapOpen || !st.pile.length || st.now < st.snapReadyAt) return null;
  const r = rank(st.pile[st.pile.length - 1]);
  for (const b of shuffle(bots(st).slice())) {
    if (!cardsLeft(b)) continue;
    const m = botMem(st, b);
    const hits = Object.entries(m).filter(([, c]) => rank(c) === r).map(([k]) => {
      const [u, s] = k.split(':');
      return { uid: u, slot: Number(s) };
    }).filter((h) => { const p = P(st, h.uid); return p && p.slots[h.slot]; });
    if (!hits.length) continue;
    const own = hits.find((h) => h.uid === b.uid);
    if (own) return [b.uid, { type: 'snap', ...own }];
    return [b.uid, { type: 'snap', ...hits[0] }];
  }
  return null;
}
// Runs at most one computer move whose time has come. Returns true if something happened.
export function runBots(st, now = Date.now()) {
  if (st.phase !== 'play' || now < st.botAt) return false;
  st.now = now;
  let mv = null;
  if (st.pendingGive) {
    const b = P(st, st.pendingGive.uid);
    if (!b || !b.bot) return false;
    const { known, unknown } = ownInfo(st, b);
    const worst = known.slice().sort((x, y) => y.v - x.v)[0];
    mv = [b.uid, { type: 'give', slot: worst && (worst.v >= 7 || !unknown.length) ? worst.slot : pick(unknown) }];
  } else {
    mv = botSnap(st);
    if (!mv) {
      const t = st.players[st.turn];
      if (t && t.bot) { const m = botTurnMove(st, t); if (m) mv = [t.uid, m]; }
    }
  }
  if (!mv) return false;
  try { dispatch(st, mv[0], mv[1], now); } catch (e) {
    // A bot should never get stuck. If its move was refused, fall back to the safest legal move.
    const t = st.players[st.turn];
    if (t && t.bot && t.uid === mv[0] && st.step === 'power') dispatch(st, t.uid, { type: 'pass' }, now);
    else if (t && t.bot && t.uid === mv[0] && st.step === 'decide') dispatch(st, t.uid, { type: 'throw' }, now);
    else { st.botAt = now + T.BOT_GAP; return false; }
  }
  return true;
}

// When the next computer move could happen (for clients that need to nudge the server).
export function nextBotTime(st) {
  if (st.phase !== 'play' || !st.players.some((p) => p.bot)) return 0;
  return Math.max(st.botAt, 0);
}

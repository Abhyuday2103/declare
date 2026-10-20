// Runs lots of computer-only games plus hand-built rule scenarios.
// node tools/sim.mjs [games]
import * as E from '../docs/engine.js';

const games = Number(process.argv[2] || 3000);
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('FAIL', msg); } };

function census(st) {
  const all = [...st.deck, ...st.pile, ...st.players.flatMap((p) => p.slots.filter(Boolean))];
  if (st.drawn) all.push(st.drawn);
  return all;
}
function checkLeak(st) {
  for (const viewer of st.players) {
    const v = E.viewFor(st, viewer.uid);
    if (v.drawn && v.drawn !== 'X' && st.players[st.turn].uid !== viewer.uid) return 'drawn leaked';
    for (const p of v.players) for (let i = 0; i < p.slots.length; i++) {
      const s = p.slots[i];
      if (!s || !s.c || st.phase === 'over') continue;
      const allowed =
        (st.phase === 'peek' && p.uid === viewer.uid && (i === 2 || i === 3)) ||
        (st.reveals[viewer.uid] && st.reveals[viewer.uid].cards.some((x) => x.uid === p.uid && x.slot === i)) ||
        (st.publicReveal && st.publicReveal.uid === p.uid && st.publicReveal.slot === i);
      if (!allowed) return `slot leaked ${p.name}:${i}`;
    }
  }
  return null;
}

const stats = { declare: 0, empty: 0, lowest: 0, turns: 0, snaps: 0, wrong: 0, stuck: 0, powers: {} };
for (let g = 0; g < games; g++) {
  const st = E.createTable('SIM', 'host', 'Host');
  const n = 2 + (g % 3);
  let clock = 1000;
  E.dispatch(st, 'host', { type: 'join', name: 'Host' }, clock);
  for (let i = 1; i < n; i++) E.dispatch(st, "host", { type: "addBot" }, clock);
  // make the host a computer player too for the sim
  st.players[0].bot = true;
  st.players = st.players.slice(0, n);
  E.dispatch(st, 'host', { type: 'start' }, clock);
  ok(st.phase === 'play', 'game did not begin');
  let steps = 0, idle = 0;
  while (st.phase === 'play' && steps < 6000) {
    clock += 100;
    const before = st.log.length ? st.log[st.log.length - 1].m : '';
    const acted = E.runBots(st, clock);
    if (acted) {
      steps++; idle = 0;
      const last = st.log[st.log.length - 1].m;
      if (last !== before) {
        if (/snapped .* (Now|their own)/.test(last)) stats.snaps++;
        if (/missed/.test(last)) stats.wrong++;
      }
      const c = census(st);
      ok(c.length === 52 && new Set(c).size === 52, `card count ${c.length} game ${g}`);
      const leak = checkLeak(st);
      ok(!leak, `${leak} game ${g}`);
    } else if (++idle > 400) { stats.stuck++; console.log('stuck', st.step, st.pendingGive, st.log.slice(-3)); break; }
  }
  if (st.phase === 'over') stats[st.how]++;
  stats.turns += steps;
  if (fails > 20) break;
}
console.log('games', games, JSON.stringify(stats));

// ---------- hand-built scenarios ----------
function table(n) {
  const st = E.createTable('T', 'p1', 'P1');
  for (let i = 2; i <= n; i++) E.dispatch(st, 'p' + i, { type: 'join', name: 'P' + i }, 0);
  E.dispatch(st, 'p1', { type: 'start' }, 0);
  for (let i = 1; i <= n; i++) E.dispatch(st, 'p' + i, { type: 'ready' }, 0);
  return st;
}
function rig(st, hands, deckTop) {
  const used = new Set([...hands.flat().filter(Boolean), ...deckTop]);
  hands.forEach((h, i) => { st.players[i].slots = h.slice(); });
  st.deck = E.SUITS.flatMap((s) => E.RANKS.map((r) => r + s)).filter((c) => !used.has(c));
  st.deck.push(...deckTop.slice().reverse());
  st.pile = [];
}
const expectThrow = (fn, msg) => { try { fn(); ok(false, 'expected refusal: ' + msg); } catch (e) { /* good */ } };
let t = 10000;

// 1. Draw, swap into an unseen top card that turns out to be a 7, power peeks own card.
{
  const st = table(2);
  rig(st, [['7S', '9H', '2C', '3D'], ['5S', '5H', '6C', 'KD']], ['4H']);
  E.dispatch(st, 'p1', { type: 'draw' }, t);
  ok(E.viewFor(st, 'p2').drawn === 'X', 'p2 must not see p1 drawn card');
  ok(E.viewFor(st, 'p1').drawn === '4H', 'p1 sees drawn card');
  E.dispatch(st, 'p1', { type: 'swap', slot: 0 }, t);
  ok(st.step === 'power' && st.power.kind === 'own', '7 from grid triggers own peek');
  E.dispatch(st, 'p1', { type: 'peekOwn', slot: 1 }, t);
  ok(E.viewFor(st, 'p1').players[0].slots[1].c === '9H', 'peek shows card');
  ok(!E.viewFor(st, 'p2').players[0].slots[1].c, 'peek hidden from p2');
  st.now = t + 5000;
  ok(!E.viewFor(st, 'p1').players[0].slots[1].c, 'peek flips back after time');
  ok(st.turn === 1, 'turn passes after 7');
}
// 2. Snap: P1 throws a 6, P2 snaps own 6. P1 then snaps P2's other 6 wrong slot -> penalty and public reveal.
{
  const st = table(2);
  rig(st, [['6S', 'AH', '2C', '3D'], ['6H', '9C', '5C', 'KS']], ['4H']);
  E.dispatch(st, 'p1', { type: 'draw' }, t);
  expectThrow(() => E.dispatch(st, 'p2', { type: 'snap', uid: 'p2', slot: 0 }, t), 'snap while closed after draw');
  E.dispatch(st, 'p1', { type: 'swap', slot: 0 }, t);
  E.dispatch(st, 'p2', { type: 'snap', uid: 'p2', slot: 0 }, t + 100);
  ok(st.players[1].slots[0] === null && st.pile.length === 2, 'own snap removes card');
  E.dispatch(st, 'p1', { type: 'snap', uid: 'p2', slot: 1 }, t + 200);
  ok(st.players[0].slots.filter(Boolean).length === 5, 'wrong snap gives penalty');
  ok(E.viewFor(st, 'p2').players[1].slots[1].c === '9C' && E.viewFor(st, 'p2').players[1].slots[1].wrong, 'wrong snap card shown to all');
  expectThrow(() => E.dispatch(st, 'p2', { type: 'draw' }, t + 300), 'draw locked right after discard');
  E.dispatch(st, 'p2', { type: 'draw' }, t + 2500);
  ok(!st.snapOpen, 'next draw closes snapping');
}
// 3. Snap someone else's card and hand one back into the same gap.
{
  const st = table(3);
  rig(st, [['8S', 'AH', '2C', '3D'], ['5S', '8H', '5C', 'KS'], ['2H', '3H', '4C', '4D']], ['QH']);
  E.dispatch(st, 'p1', { type: 'draw' }, t);
  E.dispatch(st, 'p1', { type: 'swap', slot: 0 }, t); // throws 8S, power own
  E.dispatch(st, 'p3', { type: 'snap', uid: 'p2', slot: 1 }, t + 100); // P3 snaps P2's 8H
  ok(st.pendingGive && st.pendingGive.toSlot === 1, 'give pending');
  expectThrow(() => E.dispatch(st, 'p1', { type: 'peekOwn', slot: 1 }, t + 150), 'power blocked while give pending');
  E.dispatch(st, 'p3', { type: 'give', slot: 0 }, t + 200);
  ok(st.players[1].slots[1] === '2H' && st.players[2].slots[0] === null, 'card lands in the gap');
  E.dispatch(st, 'p1', { type: 'peekOwn', slot: 1 }, t + 300);
  ok(st.turn === 1, 'P1 still used power after snap by someone else');
}
// 4. Jack skip: 3 players, P2 skipped, stacking a second Jack does not skip more.
{
  const st = table(3);
  rig(st, [['JS', 'AH', '2C', '3D'], ['5S', '8H', '5C', 'KS'], ['2H', '3H', '4C', '4D']], ['JH']);
  E.dispatch(st, 'p1', { type: 'draw' }, t);
  E.dispatch(st, 'p1', { type: 'throw' }, t);
  E.dispatch(st, 'p1', { type: 'snap', uid: 'p1', slot: 0 }, t + 50);
  E.dispatch(st, 'p1', { type: 'useJack' }, t + 100);
  ok(st.players[st.turn].uid === 'p3', 'P2 skipped, P3 next');
}
// 5. Jack in 2 players comes back to P1.
{
  const st = table(2);
  rig(st, [['5S', 'AH', '2C', '3D'], ['5H', '8H', '5C', 'KS']], ['JD']);
  E.dispatch(st, 'p1', { type: 'draw' }, t);
  E.dispatch(st, 'p1', { type: 'throw' }, t);
  E.dispatch(st, 'p1', { type: 'useJack' }, t);
  ok(st.players[st.turn].uid === 'p1', '2 players: Jack gives P1 another turn');
}
// 6. Queen blind swap between two other players (3 players).
{
  const st = table(3);
  rig(st, [['5S', 'AH', '2C', '3D'], ['5H', '8H', '5C', 'KS'], ['2H', '3H', '4C', '4D']], ['QD']);
  E.dispatch(st, 'p1', { type: 'draw' }, t);
  E.dispatch(st, 'p1', { type: 'throw' }, t);
  E.dispatch(st, 'p1', { type: 'powerSwap', a: { uid: 'p2', slot: 3 }, b: { uid: 'p3', slot: 0 } }, t);
  ok(st.players[1].slots[3] === '2H' && st.players[2].slots[0] === 'KS', 'Q swaps P2 and P3');
  ok(!E.viewFor(st, 'p1').players[1].slots[3].c, 'Q swap stays blind');
}
// 7. King: peek own, peek other, swap. Black K worth 0, red K 13.
{
  const st = table(2);
  rig(st, [['5S', 'AH', '2C', '3D'], ['5H', 'KC', '5C', 'KH']], ['KD']);
  ok(E.value('KC') === 0 && E.value('KH') === 13, 'king values');
  E.dispatch(st, 'p1', { type: 'draw' }, t);
  E.dispatch(st, 'p1', { type: 'throw' }, t);
  E.dispatch(st, 'p1', { type: 'peekOwn', slot: 0 }, t);
  E.dispatch(st, 'p1', { type: 'peekOther', uid: 'p2', slot: 1 }, t);
  const v = E.viewFor(st, 'p1');
  ok(v.players[0].slots[0].c === '5S' && v.players[1].slots[1].c === 'KC', 'both K peeks visible');
  E.dispatch(st, 'p1', { type: 'powerSwap', a: { uid: 'p1', slot: 0 }, b: { uid: 'p2', slot: 1 } }, t);
  ok(st.players[0].slots[0] === 'KC', 'K swap done');
}
// 8. Declare: only with 2 or fewer, start of turn, wrong = penalty, right = win.
{
  const st = table(2);
  rig(st, [['5S', null, null, '3D'], ['5H', '8H', '5C', 'KS']], []);
  expectThrow(() => E.dispatch(st, 'p2', { type: 'declare', total: 18 }, t), 'declare with 4 cards');
  E.dispatch(st, 'p1', { type: 'declare', total: 7 }, t);
  ok(st.players[0].slots.filter(Boolean).length === 3 && st.turn === 1, 'wrong declare = penalty and turn passes');
  const st2 = table(2);
  rig(st2, [['5S', null, null, 'KC'], ['5H', '8H', '5C', 'KS']], []);
  E.dispatch(st2, 'p1', { type: 'declare', total: 5 }, t);
  ok(st2.phase === 'over' && st2.winner === 'p1' && st2.how === 'declare', 'right declare wins');
}
// 9. Empty grid wins, including handing over your last card after snapping someone.
{
  const st = table(2);
  rig(st, [['9S', null, null, null], ['4H', '8H', '5C', 'KS']], ['4C']);
  st.turn = 1;
  E.dispatch(st, 'p2', { type: 'draw' }, t);
  E.dispatch(st, 'p2', { type: 'swap', slot: 0 }, t); // throws 4H
  E.dispatch(st, 'p1', { type: 'snap', uid: 'p2', slot: 0 }, t + 100); // the 4C that P2 just placed
  ok(st.phase === 'play', 'no win while give pending');
  E.dispatch(st, 'p1', { type: 'give', slot: 0 }, t + 200);
  ok(st.phase === 'over' && st.winner === 'p1' && st.how === 'empty', 'giving last card empties grid = win');
}
// 10. Penalty fills a gap first, otherwise adds a slot.
{
  const st = table(2);
  rig(st, [['5S', null, '2C', '3D'], ['5H', '8H', '5C', 'KS']], ['7H']);
  E.dispatch(st, 'p1', { type: 'draw' }, t);
  E.dispatch(st, 'p1', { type: 'throw' }, t);
  E.dispatch(st, 'p1', { type: 'snap', uid: 'p1', slot: 2 }, t + 50); // wrong
  ok(st.players[0].slots[1] && st.players[0].slots.length === 4, 'penalty fills the gap');
}
console.log(fails ? `${fails} FAILURES` : 'ALL SCENARIOS PASSED');
process.exit(fails ? 1 : 0);

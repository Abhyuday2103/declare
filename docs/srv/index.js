// Declare online tables. Runs in the same Firebase project as Teen Patti but never touches it:
// its own function (dc), its own collection (dtables), its own codebase (declare).
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import * as E from './engine.js';

initializeApp();
const db = getFirestore();
const COL = 'dtables';

function roomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// Full state (deck and every card) lives in dtables/{id}/secret/state, which nobody can read.
// Each player gets their own view at dtables/{id}/views/{uid} that only they can read.
function writeState(tx, st) {
  const t = db.collection(COL).doc(st.id);
  tx.set(t.collection('secret').doc('state'), { json: JSON.stringify(st) });
  tx.set(t, { id: st.id, phase: st.phase, hostUid: st.hostUid, seated: st.players.length, updatedAt: FieldValue.serverTimestamp() });
  for (const p of st.players) if (!p.bot) tx.set(t.collection('views').doc(p.uid), { json: JSON.stringify(E.viewFor(st, p.uid)) });
}

export const dc = onCall({ cors: true, maxInstances: 10 }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const d = req.data || {};
  try {
    if (d.op === 'create') {
      for (let k = 0; k < 6; k++) {
        const id = roomCode();
        const ref = db.collection(COL).doc(id).collection('secret').doc('state');
        const view = await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists) return null;
          const st = E.createTable(id, uid, d.name);
          st.now = Date.now();
          writeState(tx, st);
          return E.viewFor(st, uid);
        });
        if (view) return { tableId: id, view };
      }
      throw new Error('Could not make a room code. Try again.');
    }

    const id = String(d.tableId || '').toUpperCase().trim();
    const ref = db.collection(COL).doc(id).collection('secret').doc('state');
    const view = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Table not found. Check the code.');
      const st = JSON.parse(snap.data().json);
      const now = Date.now();
      let changed = false;
      if (d.op === 'act') {
        E.dispatch(st, uid, d.action || {}, now);
        changed = true;
      } else if (d.op === 'view') {
        if (!st.players.some((p) => p.uid === uid)) throw new Error('You are not at this table.');
        st.now = now;
      } else if (d.op !== 'tick') {
        throw new Error('Unknown request.');
      }
      // Computer players: run whatever moves are due (a few at most per call).
      for (let i = 0; i < 3; i++) { if (E.runBots(st, now)) changed = true; else break; }
      if (changed) writeState(tx, st);
      return E.viewFor(st, uid);
    });
    return { ok: true, view };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('failed-precondition', (e && e.message) || 'Something went wrong');
  }
});

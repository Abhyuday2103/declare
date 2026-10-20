# Declare

Multiplayer Declare for 2 to 4 players, with computer players for practice.
Same setup as Teen Patti: GitHub Pages serves the `docs` folder, and a Firebase function deals and runs every online table so nobody's browser ever gets another player's cards.

It shares the Teen Patti Firebase project but stays out of its way:
- its own function, `dc`
- its own codebase, `declare` (deploying Declare never touches the Teen Patti function, and the other way around)
- its own collection, `dtables`

## Files
- `docs/` the website (index.html, style.css, app.js, engine.js, firebase-config.js)
- `functions/` the server (index.js, engine.js, package.json)
- `firestore.rules` covers both games, safe to deploy from either folder
- `tools/sim.mjs` runs thousands of computer games and rule scenarios: `node tools/sim.mjs`

`docs/engine.js` and `functions/engine.js` must stay identical. If one changes, copy it to the other and redeploy the function.

## Rules as built
- 4 cards face down in a 2x2 grid. You see your bottom two once, then tap Memorized.
- Your turn: draw from the deck only. Swap it into any of your cards (it goes exactly where the old one was), or throw it on the pile.
- Any power card that lands on the pile from your turn, whether you drew it or it came out of your grid, uses its power. Powers are optional.
  - 7, 8: look at one of your own cards.
  - 9, 10: look at one card of someone else.
  - J: skip the next player. Stacking a second Jack doesn't skip more. In 2 players you go again.
  - Q: blind swap of any two cards between two different players (including two other players).
  - K: look at one of yours, look at one of someone else's, then optionally swap any two cards between two players.
- Values: A 1, number cards face value, J 11, Q 12, red K 13, black K 0.
- Snap: when a card hits the pile, anyone can throw a card of the same rank until the next player draws. The next draw is held for 2 seconds so people have time. Snapping never uses a power. Snap your own card to get rid of it. Snap someone else's and you pick one of your cards to give them, blind, into the gap theirs left. Wrong card: it flips face up for everyone for a moment, goes back, and you take a penalty card face down. The app never hints that a snap is possible.
- Penalty cards fill a gap in your grid first, otherwise they start a new column.
- Declare: at the start of your turn instead of drawing, with 2 cards or fewer. Right total wins. Wrong total is a penalty card and your turn ends.
- Emptying your grid wins instantly, including handing over your last card after a snap.
- Deck runs out: the pile minus its top card gets shuffled back in.
- Peeks stay face up for 3 seconds (4 for King peeks), then it's memory.

## Deploying the server (any laptop)
The Firebase project (`teenpatti-44fde`) and web config are already filled in.
1. Install Node.js LTS from nodejs.org.
2. Open Terminal (Mac) or PowerShell (Windows) and run, one line at a time:
   ```
   cd ~/Downloads/declare
   npx firebase-tools login
   cd functions
   npm install
   cd ..
   npx firebase-tools deploy --only functions,firestore:rules
   ```

## Updating later
Website changes go live from GitHub on their own. If anything in `functions/` changed, run the last line above again from this folder.

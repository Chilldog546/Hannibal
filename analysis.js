// analysis.js — pure functions: no DOM, no chrome APIs. Loaded before
// content.js on lichess.org, and require()-able from Node for tests.
//
// A "game" record built by content.js looks like:
// {
//   id, playerColor: 'white'|'black', playerName, opponentName,
//   vsComputer, rated, initialClock (secs|null),
//   plies: [{ san, t (ms|null if played before we loaded),
//             clockMine, clockOpp (secs|null), matW, matB (|null) }],
//   fired: { [key]: true },   // trigger dedupe
//   result: '1-0'|'0-1'|'½-½'|null, status: string
// }

(function (root) {
  const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const PIECE_NAME = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };

  // ------------------------------------------------------------ basics

  function parseClock(text) {
    if (!text) return null;
    const m = String(text).replace(/[^\d:.]/g, '').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d))?$/);
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +m[4] / 10 : 0);
  }

  function materialFromFen(fen) {
    if (!fen || fen === 'unavailable') return null;
    let w = 0, b = 0;
    for (const ch of fen.split(' ')[0]) {
      const v = PIECE_VALUE[ch.toLowerCase()];
      if (v === undefined) continue;
      if (ch === ch.toUpperCase()) w += v; else b += v;
    }
    return { w, b };
  }

  // Material after every ply, by replaying the moves (exact; no board reading).
  function materialSeries(sans, Chess) {
    if (!Chess) return sans.map(() => null);
    const c = new Chess();
    const out = [];
    let ok = true;
    for (const san of sans) {
      if (ok) {
        try { c.move(san); } catch { ok = false; }
      }
      out.push(ok ? materialFromFen(c.fen()) : null);
    }
    return out;
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  const isMine = (g, i) => (i % 2 === 0) === (g.playerColor === 'white');
  const moveNo = i => Math.floor(i / 2) + 1;
  const plyLabel = (g, i) => `${moveNo(i)}${i % 2 === 0 ? '.' : '…'}${g.plies[i]?.san ?? ''}`;
  const myMat = (g, i) => {
    const p = g.plies[i];
    if (!p || p.matW == null) return null;
    return g.playerColor === 'white' ? p.matW : p.matB;
  };
  const pieceOf = san => (san.startsWith('O-O') ? 'K' : /^[KQRBN]/.test(san) ? san[0] : 'P');

  // Material balance from the player's side (mine minus theirs) after ply i.
  const balance = (g, i) => {
    const p = g.plies[i];
    if (!p || p.matW == null) return null;
    return g.playerColor === 'white' ? p.matW - p.matB : p.matB - p.matW;
  };

  // Net material the player lost to opponent ply j: balance before it minus
  // balance after the player's reply. An even trade (they take, you take
  // back) is 0, so it never counts as a loss.
  //
  // A trade the PLAYER starts (Bxc6 dxc6) is not a loss either: when ply j
  // recaptures on the square the player's previous move just captured on,
  // the baseline is the balance before that capture (ply j-2).
  const destOf = san => (san.match(/([a-h][1-8])(=[QRBN])?[+#]?$/) || [])[1];
  function netLoss(g, j) {
    const prev = g.plies[j - 1], cur = g.plies[j];
    const recapture = j >= 2 && prev && cur && /x/.test(prev.san) && /x/.test(cur.san) && destOf(prev.san) === destOf(cur.san);
    const before = recapture ? balance(g, j - 2) : balance(g, j - 1);
    const after = g.plies[j + 1] ? balance(g, j + 1) : balance(g, j);
    return before == null || after == null ? null : before - after;
  }

  // "Fast" and "long" depend on the time control and on this player's own
  // pace: 2s is careful in bullet and reckless in classical.
  function paceOf(g, uptoExclusive) {
    const xs = [];
    for (let k = 0; k < uptoExclusive; k++) {
      if (!isMine(g, k)) continue;
      const s = thinkTime(g, k);
      if (s != null) xs.push(s);
    }
    const med = median(xs);
    const base = g.initialClock || 600;
    const scaledFast = Math.min(6, Math.max(1, base / 200)); // 3+0 → 1s, 10+0 → 3s
    const fast = xs.length >= 4 ? Math.max(0.8, Math.min(scaledFast, med * 0.5)) : scaledFast;
    const longMin = Math.max(8, base / 24);                   // 3+0 → 8s, 10+0 → 25s
    return { samples: xs.length, med, fast, longMin };
  }

  // Seconds the mover spent on ply i (null if we didn't see both moments).
  function thinkTime(g, i) {
    const a = g.plies[i - 1], b = g.plies[i];
    if (!a || !b || a.t == null || b.t == null) return null;
    return Math.max(0, (b.t - a.t) / 1000);
  }

  // ------------------------------------------------------------ openings

  // lines: [[eco, name, "e4 e5 Nf3 ..."], ...] from openings.json
  function buildBook(lines) {
    const named = new Map();  // full line -> {eco, name}
    const prefixes = new Set(); // every prefix of every line
    for (const [eco, name, pgn] of lines) {
      named.set(pgn, { eco, name });
      const parts = pgn.split(' ');
      for (let k = 1; k <= parts.length; k++) prefixes.add(parts.slice(0, k).join(' '));
    }
    return { named, prefixes };
  }

  // Deepest named opening matching the game, and the first ply that left
  // all known theory (index into moves), or null if still in book.
  function bookState(book, moves) {
    let leftAtPly = null;
    for (let k = 1; k <= moves.length; k++) {
      if (!book.prefixes.has(moves.slice(0, k).join(' '))) { leftAtPly = k - 1; break; }
    }
    const depth = leftAtPly == null ? moves.length : leftAtPly;
    let opening = null;
    for (let k = depth; k >= 1; k--) {
      const hit = book.named.get(moves.slice(0, k).join(' '));
      if (hit) { opening = hit; break; }
    }
    return { opening, leftAtPly };
  }

  // ------------------------------------------------------------ triggers
  // Each trigger is behavioural: built only from the player's own clock and
  // reactions, plus public facts (an opening name, material the opponent
  // already took). Nothing here judges the position or suggests a move.

  const OWNER = {
    rush_after_loss: 'ashby',
    hesitation: 'vale',
    time_burn: 'general',
    left_book: 'general',
    session_start: 'ashby'
  };

  function evaluateTriggers(g, book) {
    const out = [];
    const L = g.plies.length - 1;
    if (L < 0 || !isMine(g, L)) return out;
    const tt = thinkTime(g, L);
    const myClock = g.plies[L].clockMine;
    const hasClock = myClock != null;

    // Rush after loss: the opponent won material (net of any recapture)
    // within the last few plies, and the player's last two replies were both
    // fast for this time control and this player.
    for (let j = L - 1; j >= Math.max(1, L - 5); j--) {
      if (isMine(g, j)) continue;
      const lost = netLoss(g, j);
      if (lost == null || lost < 2) continue;
      const key = 'rush:' + j;
      if (g.fired[key]) break;
      const replies = [];
      for (let k = j + 1; k <= L; k++) if (isMine(g, k)) replies.push(k);
      const last2 = replies.slice(-2);
      const pace = paceOf(g, j);
      const fast = last2.length === 2 && last2.every(k => {
        const s = thinkTime(g, k);
        return s != null && s < pace.fast;
      });
      const lowClock = hasClock && myClock < 30;
      if (fast && !lowClock) {
        g.fired[key] = true;
        out.push({
          type: 'rush_after_loss',
          why: `Lost ${lost} point${lost > 1 ? 's' : ''} of material on ${plyLabel(g, j)}, then replied in ${last2.map(k => thinkTime(g, k).toFixed(1) + 's').join(' and ')}` +
            (pace.med != null ? ` (usual ${pace.med.toFixed(1)}s)` : ''),
          facts: [
            `With ${plyLabel(g, j)} the opponent won material worth ${lost} that the player did not win back.`,
            ...(thinkTime(g, j - 1) != null ? [`The player's own move just before that, ${plyLabel(g, j - 1)}, took ${thinkTime(g, j - 1).toFixed(1)}s.`] : []),
            `The player's next two moves took ${last2.map(k => thinkTime(g, k).toFixed(1) + 's').join(' and ')}` +
              (pace.med != null ? `; their usual pace is about ${pace.med.toFixed(1)}s.` : '.')
          ]
        });
      }
      break;
    }

    // Hesitation: a think far longer than this player's own norm.
    if (hasClock && tt != null) {
      const pace = paceOf(g, L);
      const med = pace.med;
      if (pace.samples >= 4 && tt >= Math.max(pace.longMin, 4 * med)) {
        g.fired['hes:' + L] = true;
        out.push({
          type: 'hesitation',
          why: `${Math.round(tt)}s on ${plyLabel(g, L)}, against a usual ${med.toFixed(1)}s`,
          facts: [
            `The player spent ${Math.round(tt)}s on ${plyLabel(g, L)}.`,
            `Their usual think this game is about ${med.toFixed(1)}s.`
          ]
        });
      }
    }

    // Time burn: most of the clock gone before the middle of the game.
    if (hasClock && g.initialClock && L < 40 && !g.fired.time_burn) {
      const used = 1 - myClock / g.initialClock;
      if (used >= 0.6) {
        g.fired.time_burn = true;
        out.push({
          type: 'time_burn',
          why: `${Math.round(used * 100)}% of the clock gone by move ${moveNo(L)}`,
          facts: [`By move ${moveNo(L)} the player has used ${Math.round(used * 100)}% of their clock.`]
        });
      }
    }

    // Left book: the player's own move took the game out of known theory.
    if (book && !g.fired.left_book && !g.fired.book_done) {
      const moves = g.plies.map(p => p.san);
      const st = bookState(book, moves);
      if (st.leftAtPly === L) {
        g.fired.left_book = true;
        out.push({
          type: 'left_book',
          why: `Left ${st.opening ? 'the ' + st.opening.name.split(':')[0] : 'opening theory'} with ${plyLabel(g, L)}`,
          facts: [
            st.opening
              ? `The game was in the ${st.opening.name} (${st.opening.eco}).`
              : 'The game was in standard opening theory.',
            `The player left known theory themselves with ${plyLabel(g, L)}.`
          ]
        });
      } else if (st.leftAtPly != null && st.leftAtPly < L) {
        g.fired.book_done = true; // opponent left first; nothing to say
      }
    }

    return out.map(t => ({ ...t, owner: OWNER[t.type], ply: L, label: plyLabel(g, L) }));
  }

  // At the start of a game: losing streak or the late hour.
  function sessionStartTrigger(dossier, hour) {
    const facts = [];
    const recent = (dossier?.games || []).slice(-3);
    const streak = lossStreak(dossier?.games || []);
    if (streak >= 3) facts.push(`The player has lost their last ${streak} games in a row and is starting another.`);
    if (hour >= 0 && hour < 5) facts.push(`It is ${hour}:00 at night where the player is.`);
    if (!facts.length) return null;
    if (recent.length) facts.push(`Last results: ${recent.map(r => r.result || '?').join(', ')}.`);
    const why = [streak >= 3 ? `${streak} losses in a row` : null, hour >= 0 && hour < 5 ? `${hour}:00 at night` : null].filter(Boolean).join(', ');
    return { type: 'session_start', owner: OWNER.session_start, why, facts, ply: -1, label: 'before the game' };
  }

  // ------------------------------------------------------------ summaries

  function outcome(result, color) {
    if (result === '½-½') return 'draw';
    if (result === '1-0') return color === 'white' ? 'win' : 'loss';
    if (result === '0-1') return color === 'black' ? 'win' : 'loss';
    return null;
  }

  function summarizeGame(g, book) {
    const moves = g.plies.map(p => p.san);
    const mine = g.plies.map((_, i) => i).filter(i => isMine(g, i));
    const thinks = mine.map(i => ({ i, s: thinkTime(g, i) })).filter(x => x.s != null);
    const longest = thinks.reduce((a, b) => (!a || b.s > a.s ? b : a), null);
    let losses = 0;
    for (let j = 1; j < g.plies.length; j++) {
      if (isMine(g, j)) continue;
      const lost = netLoss(g, j);
      if (lost != null && lost >= 2) losses++;
    }
    // How fast the player answers right after losing material, relative to
    // their own median this game (0.4 = 2.5x faster than usual).
    const med = median(thinks.map(x => x.s));
    const ratios = [];
    for (let j = 1; j < g.plies.length - 1; j++) {
      if (isMine(g, j)) continue;
      const lost = netLoss(g, j);
      const s = thinkTime(g, j + 1);
      if (lost != null && lost >= 2 && s != null && med) ratios.push(s / med);
    }
    const st = book ? bookState(book, moves) : { opening: null, leftAtPly: null };
    // Haste BEFORE a loss: how long the player thought on their own move
    // right before the opponent won material, against their usual think.
    // Pure timing; it says nothing about whether the move was good.
    const before = [];
    for (let j = 1; j < g.plies.length; j++) {
      if (isMine(g, j)) continue;
      const lost = netLoss(g, j);
      const s = thinkTime(g, j - 1);
      if (lost != null && lost >= 2 && s != null && med) {
        before.push({ move: plyLabel(g, j - 1), secs: +s.toFixed(1), ratio: s / med, lost });
      }
    }
    const castleIdx = mine.find(i => moves[i].startsWith('O-O'));
    const last = g.plies[g.plies.length - 1] || {};
    const firedTypes = Object.keys(g.fired || {}).filter(k => k !== 'book_done').map(k => k.split(':')[0])
      .map(k => (k === 'rush' ? 'rush_after_loss' : k === 'hes' ? 'hesitation' : k));
    return {
      id: g.id,
      date: Date.now(),
      color: g.playerColor,
      opponent: g.opponentName || '?',
      vsComputer: !!g.vsComputer,
      rated: g.rated,
      result: outcome(g.result, g.playerColor),
      status: g.status || '',
      opening: st.opening ? `${st.opening.name} (${st.opening.eco})` : null,
      leftBookMove: st.leftAtPly != null ? moveNo(st.leftAtPly) : null,
      leftBookBy: st.leftAtPly == null ? null : isMine(g, st.leftAtPly) ? 'player' : 'opponent',
      plies: g.plies.length,
      avgThink: thinks.length ? +(thinks.reduce((a, x) => a + x.s, 0) / thinks.length).toFixed(1) : null,
      longestThink: longest ? { secs: Math.round(longest.s), move: plyLabel(g, longest.i) } : null,
      materialLossEvents: losses,
      castledMove: castleIdx != null ? moveNo(castleIdx) : null,
      kingWalks: mine.filter(i => moves[i].startsWith('K')).length,
      queenOutEarly: mine.slice(0, 6).some(i => moves[i].startsWith('Q')),
      triggers: [...new Set(firedTypes)],
      medianThink: med != null ? +med.toFixed(1) : null,
      afterLossPace: ratios.length ? +(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2) : null,
      beforeLossPace: before.length ? +(before.reduce((a, b) => a + b.ratio, 0) / before.length).toFixed(2) : null,
      beforeLossEvents: before.length,
      fastBeforeLoss: before.filter(b => b.ratio < 0.5).length,
      beforeLoss: before.slice(0, 3).map(b => ({ move: b.move, secs: b.secs, lost: b.lost })),
      clockLeftAt20: (() => {
        const i = mine.find(k => moveNo(k) === 20);
        const c = i != null ? g.plies[i].clockMine : null;
        return c != null && g.initialClock ? +(c / g.initialClock).toFixed(2) : null;
      })(),
      speed: g.speed || null,
      source: g.source || 'live',
      finalMaterialDiff: last.matW == null ? null
        : (g.playerColor === 'white' ? last.matW - last.matB : last.matB - last.matW)
    };
  }

  // Plain-language facts about one finished game, for the debrief.
  function debriefFacts(s) {
    const f = [];
    f.push(`Result for the player: ${s.result || 'unknown'}${s.status ? ' (' + s.status + ')' : ''}. ` +
      `They played ${s.color} against ${s.opponent}${s.vsComputer ? ', a computer' : ''}.`);
    f.push(`The game lasted ${Math.ceil(s.plies / 2)} moves.`);
    if (s.opening) {
      f.push(`Opening: ${s.opening}.` +
        (s.leftBookMove ? ` Known theory ended at move ${s.leftBookMove}, left by the ${s.leftBookBy}.` : ''));
    }
    if (s.avgThink != null) {
      f.push(`Average think: ${s.avgThink}s.` +
        (s.longestThink ? ` Longest: ${s.longestThink.secs}s on ${s.longestThink.move}.` : ''));
    }
    f.push(`Times the opponent won material outright (not an even trade): ${s.materialLossEvents}.`);
    if (s.beforeLossEvents && s.medianThink != null) {
      f.push(`Their usual think this game: ${s.medianThink}s. The move right before each material loss took: ` +
        s.beforeLoss.map(b => `${b.secs}s on ${b.move}`).join(', ') +
        (s.beforeLossEvents > s.beforeLoss.length ? ` (and ${s.beforeLossEvents - s.beforeLoss.length} more)` : '') +
        `. ${s.fastBeforeLoss} of ${s.beforeLossEvents} were made in under half their usual time.`);
    }
    if (s.triggers.includes('rush_after_loss')) f.push('Rushed their moves right after losing material.');
    if (s.triggers.includes('hesitation')) f.push('Froze on at least one move, far beyond their own norm.');
    if (s.triggers.includes('time_burn')) f.push('Used most of their clock before move 20.');
    f.push(s.castledMove ? `Castled on move ${s.castledMove}.` : 'Never castled.');
    if (s.kingWalks && !s.castledMove) f.push(`Moved the king by hand ${s.kingWalks} time(s).`);
    if (s.queenOutEarly) f.push('Brought the queen out within the first six moves.');
    if (s.finalMaterialDiff != null) {
      f.push(`Material balance at the end: ${s.finalMaterialDiff > 0 ? '+' : ''}${s.finalMaterialDiff} for the player.`);
    }
    return f;
  }

  function lossStreak(games) {
    let n = 0;
    for (let i = games.length - 1; i >= 0 && games[i].result === 'loss'; i--) n++;
    return n;
  }

  // Cross-game facts for the characters (the "file").
  function dossierFacts(games, n = 12) {
    const g = games.slice(-n);
    if (!g.length) return ['No earlier games observed. This is the first meeting.'];
    const count = f => g.filter(f).length;
    const facts = [];
    const w = count(x => x.result === 'win'), l = count(x => x.result === 'loss'), d = count(x => x.result === 'draw');
    facts.push(`Earlier games observed: ${games.length} (recent record ${w} wins, ${l} losses, ${d} draws).`);
    const streak = lossStreak(games);
    if (streak >= 2) facts.push(`Currently on a ${streak}-game losing streak.`);
    const rush = count(x => x.triggers?.includes('rush_after_loss'));
    if (rush) facts.push(`Rushed moves right after losing material in ${rush} of the last ${g.length} games.`);
    const hes = count(x => x.triggers?.includes('hesitation'));
    if (hes) facts.push(`Froze on a single move (far beyond their norm) in ${hes} of the last ${g.length} games.`);
    const burn = count(x => x.triggers?.includes('time_burn'));
    if (burn) facts.push(`Burned most of the clock before move 20 in ${burn} games.`);
    const uncastled = count(x => x.plies >= 24 && x.castledMove == null);
    if (uncastled >= 2) facts.push(`Did not castle at all in ${uncastled} games that lasted 12+ moves.`);
    const early = count(x => x.queenOutEarly);
    if (early >= 2) facts.push(`Brought the queen out in the first six moves in ${early} games.`);
    const selfLeft = g.filter(x => x.leftBookBy === 'player' && x.leftBookMove);
    if (selfLeft.length >= 2) {
      const avg = selfLeft.reduce((a, x) => a + x.leftBookMove, 0) / selfLeft.length;
      facts.push(`Usually leaves opening theory themselves, around move ${Math.round(avg)}.`);
    }
    const openings = {};
    g.forEach(x => { if (x.opening) openings[x.opening] = (openings[x.opening] || 0) + 1; });
    const top = Object.entries(openings).sort((a, b) => b[1] - a[1]).filter(([, c]) => c >= 2);
    if (top.length) facts.push(`Repeated openings: ${top.slice(0, 2).map(([o, c]) => `${o} ×${c}`).join(', ')}.`);
    const lossesHow = g.filter(x => x.result === 'loss' && x.status).map(x => x.status);
    if (lossesHow.length) facts.push(`How recent losses ended: ${lossesHow.slice(-3).join(' | ')}.`);
    const ev = g.reduce((a, x) => a + (x.beforeLossEvents || 0), 0);
    const fast = g.reduce((a, x) => a + (x.fastBeforeLoss || 0), 0);
    if (ev >= 4) facts.push(`Of ${ev} material losses in these games, ${fast} came right after a move made in under half their usual time.`);
    return facts;
  }

  function historyCount(games, type) {
    return games.filter(x => x.triggers?.includes(type)).length;
  }

  // ------------------------------------------------------- Lichess import
  // One game from GET /api/games/user/{name} (NDJSON, clocks=true) turned
  // into the same record the live tracker builds, then run through the same
  // triggers. Clock values are centiseconds remaining after each ply.
  function gameFromLichess(j, username, Chess, book) {
    const me = String(username).toLowerCase();
    const white = j.players?.white?.user?.name || (j.players?.white?.aiLevel ? `Stockfish level ${j.players.white.aiLevel}` : 'Anonymous');
    const black = j.players?.black?.user?.name || (j.players?.black?.aiLevel ? `Stockfish level ${j.players.black.aiLevel}` : 'Anonymous');
    const color = white.toLowerCase() === me ? 'white' : black.toLowerCase() === me ? 'black' : null;
    if (!color || j.variant && j.variant !== 'standard') return null;
    const sans = (j.moves || '').split(' ').filter(Boolean);
    if (sans.length < 2) return null;
    const opp = color === 'white' ? j.players.black : j.players.white;
    const initial = j.clock?.initial ?? null, inc = j.clock?.increment ?? 0;
    // clocks[i] = mover's remaining time after ply i. A game lost on time
    // carries one extra trailing reading (the flag), so trim to the moves.
    let clocks = Array.isArray(j.clocks) ? j.clocks.slice(0, sans.length) : null;
    if (clocks && clocks.length !== sans.length) clocks = null;
    const mats = materialSeries(sans, Chess);
    // Each ply's think = own previous clock - clock now + increment (lichess
    // doesn't run the clock on the first move of each side). thinkTime()
    // reads t[i] - t[i-1], so t is a running sum of thinks.
    const think = i => {
      if (!clocks || initial == null || i < 2) return null;
      return Math.max(0, (clocks[i - 2] - clocks[i]) / 100 + inc);
    };
    let acc = 0;
    const plies = sans.map((san, i) => {
      const mineIdx = (i % 2 === 0) === (color === 'white');
      let t = null;
      if (clocks && initial != null) {
        if (i === 1) t = 0;
        else if (i >= 2) { acc += think(i) * 1000; t = acc; }
      }
      return {
        san, t,
        clockMine: clocks && mineIdx ? clocks[i] / 100 : null,
        clockOpp: clocks && !mineIdx ? clocks[i] / 100 : null,
        matW: mats[i] ? mats[i].w : null,
        matB: mats[i] ? mats[i].b : null
      };
    });
    const g = {
      id: j.id, playerColor: color, playerName: username,
      opponentName: opp?.user?.name || (opp?.aiLevel ? `Stockfish level ${opp.aiLevel}` : 'Anonymous'),
      vsComputer: !!opp?.aiLevel || opp?.user?.title === 'BOT',
      rated: !!j.rated, initialClock: initial, speed: j.speed, source: 'import',
      plies: [], fired: {},
      // No winner on a finished game = a draw of some kind (agreement,
      // stalemate, repetition, or a flag against insufficient material).
      result: j.winner === 'white' ? '1-0' : j.winner === 'black' ? '0-1'
        : ['aborted', 'noStart', 'created', 'started', 'unknownFinish', 'cheat'].includes(j.status) ? null : '½-½',
      status: j.status || ''
    };
    for (const p of plies) { g.plies.push(p); evaluateTriggers(g, book); }
    const sum = summarizeGame(g, book);
    sum.date = j.createdAt || sum.date;
    return sum;
  }

  // Aggregate stats over a set of game summaries (the agent's main tool).
  function aggregate(games) {
    const n = games.length;
    if (!n) return { games: 0 };
    const pct = f => Math.round(100 * games.filter(f).length / n);
    const avg = xs => { const v = xs.filter(x => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; };
    const statusCount = {};
    games.filter(g => g.result === 'loss').forEach(g => { statusCount[g.status] = (statusCount[g.status] || 0) + 1; });
    const openings = {};
    games.forEach(g => { if (g.opening) openings[g.opening] = (openings[g.opening] || 0) + 1; });
    return {
      games: n,
      record: { wins: games.filter(g => g.result === 'win').length, losses: games.filter(g => g.result === 'loss').length, draws: games.filter(g => g.result === 'draw').length },
      medianThinkSecs: avg(games.map(g => g.medianThink)),
      speedsMixed: new Set(games.filter(g => g.medianThink != null).map(g => g.speed)).size > 1,
      afterLossPaceRatio: avg(games.map(g => g.afterLossPace)),
      beforeLossPaceRatio: avg(games.map(g => g.beforeLossPace)),
      pctMaterialLossesAfterFastMove: (() => {
        const ev = games.reduce((a, g) => a + (g.beforeLossEvents || 0), 0);
        return ev ? Math.round(100 * games.reduce((a, g) => a + (g.fastBeforeLoss || 0), 0) / ev) : null;
      })(),
      pctGamesRushedAfterLoss: pct(g => g.triggers?.includes('rush_after_loss')),
      pctGamesWithFreeze: pct(g => g.triggers?.includes('hesitation')),
      pctGamesClockBurnedEarly: pct(g => g.triggers?.includes('time_burn')),
      avgClockFractionLeftAtMove20: avg(games.map(g => g.clockLeftAt20)),
      pctNeverCastled: pct(g => g.plies >= 24 && g.castledMove == null),
      pctQueenOutEarly: pct(g => g.queenOutEarly),
      avgMoveLeftBookBySelf: avg(games.filter(g => g.leftBookBy === 'player').map(g => g.leftBookMove)),
      avgMaterialLossEvents: avg(games.map(g => g.materialLossEvents)),
      howLossesEnded: statusCount,
      pctLossesResigned: (() => { const l = games.filter(g => g.result === 'loss'); return l.length ? Math.round(100 * l.filter(g => g.status === 'resign').length / l.length) : null; })(),
      pctGamesLostOnTime: pct(g => g.result === 'loss' && g.status === 'outoftime'),
      topOpenings: Object.entries(openings).sort((a, b) => b[1] - a[1]).slice(0, 4)
    };
  }

  function filterGames(games, f = {}) {
    return games.filter(g =>
      (!f.result || g.result === f.result) &&
      (!f.color || g.color === f.color) &&
      (!f.speed || g.speed === f.speed) &&
      (f.vsComputer == null || g.vsComputer === f.vsComputer));
  }

  // What has changed in games watched live since the file was opened.
  function trend(games, since) {
    if (!since) return [];
    const sinceAll = games.filter(g => (g.date || 0) >= since && g.source !== 'import');
    // Compare like with like: the kind of opponent most games since were against.
    const vsComp = sinceAll.filter(g => g.vsComputer).length * 2 >= sinceAll.length;
    const after = sinceAll.filter(g => !!g.vsComputer === vsComp);
    const before = games.filter(g => (g.date || 0) < since && !!g.vsComputer === vsComp);
    if (before.length < 3 || after.length < 3) return [];
    const a = aggregate(before), b = aggregate(after);
    const rows = [
      ['pctGamesRushedAfterLoss', 'games with a rush after losing material', '%'],
      ['pctGamesWithFreeze', 'games with a long freeze', '%'],
      ['pctGamesClockBurnedEarly', 'games with most of the clock gone by move 20', '%'],
      ['afterLossPaceRatio', 'think time right after losing material, vs normal', 'x'],
      ['beforeLossPaceRatio', 'think time on the move before losing material, vs normal', 'x']
    ];
    return rows.filter(([m]) => a[m] != null && b[m] != null).map(([m, label, unit]) => ({
      metric: m, label, before: a[m], after: b[m], unit, nBefore: before.length, nAfter: after.length,
      text: `${label}: ${a[m]}${unit} before the file, ${b[m]}${unit} in the ${after.length} games since`
    })).filter(r => (r.unit === '%' ? Math.abs(r.after - r.before) >= 10 : Math.abs(r.after - r.before) / Math.max(r.before, 0.01) >= 0.2));
  }

  // Lichess's own speed categories, from the estimated game duration.
  function speedOf(initialSecs, incrementSecs = 0) {
    if (initialSecs == null) return null;
    const est = initialSecs + 40 * (incrementSecs || 0);
    return est < 30 ? 'ultraBullet' : est < 180 ? 'bullet' : est < 480 ? 'blitz' : est < 1500 ? 'rapid' : 'classical';
  }

  // How many games a metric is actually measured on (null = not measured).
  const METRIC_SOURCE = {
    medianThinkSecs: g => g.medianThink, afterLossPaceRatio: g => g.afterLossPace,
    beforeLossPaceRatio: g => g.beforeLossPace,
    avgClockFractionLeftAtMove20: g => g.clockLeftAt20, avgMaterialLossEvents: g => g.materialLossEvents,
    avgMoveLeftBookBySelf: g => (g.leftBookBy === 'player' ? g.leftBookMove : null),
    pctNeverCastled: g => (g.plies >= 24 ? 1 : null),
    pctLossesResigned: g => (g.result === 'loss' ? 1 : null)
  };
  function metricCount(games, metric) {
    const f = METRIC_SOURCE[metric];
    return f ? games.filter(g => f(g) != null).length : games.length;
  }

  // Rapport grows with games observed; gates how much each character reveals.
  function rapportStage(gamesObserved) {
    return gamesObserved >= 12 ? 'trusted' : gamesObserved >= 5 ? 'acquainted' : 'stranger';
  }

  const api = {
    parseClock, materialFromFen, materialSeries, median, netLoss, paceOf, thinkTime, buildBook, bookState,
    evaluateTriggers, sessionStartTrigger, summarizeGame, debriefFacts, dossierFacts,
    historyCount, lossStreak, rapportStage, speedOf, metricCount, trend, gameFromLichess, aggregate, filterGames, outcome, plyLabel, isMine, PIECE_NAME, pieceOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HannibalAnalysis = api;
})(typeof self !== 'undefined' ? self : this);

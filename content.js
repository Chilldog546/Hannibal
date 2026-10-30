// content.js — runs on lichess.org.
// Records the player's behaviour (time per move, clock, material, opening),
// decides WHEN a character should speak (behavioural triggers, cooldowns),
// asks background.js WHAT they say, and shows it in a speech bubble beside
// the board. After the game: saves a summary to the dossier and shows a
// three-voice debrief.
//
// Depends on analysis.js (window.HannibalAnalysis), loaded first.
//
// SELECTORS: lichess rotates obfuscated tag names, so moves are read by
// content (SAN text) and material is computed by replaying them with
// chess.js. Named selectors used: cg-board/cg-container, .cg-wrap orientation, .rclock-top/.rclock-bottom,
// .ruser-top/.ruser-bottom, .game__meta, .result, .status, #user_tag.

const A = window.HannibalAnalysis;

const CHAR_UI = {
  general: { tag: 'THE GENERAL', color: '#5b2a4a', voice: { pitch: 0.75, rate: 0.92 } },
  vale: { tag: 'DR. VALE', color: '#2f4858', voice: { pitch: 1.0, rate: 0.88 } },
  ashby: { tag: 'ASHBY', color: '#3d5a3a', voice: { pitch: 1.05, rate: 0.95 } }
};
const LEAD_ORDER = ['ensemble', 'general', 'vale', 'ashby'];
const TRIGGER_PRIORITY = ['rush_after_loss', 'hesitation', 'time_burn', 'left_book'];
// Fixed lines for when the model's line is withheld or empty. Observations only.
const FALLBACK = {
  rush_after_loss: 'Material gone, and two quick replies after it. I noticed.',
  hesitation: 'A long pause on that one. I have written it down.',
  time_burn: 'The supplies are running low, and the march is young.',
  left_book: 'Off the known road now, by your own choice.'
};
const COOLDOWN_MOVES = 3;      // player moves between in-game remarks
const AMBIENT_EVERY = 10;      // player moves of quiet before an unprompted remark
const STALE_PLIES = 2;         // drop a reply if the game moved on this far
const MAX_DOSSIER = 120;

const settings = { mode: 'computer', voice: false, lead: 'ensemble' };
let book = null;
let dossier = { games: [] };
let game = null;          // see analysis.js for the shape
let ctx = null;           // page context: names, colour, computer, rated
let busy = false;
let lastRemarkMine = -99; // index in player's move count of last remark
let lastDebrief = null;

// ---------------------------------------------------------------- boot

let profile = null; // the onboarding agent's file, if built
chrome.storage.local.get(['mode', 'voice', 'lead', 'persona', 'dossier', 'profile'], s => {
  if (s.profile) profile = s.profile;
  if (s.mode) settings.mode = s.mode;
  settings.voice = !!s.voice;
  if (LEAD_ORDER.includes(s.lead)) settings.lead = s.lead;
  if (s.dossier?.games) dossier = s.dossier;
});
chrome.storage.onChanged.addListener(ch => {
  // Keep the in-memory file in sync (e.g. "Forget all games" in Options,
  // or another tab finishing a game).
  if (ch.dossier) dossier = ch.dossier.newValue || { games: [] };
  if (ch.profile) profile = ch.profile.newValue || null;
  if (ch.mode) settings.mode = ch.mode.newValue;
  if (ch.voice) settings.voice = !!ch.voice.newValue;
  if (ch.lead) settings.lead = ch.lead.newValue;
});

fetch(chrome.runtime.getURL('openings.json'))
  .then(r => r.json())
  .then(lines => { book = A.buildBook(lines); })
  .catch(e => console.debug('[hannibal] opening book failed to load', e));

let tries = 0;
// Only real game pages: /<8 chars> or /<12 chars>, optionally with a leading /game/ and a trailing /white or /black.
// Lichess's own 8-letter section names look like game ids, so they are listed.
const NOT_GAMES = new Set(['training', 'analysis', 'practice', 'tutorial', 'activity', 'timeline', 'insights', 'explorer']);
function onGamePage() {
  const m = location.pathname.match(/^\/(?:game\/)?([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:\/(?:white|black))?\/?$/);
  return !!m && !NOT_GAMES.has(m[1].toLowerCase());
}
const bootTimer = setInterval(() => {
  if (!onGamePage() || !document.querySelector('cg-board')) {
    if (++tries > 60) clearInterval(bootTimer); // not a game page
    return;
  }
  clearInterval(bootTimer);
  startGame();
  observe();
}, 500);

function startGame() {
  ctx = readContext();
  const moves = getMoves();
  game = {
    id: currentGameId(),
    playerColor: ctx.playerColor,
    playerName: ctx.playerName,
    opponentName: ctx.opponentName,
    vsComputer: ctx.vsComputer,
    rated: ctx.rated,
    initialClock: ctx.initialClock,
    speed: A.speedOf(ctx.initialClock, ctx.increment),
    plies: moves.map(san => ({ san, t: null, clockMine: null, clockOpp: null, matW: null, matB: null })),
    fired: {},
    result: readResult(),
    status: '',
    finalized: false
  };
  lastRemarkMine = -99;
  console.log('[hannibal] booted', { ...ctx, plies: moves.length, finished: !!game.result });

  // Watching someone else's game, or opening a finished one: stay out of it.
  if (ctx.spectator || game.result) {
    removeCoach();
    return;
  }
  injectCoach();

  if (game.plies.length < 2 && inGameAllowed()) {
    const t = A.sessionStartTrigger(dossier, new Date().getHours());
    if (t) { game.fired.session_start = true; requestRemark(t); }
  }
}

// ------------------------------------------------------------- context

function readContext() {
  const bottom = document.querySelector('.ruser-bottom');
  const top = document.querySelector('.ruser-top');
  const nameOf = el => el?.querySelector('a.user-link')?.textContent.trim().replace(/\s+/g, ' ') || null;
  const playerName = nameOf(bottom) || document.getElementById('user_tag')?.textContent.trim() || 'the player';
  const me = document.getElementById('user_tag')?.textContent.trim();
  // The bottom player's link shows name (and maybe title and rating); match
  // the name as a whole word. Logged out and watching a named player = spectator.
  const bottomName = nameOf(bottom);
  const tokens = (bottomName || '').toLowerCase().split(/\s+/);
  const spectator = !!bottomName && (!me || !tokens.includes(me.toLowerCase()));
  // Lichess's own AI is named "Stockfish ..." (in every language) and has no
  // profile link; bot accounts carry a BOT title. Anonymous humans have no
  // link either, so the name check matters.
  const vsComputer = !!top && (
    /\bBOT\b/.test(top.textContent) ||
    (!top.querySelector('a.user-link') && /stockfish/i.test(top.textContent)));
  const meta = document.querySelector('.game__meta')?.textContent || '';
  let rated = null;
  if (/casual|ej rankat|unrated|ungewertet|amical|amistos|non class|amichevole/i.test(meta)) rated = false;
  else if (/rated|rankat|gewertet|class[ée]|clasificad|puntuab|valutat/i.test(meta)) rated = true;
  const tc = meta.match(/(\d+)\s*\+\s*(\d+)/);
  return {
    playerColor: document.querySelector('.cg-wrap')?.classList.contains('orientation-black') ? 'black' : 'white',
    playerName,
    opponentName: (nameOf(top) || top?.textContent.trim() || 'the opponent').slice(0, 40),
    vsComputer,
    rated,
    spectator,
    initialClock: tc ? +tc[1] * 60 : null,
    increment: tc ? +tc[2] : 0
  };
}

function inGameAllowed() {
  if (!ctx || settings.mode === 'off') return false;
  if (settings.mode === 'always') return true;
  if (ctx.vsComputer) return true;
  return settings.mode === 'casual' && ctx.rated === false;
}

function currentGameId() {
  const parts = location.pathname.split('/').filter(Boolean);
  // While you play, Lichess adds a 4-character player suffix (12 characters);
  // the game id is the first 8, which is also what the API returns.
  const seg = parts.find(p => /^[A-Za-z0-9]{8}([A-Za-z0-9]{4})?$/.test(p));
  return seg ? seg.slice(0, 8) : parts.join('/') || 'unknown';
}

// --------------------------------------------------------- move watching

function observe() {
  let timer = null;
  new MutationObserver(mutations => {
    const outside = mutations.some(
      m => !(m.target.parentElement || m.target).closest?.('#ai-commentator')
    );
    if (!outside || timer) return;
    // Throttle, not debounce: the running clock mutates the page every
    // tenth of a second, which would starve a debounce forever.
    timer = setTimeout(() => { timer = null; sync(); }, 250);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(sync, 1500); // backup in case a change slips past the observer
}

function sync() {
  if (!game) return;
  if (currentGameId() !== game.id && document.querySelector('cg-board')) {
    startGame(); // lichess navigated to a new game without a reload
    return;
  }
  if (ctx.spectator || game.finalized) return;

  const moves = getMoves();
  // A takeback, possibly followed by a different move between two polls:
  // keep only the plies that still match the page.
  let common = 0;
  while (common < game.plies.length && common < moves.length && game.plies[common].san === moves[common]) common++;
  if (common < game.plies.length) game.plies.length = common;
  if (moves.length <= game.plies.length) {
    // nothing new
  } else if (moves.length > game.plies.length) {
    const now = Date.now();
    const clocks = readClocks();
    // The starting clock comes from the game's time control; only fall back
    // to the first clock reading if the page didn't show one.
    if (!game.initialClock && clocks.mine != null) game.initialClock = clocks.mine;
    const firstNew = game.plies.length;
    const added = moves.length - firstNew;
    for (let i = firstNew; i < moves.length; i++) {
      // Clocks don't run for the side that just moved, so the reading taken
      // now is still right for the newest ply of each side (a bot can reply
      // inside one polling window, and the player's ply must keep its clock).
      const newestOfSide = i >= moves.length - 2;
      const mine = A.isMine(game, i);
      game.plies.push({
        san: moves[i],
        // One or two new plies = we watched them happen (a bot can reply
        // within our polling window). More = page load / reconnect.
        t: added <= 2 ? now : null,
        clockMine: newestOfSide && mine ? clocks.mine : null,
        clockOpp: newestOfSide && !mine ? clocks.opp : null,
        matW: null,
        matB: null
      });
    }
    // Material for every ply, from the move list itself.
    A.materialSeries(game.plies.map(p => p.san), self.Chess).forEach((m, i) => {
      if (m) { game.plies[i].matW = m.w; game.plies[i].matB = m.b; }
    });
    for (let i = firstNew; i < moves.length; i++) onNewPly(i);
  }

  const result = readResult();
  if (result && !game.finalized) finalize(result);
}

function onNewPly(L) {
  if (!A.isMine(game, L)) return;
  // Evaluate as of ply L (shares game.fired, so patterns are recorded).
  const view = { ...game, plies: game.plies.slice(0, L + 1) };
  const triggers = A.evaluateTriggers(view, book);
  if (!inGameAllowed() || busy) return;

  const myCount = view.plies.filter((_, i) => A.isMine(game, i)).length;
  if (myCount - lastRemarkMine < COOLDOWN_MOVES) return;

  triggers.sort((a, b) => TRIGGER_PRIORITY.indexOf(a.type) - TRIGGER_PRIORITY.indexOf(b.type));
  let t = triggers[0];
  if (!t && myCount - Math.max(lastRemarkMine, 0) >= AMBIENT_EVERY && myCount >= 6) {
    t = ambientTrigger(L);
  }
  if (!t) return;
  lastRemarkMine = myCount;
  requestRemark(t);
}

function ambientTrigger(L) {
  const mine = game.plies.map((p, i) => ({ p, i })).filter(x => A.isMine(game, x.i));
  const thinks = mine.map(x => A.thinkTime(game, x.i)).filter(s => s != null);
  const facts = [`${mine.length} moves played so far.`];
  if (thinks.length >= 3) facts.push(`Average think so far: ${(thinks.reduce((a, b) => a + b, 0) / thinks.length).toFixed(1)}s.`);
  if (!mine.some(x => x.p.san.startsWith('O-O'))) facts.push('Has not castled yet.');
  if (mine.slice(0, 6).some(x => x.p.san.startsWith('Q'))) facts.push('Brought the queen out early.');
  const tail = mine.slice(-3).map(x => A.pieceOf(x.p.san));
  if (tail.length === 3 && tail[0] !== 'P' && tail.every(p => p === tail[0])) {
    facts.push(`The last three moves were all with the ${A.PIECE_NAME[tail[0]].toLowerCase()}.`);
  }
  return { type: 'ambient', owner: null, facts, why: `${mine.length} moves in, nothing unusual`, ply: L, label: A.plyLabel(game, L) };
}

// ------------------------------------------------------------- talking

// What the characters know: cross-game facts plus the agent's findings.
function fileFacts(prev) {
  const facts = A.dossierFacts(prev);
  if (profile?.findings?.length) {
    facts.push(...profile.findings.map(f => `From the file (${f.character}): ${f.title}. ${f.observation} (${f.evidence})`));
    A.trend(prev, profile.builtAt).forEach(t => facts.push(`Change since the file was opened: ${t.text}.`));
  }
  return facts;
}

// Trust grows with games watched live; reading their history earns a little.
function stageFor(prev) {
  const live = prev.filter(g => g.source !== 'import').length;
  const imported = prev.length - live;
  return A.rapportStage(live + Math.min(5, Math.floor(imported / 10)));
}


function speakerFor(trigger) {
  if (settings.lead !== 'ensemble') return settings.lead;
  if (trigger.owner) return trigger.owner;
  return ['general', 'vale', 'ashby'][Math.floor(Math.random() * 3)];
}

function requestRemark(trigger) {
  const character = speakerFor(trigger);
  const prev = dossier.games.filter(g => g.id !== game.id);
  const n = A.historyCount(prev, trigger.type);
  const requestedAt = game.plies.length;
  busy = true;
  thinking(character);
  chrome.runtime.sendMessage(
    {
      type: 'REMARK',
      character,
      trigger: trigger.type,
      label: trigger.label,
      facts: trigger.facts,
      historyNote: n ? `The same thing happened in ${n} of their earlier games.` : '',
      dossier: fileFacts(prev),
      stage: stageFor(prev),
      playerName: ctx.playerName
    },
    res => {
      busy = false;
      if (chrome.runtime.lastError) return say(character, chrome.runtime.lastError.message, { error: true });
      if (res?.error) return say(character, res.error, { error: true });
      let text = (res?.text || '').trim();
      console.log('[hannibal] remark', trigger.type, res?.withheld ? `withheld (${res.reason})` : '', text, res?.raw ? `raw: ${res.raw}` : '');
      // A real moment (not small talk) is never lost: if the model's line was
      // withheld or empty, the character says a fixed line and the note still
      // shows the numbers that caused it.
      if ((!text || text.startsWith('[SILENCE]')) && FALLBACK[trigger.type]) text = FALLBACK[trigger.type];
      if (!text || text.startsWith('[SILENCE]')) return clearThinking();
      if (game.plies.length - requestedAt > STALE_PLIES) {
        console.debug('[hannibal] dropped stale remark:', text);
        return clearThinking();
      }
      say(res.character || character, text, { label: trigger.label, why: trigger.why });
    }
  );
}

function finalize(result) {
  game.result = result;
  game.status = statusCode(document.querySelector('main .status')?.textContent || '');
  game.finalized = true;
  const watchedLive = game.plies.some(p => p.t != null);
  if (!watchedLive) return;

  const summary = A.summarizeGame(game, book);
  const prev = dossier.games.filter(g => g.id !== game.id);
  // Re-read before writing so two tabs can't overwrite each other's games.
  chrome.storage.local.get('dossier', ({ dossier: stored }) => {
    const games = (stored?.games || []).filter(g => g.id !== game.id);
    dossier = { ...(stored || {}), games: [...games, summary].slice(-MAX_DOSSIER) };
    chrome.storage.local.set({ dossier });
  });

  busy = true;
  debriefLoading();
  chrome.runtime.sendMessage(
    {
      type: 'DEBRIEF',
      facts: A.debriefFacts(summary),
      dossier: fileFacts(prev),
      stage: stageFor(prev),
      playerName: ctx.playerName
    },
    res => {
      busy = false;
      if (chrome.runtime.lastError) return say('vale', chrome.runtime.lastError.message, { error: true });
      if (res?.error) return say('vale', res.error, { error: true });
      lastDebrief = { lines: res.lines || [], summary };
      showDebrief(res.lines || [], summary);
    }
  );
}

// ------------------------------------------------------------- reading

const SAN = /^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#]?$/;

function getMoves() {
  const root = document.querySelector('main.round, main') || document.body;
  const out = [];
  root.querySelectorAll('*').forEach(el => {
    if (el.children.length) return;
    // Skip the board, our own UI, and chat (someone typing "e4" is not a move).
    if (el.closest('cg-board, #ai-commentator, .mchat, [class*="chat"]')) return;
    const t = el.textContent.trim();
    if (SAN.test(t)) out.push(t);
  });
  return out;
}

function readClocks() {
  const read = sel => A.parseClock(document.querySelector(`${sel} .time`)?.textContent ||
    document.querySelector(sel)?.textContent);
  return { mine: read('.rclock-bottom'), opp: read('.rclock-top') };
}

// The page shows the ending in the user's language; the file stores the
// same codes the Lichess API uses, so live and imported games compare.
function statusCode(text) {
  const t = text.toLowerCase();
  if (/resign|gav upp|aufgegeben|abandon|rinunci|abandonn/.test(t)) return 'resign';
  if (/left the game|lämnade spelet|verließ|a quitté|abandonó/.test(t)) return 'timeout';
  if (/time out|out of time|tiden|zeit|temps|tiempo|flag|tempo scaduto/.test(t)) return 'outoftime';
  if (/stalemate|\bpatt\b|\bpat\b|ahogado/.test(t)) return 'stalemate';
  if (/checkmate|schackmatt|schachmatt|échec et mat|jaque mate|scacco matto|\bmate\b|\bmatt\b/.test(t)) return 'mate';
  if (/draw|remi|remis|nulle|tablas|patta|repetition|insufficient|fifty|50.move|femtio|agreement/.test(t)) return 'draw';
  return text.trim().slice(0, 60);
}

function readResult() {
  const valid = /^(1-0|0-1|½-½|1\/2-1\/2)$/;
  const el = document.querySelector('main .result');
  const txt = el?.textContent.trim();
  if (txt && valid.test(txt)) return txt === '1/2-1/2' ? '½-½' : txt;
  return null;
}

// --------------------------------------------------------------- the UI
// A portrait medallion and a paper slip beside the board: the characters
// hand you a note from their file. Styles go through the CSSOM
// (el.style.cssText), which page CSP cannot block.

const P = window.HannibalPortraits;
const INK = '#1d1915', PAPERC = '#efe7d6', TYPED = '"Courier Prime","Courier New",Courier,monospace';
const SERIF = 'Georgia,"Iowan Old Style","Times New Roman",serif';
const ui = {};
let typeTimer = null, dotsTimer = null, dimTimer = null;
let placeBound = false;

function removeCoach() {
  document.getElementById('ai-commentator')?.remove();
  for (const k of Object.keys(ui)) delete ui[k];
}

function el(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}

function injectCoach() {
  if (document.getElementById('ai-commentator')) return;
  const root = el('div', 'position:fixed;z-index:2147483647;width:300px;display:flex;gap:12px;align-items:flex-start;' +
    `font:15px/1.45 ${SERIF};transition:top .2s,left .2s;`);
  root.id = 'ai-commentator';

  const figure = el('button', 'flex:none;width:60px;display:flex;flex-direction:column;align-items:center;gap:5px;' +
    'cursor:pointer;user-select:none;background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;');
  figure.type = 'button';
  figure.title = 'Choose who speaks during the game';
  const avatar = el('div', 'width:56px;height:56px;border-radius:50%;box-shadow:0 3px 10px rgba(0,0,0,.5);transition:transform .25s;');
  const lead = el('div', `font:italic 11px/1.2 ${SERIF};color:#bfb6a4;white-space:nowrap;text-align:center;`);
  figure.append(avatar, lead);
  figure.addEventListener('click', () => {
    settings.lead = LEAD_ORDER[(LEAD_ORDER.indexOf(settings.lead) + 1) % LEAD_ORDER.length];
    chrome.storage.local.set({ lead: settings.lead });
    paintLead();
  });

  const bubble = el('div', `position:relative;flex:1;background:${PAPERC};color:${INK};border-left:4px solid #555;` +
    'border-radius:2px;padding:10px 14px 11px;box-shadow:0 8px 22px rgba(0,0,0,.45),0 1px 0 rgba(255,255,255,.4) inset;' +
    'opacity:0;transform:translateY(4px);transition:opacity .45s,transform .45s;min-height:20px;');
  const tail = el('div', `position:absolute;left:-11px;top:20px;width:0;height:0;border:7px solid transparent;border-right-color:#555;`);
  const tag = el('div', `font:bold 12.5px/1.2 ${SERIF};margin-bottom:5px;`);
  const text = el('div', 'white-space:pre-wrap;');
  const meta = el('div', `font:11px/1.35 ${TYPED};color:#6e6555;margin-top:8px;padding-top:6px;border-top:1px dashed #c4b89f;`);
  const list = el('div');
  const scroller = el('div', 'overflow-y:auto;overscroll-behavior:contain;');
  scroller.append(tag, text, meta, list);
  bubble.append(tail, scroller);

  root.append(figure, bubble);
  document.body.appendChild(root);
  Object.assign(ui, { root, avatar, lead, bubble, tail, scroller, tag, text, meta, list });

  paintLead();
  place();
  // Lichess swaps games without reloading; bind the placement loop once.
  if (!placeBound) {
    placeBound = true;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    setInterval(place, 1000);
  }
}

function setAvatar(id) {
  if (!ui.avatar || ui.avatar.dataset.who === id) return;
  ui.avatar.dataset.who = id;
  ui.avatar.innerHTML = id === 'ensemble' ? P.ensemble(56) : P.portrait(id, 56);
}

function paintLead() {
  if (!ui.lead) return;
  ui.lead.textContent = settings.lead === 'ensemble' ? 'All three' : P.CAST[settings.lead].name;
  setAvatar(settings.lead);
}

function paintSpeaker(id) {
  const c = P.CAST[id] || P.CAST.vale;
  setAvatar(id);
  ui.lead.textContent = c.name;
  ui.tag.textContent = c.name;
  ui.tag.style.color = c.bg;
  ui.bubble.style.borderLeftColor = c.bg;
  ui.tail.style.borderRightColor = c.bg;
  ui.avatar.style.transform = 'scale(1.06)';
  setTimeout(() => { if (ui.avatar) ui.avatar.style.transform = ''; }, 300);
}

// Beside the board on the left if there's room (lichess leaves that column
// mostly empty under the game card), else under the board, else a corner.
function place() {
  if (!ui.root) return;
  const W = 300;
  const boardEl = document.querySelector('cg-container') || document.querySelector('cg-board');
  const r = boardEl?.getBoundingClientRect();
  let left, top;
  if (r && r.width && r.left >= W + 24) {
    left = r.left - W - 16;
    const metaBox = document.querySelector('.game__meta')?.getBoundingClientRect();
    const below = metaBox && metaBox.right <= r.left + 4 ? metaBox.bottom + 16 : r.top;
    top = Math.max(below, r.top + r.height * 0.3);
  } else if (r && r.width && innerHeight - r.bottom >= 110) {
    left = Math.max(8, r.left);
    top = r.bottom + 10;
  } else {
    left = 12;
    top = innerHeight - 170;
  }
  ui.root.style.left = Math.round(left) + 'px';
  ui.root.style.top = Math.round(top) + 'px';
  // Never run off the bottom of a small screen (the debrief is tall).
  ui.scroller.style.maxHeight = Math.max(100, innerHeight - top - 40) + 'px';
}

function showBubble() {
  clearTimeout(dimTimer);
  ui.bubble.style.opacity = '1';
  ui.bubble.style.transform = 'none';
}

function hideBubble() {
  if (!ui.bubble) return;
  ui.bubble.style.opacity = '0';
  ui.bubble.style.transform = 'translateY(4px)';
}

function dimLater() {
  clearTimeout(dimTimer);
  dimTimer = setTimeout(() => { if (ui.bubble) ui.bubble.style.opacity = '0.4'; }, 25000);
}

function thinking(id) {
  if (!ui.text) return;
  clearInterval(dotsTimer);
  // Don't cover a remark that's still fresh on screen.
  if (ui.bubble.style.opacity === '1' && !ui.text.dataset.thinking) return;
  paintSpeaker(id);
  ui.text.dataset.thinking = '1';
  ui.text.style.color = '#8a7f6c';
  ui.meta.style.display = 'none';
  ui.list.textContent = '';
  let n = 0;
  ui.text.textContent = 'writing';
  dotsTimer = setInterval(() => { ui.text.textContent = 'writing' + '.'.repeat((n++ % 3) + 1); }, 400);
  showBubble();
}

function clearThinking() {
  clearInterval(dotsTimer);
  if (ui.text?.dataset.thinking) {
    delete ui.text.dataset.thinking;
    ui.text.textContent = '';
    hideBubble();
  }
}

function say(id, text, { error = false, label = '', why = '' } = {}) {
  if (!ui.text) return;
  clearInterval(dotsTimer);
  clearInterval(typeTimer);
  delete ui.text.dataset.thinking;
  paintSpeaker(id);
  ui.list.textContent = '';
  ui.text.style.color = error ? '#8f2a22' : INK;
  // Why they spoke: the behaviour that triggered the remark, in numbers.
  const note = why || (label ? `after ${label}` : '');
  ui.meta.textContent = note ? `Noted: ${note}` : '';
  ui.meta.style.display = note ? '' : 'none';
  showBubble();
  if (error) { ui.text.textContent = text; return; }
  typeOut(ui.text, text, () => dimLater());
  speak(id, text);
}

function typeOut(target, text, done) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  clearInterval(typeTimer);
  if (reduce) { target.textContent = text; done && done(); return; }
  let i = 0;
  target.textContent = '';
  typeTimer = setInterval(() => {
    target.textContent = text.slice(0, ++i);
    if (ui.scroller) ui.scroller.scrollTop = ui.scroller.scrollHeight; // follow the newest line
    if (i >= text.length) { clearInterval(typeTimer); done && done(); }
  }, 20);
}

function debriefLoading() {
  if (!ui.text) return;
  clearInterval(dotsTimer);
  delete ui.text.dataset.thinking;
  setAvatar('ensemble');
  ui.lead.textContent = 'All three';
  ui.tag.textContent = 'After the game';
  ui.tag.style.color = INK;
  ui.bubble.style.borderLeftColor = INK;
  ui.tail.style.borderRightColor = INK;
  ui.text.style.color = '#8a7f6c';
  ui.text.textContent = 'They are reading the game into your file…';
  ui.meta.style.display = 'none';
  ui.list.textContent = '';
  showBubble();
}

function showDebrief(lines, summary) {
  if (!ui.text) return;
  ui.tag.textContent = 'After the game';
  ui.text.textContent = '';
  const bits = [];
  if (summary.opening) bits.push(summary.opening.replace(/ \([A-E]\d\d\)$/, ''));
  if (summary.avgThink != null) bits.push(`${summary.avgThink}s a move`);
  if (summary.longestThink) bits.push(`longest ${summary.longestThink.secs}s on ${summary.longestThink.move}`);
  ui.meta.textContent = bits.length ? `Filed: ${bits.join(', ')}` : '';
  ui.meta.style.display = bits.length ? '' : 'none';
  ui.list.textContent = '';
  showBubble();

  // Reveal one voice at a time, like a conversation.
  let k = 0;
  const next = () => {
    if (k >= lines.length) {
      const bar = el('div', 'display:flex;justify-content:flex-end;gap:14px;margin-top:10px;');
      const close = el('button', `font:12px ${SERIF};color:#6e6555;background:none;border:0;padding:2px 0;cursor:pointer;text-decoration:underline;`, 'Close');
      close.type = 'button';
      close.addEventListener('click', hideBubble);
      const save = el('button', `font:12px ${SERIF};color:#6e6555;background:none;border:0;padding:2px 0;cursor:pointer;text-decoration:underline;`, 'Save as image');
      save.type = 'button';
      save.addEventListener('click', () => saveCard(lines, summary).catch(e => console.warn('[hannibal] card failed', e)));
      bar.append(save, close);
      ui.list.appendChild(bar);
      return;
    }
    const { character, text } = lines[k++];
    const c = P.CAST[character] || P.CAST.vale;
    const row = el('div', 'display:flex;gap:9px;margin-top:10px;align-items:flex-start;');
    const face = el('div', 'flex:none;width:30px;height:30px;');
    face.innerHTML = P.portrait(character, 30);
    const col = el('div', 'flex:1;min-width:0;');
    const who = el('div', `font:bold 12px/1.2 ${SERIF};color:${c.bg};margin-bottom:2px;`, c.name);
    const body = el('div');
    col.append(who, body);
    row.append(face, col);
    ui.list.appendChild(row);
    setAvatar(character);
    speak(character, text);
    typeOut(body, text, () => setTimeout(next, 600));
  };
  next();
}

// The debrief as a 1080x1350 image, for keeping or sharing.
async function saveCard(lines, summary) {
  const W = 1080, H = 1350, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#1f2420'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#cdb37c'; x.fillRect(60, 70, W - 120, H - 130);
  x.fillStyle = PAPERC; x.fillRect(84, 94, W - 168, H - 178);
  const img = svg => new Promise((ok, bad) => {
    const i = new Image();
    i.onload = () => ok(i); i.onerror = bad;
    i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const wrap = (text, maxW) => {
    const out = []; let line = '';
    for (const w of text.split(/\s+/)) {
      const t = line ? line + ' ' + w : w;
      if (x.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
    }
    if (line) out.push(line);
    return out;
  };
  x.fillStyle = INK; x.font = '600 64px Georgia, serif'; x.fillText('After the game', 140, 210);
  x.font = '24px "Courier New", monospace'; x.fillStyle = '#6e6555';
  const bits = [summary.result ? `A ${summary.result}` : null, summary.opening?.replace(/ \([A-E]\d\d\)$/, ''), summary.avgThink != null ? `${summary.avgThink}s a move` : null].filter(Boolean);
  wrap(bits.join(', '), W - 280).slice(0, 2).forEach((l, i) => x.fillText(l, 140, 262 + i * 32));
  let y = 360;
  for (const { character, text } of lines.slice(0, 3)) {
    const cast = P.CAST[character] || P.CAST.vale;
    x.drawImage(await img(P.portrait(character, 120)), 140, y, 120, 120);
    x.fillStyle = cast.bg; x.font = 'bold 30px Georgia, serif'; x.fillText(cast.name, 290, y + 34);
    x.fillStyle = INK; x.font = '32px Georgia, serif';
    const ls = wrap(text, W - 440).slice(0, 6);
    ls.forEach((l, i) => x.fillText(l, 290, y + 82 + i * 44));
    y += Math.max(150, 82 + ls.length * 44) + 40;
  }
  x.strokeStyle = '#c9bb9e'; x.beginPath(); x.moveTo(140, H - 190); x.lineTo(W - 140, H - 190); x.stroke();
  x.fillStyle = '#a3312a'; x.font = '26px "Courier New", monospace';
  x.fillText('Hannibal: a coach for your mind, not your moves', 140, H - 140);
  x.fillStyle = '#6e6555'; x.font = '22px "Courier New", monospace';
  x.fillText('Written by NVIDIA Nemotron on Nebius', 140, H - 106);
  const a = document.createElement('a');
  a.download = `hannibal-debrief-${game?.id || 'game'}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
  return a.href;
}

function speak(id, text) {
  if (!settings.voice || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = CHAR_UI[id]?.voice || {};
    u.pitch = v.pitch ?? 1;
    u.rate = v.rate ?? 1;
    u.lang = 'en-GB';
    speechSynthesis.speak(u);
  } catch (e) {
    console.debug('[hannibal] voice failed', e);
  }
}

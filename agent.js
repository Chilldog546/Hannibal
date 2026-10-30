// agent.js — the onboarding agent (runs in the service worker).
//
// 1. Fetches the player's recent games from the public Lichess API, with the
//    clock reading after every move.
// 2. Turns each into a behaviour summary with the same code the live tracker
//    uses (analysis.js): think times, pace after losing material, freezes,
//    clock use, castling, openings, how games end.
// 3. Lets Nemotron investigate those summaries with tools (overview,
//    filtered stats, group comparisons, game lists) and write the first file:
//    3-5 behavioural findings, each assigned to the character it belongs to.
// 4. Asks the three characters for their first impressions of the file.
//
// Native OpenAI-style tool calls are used when the model supports them; if
// the API rejects them, the agent falls back to a JSON-in-text protocol that
// works with any chat model.
//
// Relies on globals from background.js (callApi, settingsForTier,
// stripThinking, parseDebrief, CHARACTERS) and analysis.js (A).

const AGENT_MAX_STEPS = 14;
const MAX_REVISIONS = 2;
const MAX_IMPORT = 60;

const FILTER_PROPS = {
  result: { type: 'string', enum: ['win', 'loss', 'draw'] },
  color: { type: 'string', enum: ['white', 'black'] },
  speed: { type: 'string', enum: ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'] },
  vsComputer: { type: 'boolean' }
};

const METRICS = [
  'medianThinkSecs', 'afterLossPaceRatio', 'beforeLossPaceRatio', 'pctGamesRushedAfterLoss', 'pctGamesWithFreeze', 'pctGamesClockBurnedEarly',
  'avgClockFractionLeftAtMove20', 'pctNeverCastled', 'pctQueenOutEarly', 'avgMoveLeftBookBySelf', 'avgMaterialLossEvents',
  'pctLossesResigned', 'pctGamesLostOnTime'
];

const TOOLS = [
  {
    name: 'get_overview',
    description: 'Record, pace and habit statistics over all imported games, plus how many games exist per speed and per colour.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_stats',
    description: 'The same statistics for a filtered subset of games (any combination of result, colour, speed, vsComputer).',
    parameters: { type: 'object', properties: { ...FILTER_PROPS } }
  },
  {
    name: 'compare',
    description: 'Statistics side by side for groups of games, split by result, colour or speed. Use it to see what is different in the games the player loses.',
    parameters: { type: 'object', properties: { by: { type: 'string', enum: ['result', 'color', 'speed'] } }, required: ['by'] }
  },
  {
    name: 'list_games',
    description: 'Individual games matching a filter, newest last, with their notable moments: longest think, median think, pace after losing material, which behaviour triggers fired, how the game ended.',
    parameters: { type: 'object', properties: { ...FILTER_PROPS, limit: { type: 'integer', minimum: 1, maximum: 15 } } }
  },
  {
    name: 'finish',
    description: 'Submit the file. 3 to 5 findings. Every finding names the metric and the games it is about, so the verifier can recompute it from the data: unverifiable or insignificant findings are sent back.',
    parameters: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              character: { type: 'string', enum: ['general', 'vale', 'ashby'] },
              kind: { type: 'string', enum: ['contrast', 'trait', 'moment'], description: 'contrast = the filtered games differ from all other games; trait = a steady habit across the filtered games (or all games); moment = one specific game.' },
              direction: { type: 'string', enum: ['higher', 'lower'], description: 'For contrast: is the metric higher or lower in the filtered group than in the other games? The verifier rejects a finding whose text says the opposite.' },
              metric: { type: 'string', enum: METRICS, description: 'For contrast and trait: the statistic the finding is about.' },
              filter: { type: 'object', properties: { ...FILTER_PROPS }, description: 'For contrast: the group compared with every other game. For trait: optional subset.' },
              gameId: { type: 'string', description: 'For moment: the game id from list_games.' },
              title: { type: 'string', description: 'A few words.' },
              observation: { type: 'string', description: 'One or two plain sentences describing the behaviour. Never an instruction.' }
            },
            required: ['character', 'kind', 'title', 'observation']
          }
        }
      },
      required: ['findings']
    }
  }
];

function agentSystem(username, n, textMode) {
  let sys = `You are the analyst who prepares the first file on a chess player, ${username}, for three characters who coach the player's mind, never their moves:
- general: command of the game: clock use, the opening, finishing what they start.
- vale: the mind: hesitation, haste, predictability, repeated patterns.
- ashby: the person: streaks, tilt, how they handle losses.

You have tools over ${n} of their recent Lichess games, already reduced to behaviour statistics. Work like a scientist: start broad (get_overview), compare groups (for example by result) to find what is different when they lose, then check a hypothesis on individual games. Make 3 to 6 tool calls, then call finish.

Field notes: medianThinkSecs = typical seconds per move. afterLossPaceRatio = their think time right after losing material divided by their normal think time (0.5 = twice as fast as usual, above 1 = slower). beforeLossPaceRatio = their think on the move right BEFORE they lost material, divided by their normal think (low = the material went right after a hurried move; this is the most useful signal for a beginner). pct* fields are percentages of games. avgClockFractionLeftAtMove20 = share of the starting clock left at move 20. howLossesEnded counts how lost games ended (resign, mate, outoftime, ...). Correspondence games have no move times.

Rules:
- Behaviour only. Never judge the quality of moves or positions; never suggest moves, plans or openings.
- Every finding is checked by a verifier that recomputes it from the data. Name the metric and filter exactly, and for a contrast say whether the metric is higher or lower in the group (direction); the verifier writes the evidence numbers itself.
- contrast: the filtered group must differ clearly from the OTHER games (of the same speed, if you filter by speed): at least 25% relative, or 15 percentage points for pct metrics, at least 3 games on each side, and a permutation test p of 0.05 or less. If the group looks like the rest, it is not a finding.
- Any number you write in a title or observation must match the verifier's evidence. When unsure, describe without numbers; the evidence line carries them.
- trait: a steady habit over at least 5 games (no comparison). Use it when something is true of the player everywhere.
- moment: one game that stands out (give gameId from list_games).
- medianThinkSecs is in absolute seconds and only comparable within one speed: filter by speed when using it.
- Prefer specific, surprising findings over generic ones ("loses by mate" is generic).
- Observations describe the player; they never instruct ("keep your king safe" is advice; "castled in 1 of 5 losses" is an observation).
- Give each finding to the character whose concern it is; use each character at least once if the data allows.
- 3 to 5 findings. Plain, precise language: the characters will voice it later.`;
  if (textMode) {
    sys += `

TOOL PROTOCOL: you cannot call functions directly. To use a tool, reply with exactly one JSON object and nothing else:
{"tool": "<name>", "args": { ... }}
Tools:
${TOOLS.map(t => `- ${t.name}: ${t.description} Args: ${JSON.stringify(t.parameters.properties)}`).join('\n')}`;
  }
  return sys;
}

// ------------------------------------------------------------- tools

function countBy(games, key) {
  return games.reduce((m, g) => { const k = g[key] ?? 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});
}

function runTool(name, args, games) {
  args = args || {};
  switch (name) {
    case 'get_overview': {
      const dates = games.map(g => g.date).filter(Boolean).sort();
      return {
        ...A.aggregate(games),
        bySpeed: countBy(games, 'speed'),
        thinkBaselineBySpeed: Object.fromEntries(Object.keys(countBy(games, 'speed')).map(sp => {
          const sub = games.filter(g => g.speed === sp);
          return [sp, { games: sub.length, medianThinkSecs: A.aggregate(sub).medianThinkSecs }];
        })),
        byColor: countBy(games, 'color'),
        vsComputer: games.filter(g => g.vsComputer).length,
        gamesWithMoveTimes: games.filter(g => g.medianThink != null).length,
        from: dates[0] ? new Date(dates[0]).toISOString().slice(0, 10) : null,
        to: dates.length ? new Date(dates[dates.length - 1]).toISOString().slice(0, 10) : null
      };
    }
    case 'get_stats':
      return A.aggregate(A.filterGames(games, args));
    case 'compare': {
      const key = args.by === 'color' ? 'color' : args.by === 'speed' ? 'speed' : 'result';
      const groups = {};
      games.forEach(g => { const k = g[key] ?? 'unknown'; (groups[k] = groups[k] || []).push(g); });
      return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, A.aggregate(v)]));
    }
    case 'list_games':
      return A.filterGames(games, args).slice(-(args.limit || 8)).map(g => ({
        id: g.id, result: g.result, ended: g.status, speed: g.speed, color: g.color,
        opponent: g.vsComputer ? 'computer' : 'human', opening: g.opening,
        moves: Math.ceil(g.plies / 2), medianThink: g.medianThink, longestThink: g.longestThink,
        afterLossPace: g.afterLossPace, beforeLossPace: g.beforeLossPace, beforeLoss: g.beforeLoss, castledMove: g.castledMove, triggers: g.triggers
      }));
    default:
      return { error: `Unknown tool "${name}".` };
  }
}

function brief(result) {
  if (Array.isArray(result)) return `${result.length} games`;
  if (result && typeof result.games === 'number') return `${result.games} games`;
  if (result && typeof result === 'object') return Object.keys(result).join(', ');
  return '';
}

// First balanced {...} in a text reply → {name, args}.
function parseToolJson(text) {
  if (!text) return null;
  text = String(text).replace(/```(?:json)?/gi, '');
  // Try every "{" (the model may talk first), and bare findings arrays.
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          let o = JSON.parse(text.slice(start, i + 1));
          if (o.tool_call) o = o.tool_call;
          if (o.function && typeof o.function === 'object') o = { tool: o.function.name, args: o.function.arguments };
          const name = o.tool || o.name;
          if (typeof name === 'string' && TOOLS.some(t => t.name === name)) {
            let args = o.args || o.arguments || o.parameters || {};
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
            return { name, args };
          }
          if (Array.isArray(o.findings)) return { name: 'finish', args: o };
        } catch { /* not JSON, try the next brace */ }
        break;
      }
    }
  }
  const arr = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arr) { try { const f = JSON.parse(arr[0]); if (Array.isArray(f) && f[0]?.observation) return { name: 'finish', args: { findings: f } }; } catch { /* no */ } }
  return null;
}

function sanitizeFindings(list) {
  const ok = ['general', 'vale', 'ashby'];
  return (Array.isArray(list) ? list : [])
    .filter(f => f && ok.includes(f.character) && f.observation)
    .slice(0, 6)
    .map(f => ({
      character: f.character,
      kind: ['contrast', 'trait', 'moment'].includes(f.kind) ? f.kind : 'trait',
      metric: METRICS.includes(f.metric) ? f.metric : null,
      filter: f.filter && typeof f.filter === 'object' ? pickFilter(f.filter) : {},
      direction: f.direction === 'higher' || f.direction === 'lower' ? f.direction : null,
      gameId: f.gameId ? String(f.gameId).slice(0, 20) : null,
      title: String(f.title || '').slice(0, 80),
      observation: String(f.observation).slice(0, 400)
    }));
}

function pickFilter(f) {
  const out = {};
  for (const k of Object.keys(FILTER_PROPS)) if (f[k] != null && f[k] !== '') out[k] = f[k];
  return out;
}

const isPct = m => /^pct/.test(m);
function fmt(m, v) {
  if (v == null) return 'n/a';
  if (isPct(m)) return `${Math.round(v)}%`;
  if (m === 'medianThinkSecs') return `${+v.toFixed(1)}s`;
  if (m === 'afterLossPaceRatio' || m === 'beforeLossPaceRatio') return `${+v.toFixed(2)}x`;
  if (m === 'avgClockFractionLeftAtMove20') return `${Math.round(v * 100)}% of the clock`;
  if (m === 'avgMoveLeftBookBySelf') return `around move ${Math.round(v)}`;
  return String(+v.toFixed(1));
}
const METRIC_LABEL = {
  medianThinkSecs: 'median think per move', afterLossPaceRatio: 'think time right after losing material, vs their normal',
  beforeLossPaceRatio: 'think time on the move right before losing material, vs their normal',
  pctGamesRushedAfterLoss: 'games with a rush after losing material', pctGamesWithFreeze: 'games with a long freeze',
  pctGamesClockBurnedEarly: 'games with most of the clock gone by move 20', avgClockFractionLeftAtMove20: 'clock left at move 20',
  pctNeverCastled: 'long games without castling', pctQueenOutEarly: 'games with the queen out in the first 6 moves',
  avgMoveLeftBookBySelf: 'move where they leave opening theory', avgMaterialLossEvents: 'material losses per game',
  pctLossesResigned: 'losses ended by resigning', pctGamesLostOnTime: 'games lost on time'
};
// The metric as one number per game (null = not measured in that game).
// Percentages are per-game 0/1 values, so means become shares.
const PER_GAME = {
  medianThinkSecs: g => g.medianThink, afterLossPaceRatio: g => g.afterLossPace, beforeLossPaceRatio: g => g.beforeLossPace,
  pctGamesRushedAfterLoss: g => (g.triggers || []).includes('rush_after_loss') ? 1 : 0,
  pctGamesWithFreeze: g => (g.triggers || []).includes('hesitation') ? 1 : 0,
  pctGamesClockBurnedEarly: g => (g.triggers || []).includes('time_burn') ? 1 : 0,
  avgClockFractionLeftAtMove20: g => g.clockLeftAt20,
  pctNeverCastled: g => (g.plies >= 24 ? (g.castledMove == null ? 1 : 0) : null),
  pctQueenOutEarly: g => (g.queenOutEarly ? 1 : 0),
  avgMoveLeftBookBySelf: g => (g.leftBookBy === 'player' ? g.leftBookMove : null),
  avgMaterialLossEvents: g => g.materialLossEvents,
  pctLossesResigned: g => (g.result === 'loss' ? (g.status === 'resign' ? 1 : 0) : null),
  pctGamesLostOnTime: g => (g.result === 'loss' && g.status === 'outoftime' ? 1 : 0)
};
const values = (games, m) => games.map(PER_GAME[m]).filter(v => v != null && !Number.isNaN(v));
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const shown = (m, v) => (isPct(m) ? v * 100 : v);

// Two-sided permutation test on the difference of means. Seeded, so the
// same data always gives the same p.
function permutationP(xa, xb, rounds = 2000) {
  const all = xa.concat(xb), nA = xa.length, obs = Math.abs(mean(xa) - mean(xb));
  let seed = 1234567, hits = 0;
  // mulberry32: exact 32-bit arithmetic, deterministic.
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let r = 0; r < rounds; r++) {
    for (let i = all.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [all[i], all[k]] = [all[k], all[i]]; }
    if (Math.abs(mean(all.slice(0, nA)) - mean(all.slice(nA))) >= obs - 1e-12) hits++;
  }
  return (hits + 1) / (rounds + 1);
}

function groupName(f) {
  const bits = [];
  if (f.result) bits.push(f.result === 'loss' ? 'losses' : f.result === 'win' ? 'wins' : 'draws');
  if (f.speed) bits.push(f.speed);
  if (f.color) bits.push(`as ${f.color}`);
  if (f.vsComputer != null) bits.push(f.vsComputer ? 'vs computer' : 'vs humans');
  return bits.join(', ') || 'all games';
}

// Every number the model writes must be one the data supports.
function numbersOk(text, evidence) {
  if (typeof unsupportedNumbers !== 'function') return [];
  return unsupportedNumbers(text, evidence);
}

// Which way does a finding say the group differs? Uses the explicit
// `direction` field ('higher' | 'lower') when given, otherwise unambiguous
// words about think time. Returns null when it cannot tell.
function directionClaim(metric, text, direction) {
  if (direction === 'higher' || direction === 'lower') return direction;
  if (!/Pace|medianThink/.test(metric)) return null;
  const t = String(text).toLowerCase();
  const slow = /\b(slower|longer|more time|more slowly|freez|hesitat|deliberat)/.test(t);
  const fast = /\b(faster|quicker|shorter|less time|more quickly|rush|hurr|haste|snap)/.test(t);
  if (slow === fast) return null;
  return slow ? 'higher' : 'lower';
}

// Recompute a finding from the data. Returns { ok, evidence } or { ok:false, reason }.
function verifyFinding(f, games) {
  const advice = typeof ruleCheck === 'function' ? ruleCheck(f.observation) : [];
  if (advice.length) return { ok: false, reason: `the observation ${advice.join('; ')}` };
  const withNumbers = res => {
    if (!res.ok) return res;
    const bad = numbersOk(f.observation + ' ' + f.title, res.evidence);
    return bad.length ? { ok: false, reason: `the text states ${bad.join(', ')}, which the data does not show (it shows: ${res.evidence})` } : res;
  };
  if (f.kind === 'moment') {
    const g = games.find(x => x.id === f.gameId);
    if (!g) return { ok: false, reason: `no game with id "${f.gameId}" (use an id from list_games)` };
    const bits = [`game ${g.id}: ${g.result || 'unfinished'}, ${g.speed || 'unknown speed'}, ${Math.ceil(g.plies / 2)} moves`];
    if (g.longestThink) bits.push(`longest think ${g.longestThink.secs}s on ${g.longestThink.move}`);
    if (g.medianThink != null) bits.push(`median ${g.medianThink}s`);
    if (g.afterLossPace != null) bits.push(`${g.afterLossPace}x usual pace after losing material`);
    if (g.beforeLoss?.length) bits.push(`move before losing material: ${g.beforeLoss.map(b => `${b.secs}s on ${b.move}`).join(', ')}`);
    if (g.status) bits.push(`ended by ${g.status}`);
    return withNumbers({ ok: true, evidence: bits.join(', ') });
  }
  if (!f.metric) return { ok: false, reason: 'no metric named (pick one from the list)' };
  const m = f.metric;
  const speeds = gs => new Set(gs.filter(g => PER_GAME[m](g) != null).map(g => g.speed)).size;
  const group = A.filterGames(games, f.filter);
  const xa = values(group, m);

  // A "trait" that filters by outcome, colour or opponent is a claim about a
  // group, so it must pass the same comparison as a contrast.
  const groupFilter = ['result', 'color', 'vsComputer'].some(k => f.filter[k] != null);
  if (f.kind === 'trait' && groupFilter) f = { ...f, kind: 'contrast' };
  if (f.kind === 'trait') {
    if (m === 'medianThinkSecs' && speeds(group) > 1) return { ok: false, reason: 'medianThinkSecs mixes speeds here; add a speed filter' };
    if (xa.length < 5) return { ok: false, reason: `${METRIC_LABEL[m]} is measured on only ${xa.length} game(s); a trait needs 5` };
    return withNumbers({ ok: true, evidence: `${METRIC_LABEL[m]}: ${fmt(m, shown(m, mean(xa)))} over ${xa.length} games (${groupName(f.filter)})` });
  }

  // contrast: the group against the other games of the same speed (when a
  // speed is named), so seconds are never compared across time controls.
  if (!Object.keys(f.filter).length) return { ok: false, reason: 'a contrast needs a filter (the group to compare)' };
  if (m === 'medianThinkSecs' && Object.keys(f.filter).length === 1 && f.filter.speed) {
    return { ok: false, reason: 'think seconds always differ between speeds; compare within one speed instead' };
  }
  // Filtering by speed plus something else compares within that speed. Filtering
  // by speed alone compares it with the other speeds (never for think seconds).
  const sameSpeed = f.filter.speed && Object.keys(f.filter).length > 1;
  const pool = sameSpeed ? games.filter(g => g.speed === f.filter.speed) : games;
  const ids = new Set(group.map(g => g.id));
  const rest = pool.filter(g => !ids.has(g.id));
  if (m === 'medianThinkSecs' && speeds(group.concat(rest)) > 1) {
    return { ok: false, reason: 'medianThinkSecs mixes speeds here; add a speed filter' };
  }
  const xb = values(rest, m);
  const restName = sameSpeed ? `other ${f.filter.speed} games` : 'other games';
  if (xa.length < 3 || xb.length < 3) {
    return { ok: false, reason: `not enough games to compare (${xa.length} in the group, ${xb.length} in ${restName}; need 3 each)` };
  }
  const a = shown(m, mean(xa)), b = shown(m, mean(xb));
  const diff = isPct(m) ? Math.abs(a - b) : Math.abs(a - b) / Math.max(Math.abs(b), 1e-6);
  const delta = isPct(m) ? `${Math.round(diff)} points` : `${Math.round(diff * 100)}%`;
  if (isPct(m) ? diff < 15 : diff < 0.25) {
    return { ok: false, reason: `${groupName(f.filter)} ${fmt(m, a)} vs ${restName} ${fmt(m, b)}: only ${delta} apart, not a real difference` };
  }
  // The text must not claim the opposite of what the data shows.
  const claim = directionClaim(m, `${f.title || ''} ${f.observation || ''}`, f.direction);
  if (claim && claim !== (a > b ? 'higher' : 'lower')) {
    return { ok: false, reason: `the text says the group is ${claim === 'higher' ? (m.includes('Pace') || m === 'medianThinkSecs' ? 'slower' : 'higher') : (m.includes('Pace') || m === 'medianThinkSecs' ? 'faster' : 'lower')} on ${METRIC_LABEL[m]}, but the data shows ${fmt(m, a)} in ${groupName(f.filter)} vs ${fmt(m, b)} in ${restName}` };
  }
  const p = permutationP(xa, xb);
  if (p > 0.05) {
    return { ok: false, reason: `${groupName(f.filter)} ${fmt(m, a)} vs ${restName} ${fmt(m, b)} could easily be chance with ${xa.length} and ${xb.length} games (permutation test p = ${p.toFixed(2)})` };
  }
  const small = Math.min(xa.length, xb.length) < 5 ? ', small sample' : '';
  return withNumbers({ ok: true, evidence: `${METRIC_LABEL[m]}: ${fmt(m, a)} in ${groupName(f.filter)} vs ${fmt(m, b)} in ${restName} (${xa.length} vs ${xb.length} games, p = ${p.toFixed(2)}${small})` });
}

// Keep tool results under the context budget without cutting JSON in half.
function compact(result, limit = 6000) {
  let s = JSON.stringify(result);
  if (s.length <= limit) return s;
  if (Array.isArray(result)) {
    let n = result.length;
    while (n > 1 && s.length > limit) s = JSON.stringify({ games: result.slice(-(--n)), note: `showing the newest ${n} of ${result.length}` });
    return s;
  }
  const slim = JSON.parse(s);
  const strip = o => { if (o && typeof o === 'object') { delete o.topOpenings; delete o.howLossesEnded; Object.values(o).forEach(strip); } };
  strip(slim);
  s = JSON.stringify(slim);
  return s.length <= limit ? s : JSON.stringify({ error: 'Result too large. Use a narrower filter.' });
}

// ------------------------------------------------------------- the loop

async function runAgent(username, games, progress) {
  const conf = await settingsForTier('deep');
  if (!conf.key) return { error: 'No Nebius API key set.' };
  const steps = [];
  let mode = 'tools';
  let revisions = 0, rejectedTotal = 0;
  let messages = [
    { role: 'system', content: agentSystem(username, games.length, false) },
    { role: 'user', content: 'Begin.' }
  ];
  const toText = () => {
    mode = 'text';
    messages = [
      { role: 'system', content: agentSystem(username, games.length, true) },
      { role: 'user', content: 'Begin. Reply with one JSON tool call.' }
    ];
    progress({ kind: 'info', text: 'This model does not accept native tool calls here; switching to the JSON tool protocol.' });
  };

  for (let i = 0; i < AGENT_MAX_STEPS; i++) {
    const last = i === AGENT_MAX_STEPS - 1;
    const body = { model: conf.model, max_tokens: 6000, temperature: 0.3, messages };
    // Tool choice does not need long hidden reasoning; it is what ran the model out of tokens.
    if (typeof thinkingOff === 'function') thinkingOff(body, conf.model, conf.noThinkUnsupported);
    if (mode === 'tools') {
      body.tools = TOOLS.map(t => ({ type: 'function', function: t }));
      body.tool_choice = last ? { type: 'function', function: { name: 'finish' } } : 'auto';
    } else if (last) {
      messages.push({ role: 'user', content: 'Step limit reached. Reply now with the finish call as JSON.' });
    }

    const t0 = Date.now();
    const r = await callApi(body, conf.key);
    if (!r.ok) {
      if (mode === 'tools' && unsupportedParam(r, /tool|function/i)) { toText(); i = -1; continue; }
      if (!conf.noThinkUnsupported && /chat_template|enable_thinking|template_kwargs/i.test(JSON.stringify(r.data || ''))) { conf.noThinkUnsupported = true; i--; continue; }
      return { error: apiError(r) };
    }
    if (typeof recordLatency === 'function') recordLatency('deep', Date.now() - t0, conf.model);
    const m = r.data.choices?.[0]?.message || {};
    // Some servers put the answer in reasoning_content when content is empty.
    if (!m.content && m.reasoning_content) m.content = m.reasoning_content;
    let call = null;

    if (mode === 'tools' && m.tool_calls?.length) {
      const tc = m.tool_calls[0];
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* keep {} */ }
      call = { name: tc.function?.name, args, id: tc.id };
      messages.push({ role: 'assistant', content: m.content || '', tool_calls: [tc] });
    } else {
      const parsed = parseToolJson(stripThinking(m.content));
      messages.push({ role: 'assistant', content: m.content || '' });
      if (parsed) {
        call = parsed;
      } else {
        steps.push({ tool: '(answered without a tool call)' });
        const seen = stripThinking(m.content).replace(/\s+/g, ' ').slice(0, 160) || `(empty, finish_reason ${r.data.choices?.[0]?.finish_reason || '?'})`;
        progress({ kind: 'info', text: `The model answered without a tool call: ${seen}` });
        messages.push({ role: 'user', content: mode === 'tools' ? 'Call one of the tools now, or finish.' : 'Reply with exactly one JSON tool call.' });
        continue;
      }
    }

    if (call.name === 'finish') {
      const findings = sanitizeFindings(call.args.findings);
      const checked = findings.map(f => ({ f, v: verifyFinding(f, games) }));
      const passed = checked.filter(x => x.v.ok).map(x => ({ ...x.f, evidence: x.v.evidence, verified: true }));
      checked.forEach((x, k) => progress({
        kind: 'verify', ok: x.v.ok, text: `${x.v.ok ? '✓' : '✗'} ${x.f.title || 'finding ' + (k + 1)}: ${x.v.ok ? x.v.evidence : x.v.reason}`
      }));
      steps.push({ tool: 'finish', args: { submitted: findings.length, verified: passed.length } });
      const rejected = checked.filter(x => !x.v.ok);
      rejectedTotal += rejected.length;
      const canRevise = revisions < MAX_REVISIONS && !last;
      if (passed.length && (!rejected.length || !canRevise || passed.length >= 4)) {
        return { findings: passed, steps, mode, model: conf.model, revisions, rejectedTotal };
      }
      if (!canRevise) {
        return passed.length
          ? { findings: passed, steps, mode, model: conf.model, revisions, rejectedTotal }
          : { error: 'No finding survived verification. With a short game history that can be the honest answer: play a few more timed games and read again.' };
      }
      revisions++;
      const report = 'VERIFIER REPORT\n' + checked.map((x, k) => `${k + 1}. ${x.f.title}: ${x.v.ok ? 'ACCEPTED (' + x.v.evidence + ')' : 'REJECTED, ' + x.v.reason}`).join('\n') +
        '\nInvestigate further if you need to, then call finish again with the complete list: keep the accepted findings, replace or drop the rejected ones.';
      progress({ kind: 'info', text: `Sent ${rejected.length} finding(s) back to the analyst.` });
      if (call.id) messages.push({ role: 'tool', tool_call_id: call.id, content: report });
      else messages.push({ role: 'user', content: report + '\nReply with one JSON tool call.' });
      continue;
    }

    progress({ kind: 'tool', name: call.name, args: call.args });
    const result = runTool(call.name, call.args, games);
    steps.push({ tool: call.name, args: call.args, result: brief(result) });
    const content = compact(result);
    if (call.id) messages.push({ role: 'tool', tool_call_id: call.id, content });
    else messages.push({ role: 'user', content: `RESULT of ${call.name}: ${content}\nNext: one JSON tool call, or finish.` });
  }
  // Last resort: one plain request for the findings, from what it has seen so far.
  messages.push({ role: 'user', content: 'Stop investigating. Reply now with ONLY this JSON: {"tool":"finish","args":{"findings":[...]}} using what you have found.' });
  const lastTry = await callApi({ model: conf.model, max_tokens: 6000, temperature: 0.2, messages: messages.filter(x => x.role !== 'tool' && !x.tool_calls).concat([]) }, conf.key);
  if (lastTry.ok) {
    const parsed = parseToolJson(stripThinking(lastTry.data.choices?.[0]?.message?.content || ''));
    if (parsed?.name === 'finish') {
      const passed = sanitizeFindings(parsed.args.findings).map(f => ({ f, v: verifyFinding(f, games) })).filter(x => x.v.ok).map(x => ({ ...x.f, evidence: x.v.evidence, verified: true }));
      if (passed.length) return { findings: passed, steps, mode, model: conf.model, revisions, rejectedTotal };
    }
  }
  return { error: 'The agent did not finish within its step limit. Try again, or pick another model for debriefs.' };
}

async function firstImpressions(username, findings) {
  const who = ['general', 'vale', 'ashby'];
  const system =
    `Three characters have just read the first file on ${username}, a chess player they will be watching from now on. ` +
    `Each gives a first impression in their own voice, one or two sentences, about the finding that belongs to them. ` +
    `They have only just met the player.\n\n` +
    `VOICE IS EVERYTHING. The three must be unmistakably different people: the General speaks in short, weighty, martial sentences with a ` +
    `historical image; Vale is cool, exact and clinical, a diagnosis delivered quietly; Ashby is warm, old-fashioned and domestic, an image from the house. ` +
    `Each line must contain one concrete figure from the file AND one image or turn of phrase only that character would use. ` +
    `Never give advice or instructions ("keep", "try", "should"); observe and let the player feel it. No generic coaching language ("reveals uncertainty", "speaks to your").\n\n` +
    who.map(id => `=== ${CHARACTERS[id].name.toUpperCase()} ===\n${CHARACTERS[id].bible}\n${voiceBlock(CHARACTERS[id])}`).join('\n\n') +
    `\n\nRULES: behaviour only, never moves or positions. Use only the file. Output exactly three lines:\nGENERAL: ...\nVALE: ...\nASHBY: ...`;
  const user = 'THE FILE:\n' + findings.map(f => `- [${f.character}] ${f.title}: ${f.observation} (${f.evidence})`).join('\n');
  const r = await voiceLines(system, user, 'empty');
  return r.error ? [] : r.lines;
}

// ------------------------------------------------------------- entry

async function handleOnboard(msg) {
  const username = String(msg.username || '').trim();
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) return { error: 'That does not look like a Lichess username.' };
  const progress = step => { chrome.runtime.sendMessage({ type: 'ONBOARD_PROGRESS', step }).catch(() => {}); };
  const { nebiusKey } = await chrome.storage.local.get('nebiusKey');
  if (!nebiusKey) return { error: 'Save your Nebius key first.' };

  progress({ kind: 'info', text: `Reading ${username}'s recent games from Lichess…` });
  const book = A.buildBook(await (await fetch(chrome.runtime.getURL('openings.json'))).json());
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}` +
    `?max=${MAX_IMPORT}&clocks=true&opening=true&finished=true`;
  const res = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
  if (!res.ok) return { error: `Lichess returned HTTP ${res.status}${res.status === 404 ? ' (no such user)' : ''}.` };
  const games = (await res.text()).split('\n').filter(Boolean).map(line => {
    try { return A.gameFromLichess(JSON.parse(line), username, self.Chess, book); } catch { return null; }
  }).filter(Boolean);
  if (!games.length) return { error: 'No finished standard games found for that user.' };
  const timed = games.filter(g => g.medianThink != null).length;
  progress({ kind: 'info', text: `Read ${games.length} games (${timed} with move times). Handing them to the analyst…` });

  // Imported games join the file; games watched live take precedence.
  const { dossier = { games: [] } } = await chrome.storage.local.get('dossier');
  const live = (dossier.games || []).filter(g => g.source !== 'import');
  const liveIds = new Set(live.map(g => g.id));
  const merged = [...games.filter(g => !liveIds.has(g.id)), ...live]
    .sort((a, b) => (a.date || 0) - (b.date || 0))
    .slice(-120);
  await chrome.storage.local.set({ dossier: { games: merged }, lichessUser: username });

  const result = await runAgent(username, games, progress);
  if (result.error) return result;
  progress({ kind: 'info', text: 'The file is written. The characters are reading it…' });
  const impressions = await firstImpressions(username, result.findings);
  const profile = {
    username, builtAt: Date.now(), gamesRead: games.length, timedGames: timed,
    findings: result.findings, impressions, steps: result.steps, mode: result.mode, model: result.model,
    revisions: result.revisions || 0, rejected: result.rejectedTotal || 0
  };
  await chrome.storage.local.set({ profile });
  return { profile };
}

if (typeof module !== 'undefined') module.exports = { TOOLS, METRICS, permutationP, runTool, parseToolJson, sanitizeFindings, verifyFinding, directionClaim, compact, agentSystem, runAgent, handleOnboard };

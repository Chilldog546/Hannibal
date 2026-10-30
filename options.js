// options.js — settings page.
const API_BASE = 'https://api.tokenfactory.nebius.com/v1';
const PT = window.HannibalPortraits;
const COLORS = { general: PT.CAST.general.bg, vale: PT.CAST.vale.bg, ashby: PT.CAST.ashby.bg };
const TAGS = { general: 'The General', vale: 'Dr. Vale', ashby: 'Ashby' };
const BLURB = {
  general: ['Hannibal Barca. Watches your command of the game: the clock, the opening, whether you finish what you start.', 'Mistakes caution for cowardice.'],
  vale: ['Dr. Mercer Vale, a clinician of decisions. Watches hesitation, haste and the patterns you repeat.', 'Sees symptoms in noise.'],
  ashby: ['A steward whose household is gone. Watches you: losing streaks, tilt, the late hour.', 'Softens hard truths until it is nearly too late.']
};

function node(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderCast() {
  const box = $('cast');
  ['general', 'vale', 'ashby'].forEach(id => {
    const card = node('article', 'card');
    const face = node('div', 'face');
    face.innerHTML = PT.portrait(id, 96);
    card.append(face, node('h3', null, TAGS[id]), node('p', null, BLURB[id][0]), node('p', 'flaw', BLURB[id][1]));
    box.appendChild(card);
  });
}

const $ = id => document.getElementById(id);
const say = (text, cls = '') => { $('msg').textContent = text; $('msg').className = 'msg ' + cls; };

function fill(sel, ids, selected) {
  sel.innerHTML = '';
  ids.forEach(id => {
    const o = document.createElement('option');
    o.value = o.textContent = id;
    sel.appendChild(o);
  });
  if (selected && ids.includes(selected)) sel.value = selected;
}

// Smallest sensible model for live remarks, largest for depth.
function pickLive(ids) { return ids.find(i => /nano/i.test(i)) || ids.find(i => /super/i.test(i)) || ids[0]; }
function pickDeep(ids) { return ids.find(i => /super/i.test(i)) || ids.find(i => /ultra/i.test(i)) || ids[0]; }

let currentDossier = null;
function showFileCount(dossier) {
  currentDossier = dossier;
  const games = dossier?.games || [];
  const live = games.filter(g => g.source !== 'import').length;
  $('filecount').textContent = games.length
    ? `${games.length} games in the file (${live} watched live, ${games.length - live} read from your history).`
    : 'No games in the file yet.';
}

function showProfile(p) {
  const box = $('file');
  box.innerHTML = '';
  if (!p) { $('tab').textContent = 'Hannibal: file on you'; return; }
  $('tab').textContent = `Hannibal: file on ${p.username}`;
  const head = node('p', 'filehead',
    `Opened ${new Date(p.builtAt).toLocaleDateString()}. ${p.gamesRead} games read by ${p.model.replace(/^nvidia\//, '')} in ${p.steps.length} steps` +
    (p.rejected ? `; the verifier sent back ${p.rejected} finding${p.rejected > 1 ? 's' : ''}.` : '.'));
  box.appendChild(head);
  const imps = node('div', 'impressions');
  (p.impressions || []).forEach(l => {
    const row = node('div', 'imp');
    const face = node('div');
    face.innerHTML = PT.portrait(l.character, 56);
    const col = node('div');
    const b = node('b', null, TAGS[l.character]);
    b.style.color = COLORS[l.character];
    col.append(b, node('q', null, l.text));
    row.append(face, col);
    imps.appendChild(row);
  });
  box.appendChild(imps);
  const fs = node('div', 'findings');
  p.findings.forEach(f => {
    const d = node('div', 'finding');
    d.style.borderLeftColor = COLORS[f.character];
    if (f.verified) d.appendChild(node('span', 'verified', 'verified'));
    const h = node('h4', null, f.title);
    const who = node('div', 'ev', `For ${TAGS[f.character]}`);
    who.style.color = COLORS[f.character];
    d.append(h, node('div', null, f.observation), node('div', 'ev', f.evidence), who);
    fs.appendChild(d);
  });
  box.appendChild(fs);

  // What has changed since the file was opened (games watched live).
  const games = (p.sample ? p.sampleGames : currentDossier?.games) || [];
  const live = games.filter(g => g.source !== 'import' && (g.date || 0) >= p.builtAt).length;
  const tr = node('div', 'trend');
  tr.appendChild(node('h3', null, 'Since the file was opened'));
  const rows = window.HannibalAnalysis ? HannibalAnalysis.trend(games, p.builtAt) : [];
  if (rows.length) {
    rows.forEach(r => {
      const d = node('div', 'trow');
      const better = r.after < r.before;
      d.append(node('span', null, r.label), node('span', 'tnum', `${r.before}${r.unit} → ${r.after}${r.unit}`));
      d.lastChild.style.color = better ? 'var(--ashby)' : 'var(--stamp)';
      tr.appendChild(d);
    });
    tr.appendChild(node('p', 'ev', `${rows[0].nBefore} games before the file, ${rows[0].nAfter} watched live since.`));
  } else {
    tr.appendChild(node('p', 'ev', live >= 3
      ? `${live} games watched since the file was opened. Nothing has changed by enough to report yet.`
      : `After 3 games watched live, this shows what has changed: ${live} of 3 so far.`));
  }
  box.appendChild(tr);
  if (p.sample) {
    const note = node('p', 'filehead', 'This is a sample file for a made-up player, so you can see what the characters write. Read your own games to replace it.');
    box.prepend(note);
  }
}

function showLatency(latency) {
  const fmt = (label, list) => {
    if (!list?.length) return null;
    const ms = list.map(x => x.ms).sort((a, b) => a - b);
    const med = ms[Math.floor(ms.length / 2)];
    return `${label}: median ${(med / 1000).toFixed(1)}s over ${ms.length} calls (${list[list.length - 1].model.replace(/^nvidia\//, '')})`;
  };
  const parts = [fmt('Live remarks', latency?.live), fmt('Debriefs and agent', latency?.deep), fmt('Reviewer', latency?.check)].filter(Boolean);
  $('latency').textContent = parts.length ? parts.join('. ') + '.' : 'No calls to Nemotron yet.';
}

function logStep(step) {
  const li = document.createElement('li');
  if (step.kind === 'verify') {
    li.className = step.ok ? 'pass' : 'fail';
    li.textContent = `verifier ${step.text}`;
  } else if (step.kind === 'tool') {
    li.className = 'tool';
    const args = step.args && Object.keys(step.args).length ? ' ' + JSON.stringify(step.args) : '';
    li.textContent = `agent → ${step.name}${args}`;
  } else {
    li.textContent = step.text;
  }
  $('log').appendChild(li);
}

renderCast();

chrome.storage.local.get(
  ['nebiusKey', 'model', 'liveModel', 'deepModel', 'mode', 'lead', 'voice', 'reviewer', 'dossier', 'profile', 'lichessUser', 'latency'],
  s => {
    if (s.nebiusKey) $('key').value = s.nebiusKey;
    $('sample').hidden = !!s.profile;
    const live = s.liveModel || s.model, deep = s.deepModel || s.model;
    if (live) fill($('liveModel'), [...new Set([live, deep].filter(Boolean))], live);
    if (deep) fill($('deepModel'), [...new Set([deep, live].filter(Boolean))], deep);
    $('mode').value = s.mode || 'computer';
    $('lead').value = s.lead || 'ensemble';
    $('voice').checked = !!s.voice;
    $('reviewer').checked = s.reviewer !== false;
    $('user').value = s.lichessUser || s.profile?.username || '';
    showFileCount(s.dossier);
    showProfile(s.profile);
    showLatency(s.latency);
  }
);

chrome.storage.onChanged.addListener(ch => {
  if (ch.latency) showLatency(ch.latency.newValue);
  if (ch.dossier) showFileCount(ch.dossier.newValue);
  // The agent saves the file itself, so it shows up even if the reply is lost.
  if (ch.profile) showProfile(ch.profile.newValue);
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'ONBOARD_PROGRESS') logStep(msg.step);
});

$('load').addEventListener('click', async () => {
  const key = $('key').value.trim();
  if (!key) return say('Paste your API key first.', 'err');
  say('Loading…');
  try {
    const res = await fetch(`${API_BASE}/models`, { headers: { authorization: `Bearer ${key}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    const ids = (data.data || []).map(m => m.id).filter(id => /nemotron/i.test(id)).sort();
    if (!ids.length) return say('Key works, but no Nemotron models are listed for it.', 'err');
    fill($('liveModel'), ids, $('liveModel').value || pickLive(ids));
    fill($('deepModel'), ids, $('deepModel').value || pickDeep(ids));
    if (!ids.includes($('liveModel').value)) $('liveModel').value = pickLive(ids);
    if (!ids.includes($('deepModel').value)) $('deepModel').value = pickDeep(ids);
    say(`Found ${ids.length} Nemotron model(s). Check the two choices and save.`, 'ok');
  } catch (e) {
    say(`Could not load models: ${e.message}`, 'err');
  }
});

$('save').addEventListener('click', () => {
  const nebiusKey = $('key').value.trim();
  const liveModel = $('liveModel').value, deepModel = $('deepModel').value;
  if (!nebiusKey) return say('API key is required.', 'err');
  if (!liveModel || !deepModel) return say('Load your models and pick both first.', 'err');
  chrome.storage.local.set(
    { nebiusKey, model: deepModel, liveModel, deepModel, mode: $('mode').value, lead: $('lead').value, voice: $('voice').checked, reviewer: $('reviewer').checked },
    () => say('Saved. Open a game on lichess.org.', 'ok')
  );
});

$('build').addEventListener('click', () => {
  const username = $('user').value.trim();
  if (!username) return;
  $('log').innerHTML = '';
  $('file').innerHTML = '';
  $('build').disabled = true;
  chrome.runtime.sendMessage({ type: 'ONBOARD', username }, res => {
    $('build').disabled = false;
    if (chrome.runtime.lastError) return logStep({ kind: 'info', text: 'Error: ' + chrome.runtime.lastError.message });
    if (res?.error) return logStep({ kind: 'info', text: 'Error: ' + res.error });
    logStep({ kind: 'info', text: 'Done.' });
    showProfile(res.profile);
  });
});

$('sample').addEventListener('click', () => {
  const t = Date.now() - 6 * 864e5;
  const g = (i, src, triggers, d) => ({ id: 's' + i, source: src, date: d, result: i % 3 ? 'loss' : 'win', triggers });
  const sampleGames = [...Array(12)].map((_, i) => ({ ...g(i, 'import', i % 2 ? ['rush_after_loss'] : ['hesitation'], t - (12 - i) * 36e5), vsComputer: true }))
    .concat([...Array(4)].map((_, i) => ({ ...g(20 + i, 'live', i === 0 ? ['rush_after_loss'] : [], t + (i + 1) * 36e5), vsComputer: true })));
  showProfile({
    sample: true, sampleGames, username: 'a sample player', builtAt: t, gamesRead: 12, model: 'nvidia/nemotron-3-super-120b-a12b',
    steps: [1, 2, 3, 4, 5, 6, 7], rejected: 1,
    impressions: [
      { character: 'general', text: 'Five losses in six with the clock mostly spent by move twenty. You march well and arrive with no supplies.' },
      { character: 'vale', text: 'The move before you lose a piece takes a third of your usual time. I have a theory about what you were hurrying towards.' },
      { character: 'ashby', text: 'Seven of eight losses played out to the very end. In my house we called that stubbornness, and we meant it kindly.' }],
    findings: [
      { character: 'general', verified: true, title: 'Spends the clock early', observation: 'Most of the clock is gone before the middle game.', evidence: 'games with most of the clock gone by move 20: 83% in losses vs 0% in other games (6 vs 6 games, p = 0.02)' },
      { character: 'vale', verified: true, title: 'The hurried move before the loss', observation: 'The move right before material is lost is usually made far faster than any other.', evidence: 'think time on the move right before losing material, vs their normal: 0.34x over 9 games (all games)' },
      { character: 'ashby', verified: true, title: 'Plays lost games to the end', observation: 'Almost never resigns; lost games run until mate or the flag.', evidence: 'losses ended by resigning: 13% over 8 games (all games)' }]
  });
});

$('clear').addEventListener('click', () => {
  if (!confirm('Forget every game and the file? The characters will treat you as a stranger again.')) return;
  chrome.storage.local.set({ dossier: { games: [] } }, () => {
    chrome.storage.local.remove('profile', () => { showFileCount(null); showProfile(null); });
  });
});

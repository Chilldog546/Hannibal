// portraits.js — the three characters, drawn as SVG.
// One shared grammar (flat shapes, one ink outline, paper skin, two colours
// per character) and one ornament each: the General is a coin profile on a
// sunburst, Vale sits on blueprint grid with a measuring rule, Ashby stands
// in lamplight. Used by the in-game figure, the settings page and the
// share card.

(function (root) {
  const INK = '#1d1915', PAPER = '#efe7d6', SHADE = '#d6cbb4';

  const CAST = {
    general: { name: 'The General', short: 'General', bg: '#5b2a4a', accent: '#c19554', light: '#e7c98f' },
    vale: { name: 'Dr. Vale', short: 'Vale', bg: '#2f4858', accent: '#8fb8cc', light: '#cfe2ea' },
    ashby: { name: 'Ashby', short: 'Ashby', bg: '#3d5a3a', accent: '#e0a948', light: '#f3d79a' }
  };

  const S = `stroke="${INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;

  function general(uid) {
    const c = CAST.general;
    const rays = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2, x = 50 + Math.cos(a) * 60, y = 50 + Math.sin(a) * 60;
      return `<line x1="50" y1="50" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${c.accent}" stroke-opacity="${i % 2 ? 0.16 : 0.3}" stroke-width="${i % 2 ? 1 : 2.4}"/>`;
    }).join('');
    return `
  <defs><clipPath id="${uid}"><circle cx="50" cy="50" r="48"/></clipPath></defs>
  <circle cx="50" cy="50" r="48" fill="${c.bg}"/>
  <g clip-path="url(#${uid})">${rays}
    <path d="M18 104 C20 86 33 79 50 79 C67 79 80 86 82 104 Z" fill="${c.accent}" ${S}/>
    <path d="M30 92 C38 86 62 86 70 92" fill="none" stroke="${INK}" stroke-width="1.5" stroke-opacity=".55"/>
    <path d="M45 66 L44 80 L59 80 L57 66 Z" fill="${SHADE}" ${S}/>
    <path d="M35 50 C34 37 42 29 54 29 C62 29 66 34 66 40 L67 45 L72 53 L67 55 L68 59 L66 61 L65 65 C62 69 56 70 50 68 L44 66 C38 63 35 57 35 50 Z" fill="${PAPER}" ${S}/>
    <path d="M44 58 C46 66 52 70 58 70 C62 70 65 67 66 63 L64 60 C61 62 57 62 54 60 L50 55 C48 57 46 58 44 58 Z" fill="${INK}"/>
    <path d="M58 58.5 L64.5 58" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M59 44 L64 43.5" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M33 54 C29 38 38 25 53 24 C62 24 69 30 69 38 L61 39 C59 35 55 34 52 37 L51 50 L46 58 L41 64 L35 62 Z" fill="${c.accent}" ${S}/>
    <path d="M44 41 C44 47 46 52 50 55" fill="none" stroke="${INK}" stroke-width="1.4" stroke-opacity=".6"/>
    <path d="M62 27 C60 10 42 2 24 9 C14 14 9 26 11 40 C14 36 18 33 23 33 C27 28 33 25 40 25 C48 23 56 24 62 27 Z" fill="${INK}"/>
    <path d="M18 18 C26 10 40 7 52 12 M15 27 C22 18 36 14 50 17 M19 33 C26 25 38 21 54 22" fill="none" stroke="${c.accent}" stroke-width="1.3" stroke-opacity=".75"/>
  </g>
  <circle cx="50" cy="50" r="44.5" fill="none" stroke="${c.accent}" stroke-width="1.6" stroke-dasharray="1.5 2.6"/>
  <circle cx="50" cy="50" r="48" fill="none" stroke="${INK}" stroke-width="2.5"/>`;
  }

  function vale(uid) {
    const c = CAST.vale;
    let grid = '';
    for (let v = 6; v < 100; v += 8) {
      grid += `<line x1="${v}" y1="0" x2="${v}" y2="100" stroke="${c.accent}" stroke-opacity="${v % 24 === 6 ? 0.34 : 0.15}" stroke-width="1"/>` +
              `<line x1="0" y1="${v}" x2="100" y2="${v}" stroke="${c.accent}" stroke-opacity="${v % 24 === 6 ? 0.34 : 0.15}" stroke-width="1"/>`;
    }
    const ticks = [28, 34, 40, 46, 52, 58, 64].map((y, i) =>
      `<line x1="${i % 3 === 0 ? 17 : 19}" y1="${y}" x2="23" y2="${y}" stroke="${c.light}" stroke-width="1"/>`).join('');
    return `
  <defs><clipPath id="${uid}"><circle cx="50" cy="50" r="48"/></clipPath></defs>
  <circle cx="50" cy="50" r="48" fill="${c.bg}"/>
  <g clip-path="url(#${uid})">${grid}
    <line x1="23" y1="28" x2="23" y2="64" stroke="${c.light}" stroke-width="1"/>${ticks}
    <circle cx="50" cy="47" r="27" fill="none" stroke="${c.light}" stroke-opacity=".45" stroke-width="1" stroke-dasharray="3 3"/>
    <path d="M16 104 C18 86 31 79 50 79 C69 79 82 86 84 104 Z" fill="#1f2c35" ${S}/>
    <path d="M41 79 L50 94 L59 79 Z" fill="${PAPER}" ${S}/>
    <path d="M48.5 82 L51.5 82 L52.5 95 L50 99 L47.5 95 Z" fill="${c.bg}" stroke="${INK}" stroke-width="1.2"/>
    <path d="M44 66 L44 80 L56 80 L56 66 Z" fill="${SHADE}" ${S}/>
    <ellipse cx="50" cy="51" rx="15" ry="18" fill="${PAPER}" ${S}/>
    <path d="M35 49 C33 34 42 27 51 27 C60 27 67 33 65 49 C63 41 60 37 55 36 C49 39 42 39 37 37 C36 41 35 45 35 49 Z" fill="#17222a" ${S}/>
    <path d="M45 36.5 C49 33.5 55 33 59 35" fill="none" stroke="${c.accent}" stroke-width="1" stroke-opacity=".6"/>
    <circle cx="44" cy="51" r="5.6" fill="${c.light}" fill-opacity=".35" ${S}/>
    <circle cx="56" cy="51" r="5.6" fill="${c.light}" fill-opacity=".35" ${S}/>
    <path d="M49.6 50.4 Q50 49.2 50.4 50.4" fill="none" stroke="${INK}" stroke-width="1.6"/>
    <circle cx="44" cy="51.5" r="1.3" fill="${INK}"/><circle cx="56" cy="51.5" r="1.3" fill="${INK}"/>
    <path d="M46 62 L54 62" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M68 104 L68 82 L88 82 L88 104" fill="${PAPER}" ${S}/>
    <path d="M72 88 L84 88 M72 93 L82 93 M72 98 L84 98" stroke="${c.bg}" stroke-width="1.2"/>
  </g>
  <circle cx="50" cy="50" r="48" fill="none" stroke="${INK}" stroke-width="2.5"/>`;
  }

  function ashby(uid) {
    const c = CAST.ashby;
    return `
  <defs>
    <clipPath id="${uid}"><circle cx="50" cy="50" r="48"/></clipPath>
    <radialGradient id="${uid}g" cx="22%" cy="20%" r="75%">
      <stop offset="0" stop-color="${c.light}" stop-opacity=".95"/>
      <stop offset=".35" stop-color="${c.accent}" stop-opacity=".45"/>
      <stop offset="1" stop-color="${c.bg}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="50" cy="50" r="48" fill="${c.bg}"/>
  <g clip-path="url(#${uid})">
    <circle cx="50" cy="50" r="48" fill="url(#${uid}g)"/>
    <path d="M22 9 L22 16 M15 16 L29 16 L25 24 L19 24 Z" fill="${c.light}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M14 102 C16 85 30 78 50 78 C70 78 84 85 86 102 Z" fill="#1a1d17" ${S}/>
    <path d="M40 79 L50 104 L60 79 Z" fill="${PAPER}" ${S}/>
    <path d="M44 80 L50 98 L56 80" fill="none" stroke="${SHADE}" stroke-width="1"/>
    <path d="M40 78 L50 84 L46 89 L37 82 Z M60 78 L50 84 L54 89 L63 82 Z" fill="${PAPER}" ${S}/>
    <path d="M42 81 L50 85 L42 89 Z M58 81 L50 85 L58 89 Z" fill="${INK}"/>
    <circle cx="50" cy="85" r="1.8" fill="${INK}"/>
    <path d="M64 84 L80 84 L78 93 L66 93 Z" fill="${PAPER}" ${S}/>
    <path d="M79 86 C84 86 84 91 78.5 91" fill="none" stroke="${INK}" stroke-width="2"/>
    <path d="M61 95 L83 95" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>
    <path d="M69 80 C68 77 71 76 70 73 M75 80 C74 77 77 76 76 73" fill="none" stroke="${c.light}" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M44 64 L44 76 L56 76 L56 64 Z" fill="${SHADE}" ${S}/>
    <path d="M34 47 C34 34 41 27 51 27 C61 27 67 34 67 47 C67 59 61 68 51 68 C41 68 34 59 34 47 Z" fill="${PAPER}" ${S}/>
    <path d="M38 34 C42 30 46 28 51 28 C57 28 61 30 64 34" fill="none" stroke="${c.light}" stroke-width="2" stroke-opacity=".9"/>
    <path d="M33 50 C29 46 30 40 34 38 C35 42 36 45 37 48 Z M68 50 C72 46 71 40 67 38 C66 42 65 45 64 48 Z" fill="#cfcfc6" ${S}/>
    <path d="M41 45 Q45 43 48 45 M54 45 Q57 43 61 45" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M42 49 Q45 51 47.5 49 M55 49 Q58 51 60.5 49" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M51 49 L49 56 L52 56.5" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M45 60 Q51 64 57 60" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>
  </g>
  <circle cx="50" cy="50" r="48" fill="none" stroke="${INK}" stroke-width="2.5"/>`;
  }

  let n = 0;
  function portrait(id, size = 56) {
    const draw = { general, vale, ashby }[id] || vale;
    const uid = `hp${id}${++n}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${(CAST[id] || CAST.vale).name}">${draw(uid)}</svg>`;
  }

  // The three side by side, for "all three" and loading states.
  function ensemble(size = 56) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="All three">
      <circle cx="50" cy="50" r="48" fill="#24211d" stroke="${INK}" stroke-width="2.5"/>
      <svg x="4" y="30" width="40" height="40" viewBox="0 0 100 100">${general('e1' + (++n))}</svg>
      <svg x="56" y="30" width="40" height="40" viewBox="0 0 100 100">${ashby('e2' + (++n))}</svg>
      <svg x="28" y="16" width="44" height="44" viewBox="0 0 100 100">${vale('e3' + (++n))}</svg>
    </svg>`;
  }

  const api = { CAST, portrait, ensemble, INK, PAPER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HannibalPortraits = api;
})(typeof self !== 'undefined' ? self : this);

// Boston Art Review "Weekly Happenings": read recent issues from Mailchimp's public archive
// and turn them into dated events, closing shows, open calls and articles.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const FEED = 'https://us17.campaign-archive.com/feed?u=ea83bc1f42383298569cb53c7&id=274aefc88d';
const UA = { headers: { 'user-agent': 'art-radar-openings-map (personal, weekly)' } };

const decode = s => s.replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, '’').replace(/&ldquo;|&rdquo;/g, '"').replace(/&ndash;/g, '–')
  .replace(/&mdash;/g, '—').replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

// Flatten newsletter HTML into lines, keeping each link as its own "@@LINK url" line.
function lines(html) {
  let h = html.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*?href="([^"]+)"[^>]*>/gi, (_, u) => `\n@@LINK ${decode(u)}\n`)
    .replace(/<br\s*\/?>|<\/(p|div|td|tr|h[1-6]|li|table|a)>/gi, '\n').replace(/<[^>]+>/g, '');
  return decode(h).split('\n').map(l => l.replace(/[\s‌​]+/g, ' ').trim()).filter(l => l && l !== '>' && l !== '-->');
}

const HEADER = /^(?:[A-Z0-9./&+–-] ){2,}[A-Z0-9./&+–-]?\s*(?:(?:[A-Z0-9./&+–-] ?)+)?$/;   // "T U E S D A Y 1 1 / 1 7"
const isHeader = l => HEADER.test(l) && /[A-Z] [A-Z] [A-Z]/.test(l);
const TIME = /,?\s*((?:\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\s*[–-]\s*)?\d{1,2}(?::\d{2})?\s*(?:AM|PM)(?:\s*[–-]\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM))?)\.?\s*$/i;
const ACRONYMS = new Set(['MIT', 'ICA', 'MFA', 'BCA', 'PRC', 'SMFA', 'ACM', 'NEA', 'AR', 'VR', 'BU', 'BAR', 'DJ', 'NEFA', 'UMASS', 'II', 'III', 'IV', 'LGBTQ', 'LGBTQ+', 'AI', 'USA', 'MASSART', 'Q&A']);
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'from', 'into', 'vs']);
function titleCase(s) {
  if (s !== s.toUpperCase()) return s;                       // already mixed case
  let i = 0;
  return s.toLowerCase().replace(/[\p{L}\p{N}'’+&.]+/gu, w => {
    const up = w.toUpperCase(), first = i++ === 0;
    if (ACRONYMS.has(up.replace(/[.’']s?$/, ''))) return up === 'UMASS' ? 'UMass' : up === 'MASSART' ? 'MassArt' : up;
    if (!first && SMALL.has(w)) return w;
    return w.replace(/(^|[-'’"(])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
  }).replace(/: (\p{Ll})/gu, (m, c) => ': ' + c.toUpperCase()).replace(/"(\p{Ll})/gu, (m, c) => '"' + c.toUpperCase());
}

function dates(header, issueDate) {
  const compact = header.replace(/ /g, '');
  const md = [...compact.matchAll(/(\d{1,2})\/(\d{1,2})/g)].map(m => [+m[1], +m[2]]);
  const iy = +issueDate.slice(0, 4), im = +issueDate.slice(5, 7);
  const iso = ([m, d]) => `${m < im - 6 ? iy + 1 : m > im + 6 ? iy - 1 : iy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { compact, start: md.length ? iso(md[0]) : null, end: md.length ? iso(md[md.length - 1]) : null };
}

function kindOf(compact) {
  if (/^APPLYTHROUGH|^DEADLINE|^DUE/.test(compact)) return 'opencall';
  if (/^CLOSES|^CLOSING|^LASTCHANCE|^ONVIEWTHROUGH/.test(compact)) return 'closing';
  if (/^(MON|TUE|WED|THU|FRI|SAT|SUN)|^\d/.test(compact) && /\d\/\d/.test(compact)) return 'event';
  if (/^(INTERVIEW|FEATURE|REVIEW|ESSAY|PROFILE|COLUMN|PODCAST|NEWS|ONLINE|READ|INPRINT|CRITICISM|CONVERSATION)/.test(compact)) return 'article';
  if (/^PROGRAM/.test(compact) && /\d\/\d/.test(compact)) return 'event';
  return 'other';                                             // shop, donation asks, sponsor notes
}

function category(title) {
  const m = title.match(/^([A-Z][A-Z0-9 &+\/–-]{2,40}):\s*(.+)$/);
  if (m && m[1] === m[1].toUpperCase()) return { category: titleCase(m[1].trim()), title: m[2].trim() };
  const words = ['WORKSHOP', 'LECTURE', 'TALK', 'TOUR', 'FAIR', 'MARKET', 'SCREENING', 'PERFORMANCE', 'RECEPTION', 'OPEN STUDIOS', 'CONCERT', 'READING', 'PANEL', 'SALE', 'PARTY', 'FESTIVAL', 'CLASS'];
  const w = words.find(w => title.toUpperCase().includes(w));
  return { category: w ? titleCase(w) : 'Event', title };
}

export function parseIssue(html, issueDate, issueUrl) {
  const L = lines(html), out = [];
  const idx = L.map((l, i) => isHeader(l) ? i : -1).filter(i => i >= 0);
  for (let n = 0; n < idx.length; n++) {
    const block = L.slice(idx[n] + 1, n + 1 < idx.length ? idx[n + 1] : L.length);
    const header = L[idx[n]], { compact, start, end } = dates(header, issueDate), kind = kindOf(compact);
    if (kind === 'other') continue;
    const links = []; const text = [];
    for (let i = 0; i < block.length; i++) {
      if (block[i].startsWith('@@LINK ')) { const u = block[i].slice(7); if (/^https?:/.test(u) && !/list-manage\.com\/(profile|unsubscribe)|mailchimp\.com|mailchi\.mp/.test(u)) links.push({ u, label: block[i + 1] || '' }); continue; }
      if (/^(LEARN MORE|READ|RSVP|SHOP|REGISTER|TICKETS|DONATE.*|SUBMIT YOUR WEEKLY HAPPENINGS|MORE INFO)\s*>?$/i.test(block[i])) { text.push('@@END'); continue; }
      text.push(block[i]);
    }
    const body = text.slice(0, text.includes('@@END') ? text.indexOf('@@END') : text.length);
    if (!body.length) continue;
    const learn = links.find(l => /LEARN MORE|READ|RSVP|REGISTER|TICKETS|MORE INFO/i.test(l.label)) || links[0];
    const url = learn ? learn.u.replace(/([?&])(utm_[^&]+|mc_[ce]id=[^&]+)&?/g, '$1').replace(/[?&]$/, '') : issueUrl;
    let [rawTitle, ...rest] = body;
    if (/:$/.test(rawTitle) && rest.length) rawTitle += ' ' + rest.shift();          // "OPEN STUDIOS:" + "BRICKBOTTOM ..."
    const base = { kind, header: header.replace(/ (?=\S)/g, '').replace(/([A-Z])(\d)/, '$1 $2'), url, issue: issueUrl };

    if (kind === 'event') {
      const { category: cat, title } = category(rawTitle);
      const pIdx = rest.findIndex(l => /^Presented by\b/i.test(l));
      let locLines = pIdx >= 0 ? rest.slice(pIdx + 1) : rest.slice(-1);
      let descLines = pIdx >= 0 ? rest.slice(0, pIdx) : rest.slice(0, -1);
      if (pIdx < 0 && rest.length && !TIME.test(rest[rest.length - 1])) { locLines = []; descLines = rest; }
      let loc = locLines.join(' ').replace(/\s+,/g, ',').trim(), time = null;
      const tm = loc.match(TIME); if (tm) { time = tm[1].replace(/\s*([–-])\s*/g, '–').replace(/\s*(AM|PM)/gi, ' $1'); loc = loc.slice(0, tm.index).replace(/[,\s]+$/, ''); }
      const online = /^(online|virtual|zoom)\b/i.test(loc);
      out.push({ ...base, id: `bar-${start}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`, category: cat,
        title: titleCase(title), description: descLines.join(' ') || null, presenter: pIdx >= 0 ? rest[pIdx].replace(/^Presented by\s*/i, '') : null,
        location: online ? null : (loc || null), online, start, end, time });
    } else if (kind === 'closing') {
      const onView = rest.find(l => /^On view at/i.test(l));
      out.push({ ...base, id: `bar-closes-${rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`, title: rawTitle,
        description: rest.filter(l => l !== onView && !/^\d/.test(l)).join(' ') || null, venue: onView?.replace(/^On view at (the )?/i, '') || null,
        location: rest.find(l => /^\d/.test(l)) || null, end: start });
    } else if (kind === 'opencall') {
      out.push({ ...base, id: `bar-call-${rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`, title: rawTitle, description: rest.join(' ') || null, deadline: start });
    } else if (kind === 'article') {
      const by = rest.find(l => /^By /.test(l));
      out.push({ ...base, id: `bar-read-${rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`, type: titleCase(compact.replace(/\d.*$/, '')), title: rawTitle, byline: by?.replace(/^By /, '') || null });
    }
  }
  return out;
}

export async function recentIssues(n = 2) {
  const r = await fetch(FEED, UA); if (!r.ok) throw new Error(`newsletter archive returned HTTP ${r.status}`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)].map(m => m[0]).map(it => ({
    title: decode(((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim(), url: ((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim(),
    date: new Date((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]).toISOString().slice(0, 10) }))
    .filter(i => /weekly-art-happenings|weekly art happenings/i.test(i.url + i.title)).slice(0, n);
  if (!items.length) throw new Error('no Weekly Happenings issues found in the newsletter archive');
  for (const it of items) {
    const p = await fetch(it.url, UA); if (!p.ok) throw new Error(`newsletter issue ${it.url} returned HTTP ${p.status}`);
    it.entries = parseIssue(await p.text(), it.date, it.url);
  }
  return items;
}

// --- geocoding: Art Radar venues first, then OpenStreetMap Nominatim (max 1 request/second, cached) ---
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/\b(the|gallery|st|street|ave|avenue)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export function makeGeocoder(cachePath, venues) {
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  let last = 0, dirty = false;
  const byName = venues.map(v => ({ v, n: norm(v.title), a: norm(v.address?.address?.split(',')[0]) }));
  async function geocode(loc, presenter) {
    if (!loc) return null;
    const parts = loc.split(',').map(s => s.trim()).filter(Boolean);
    const streetIdx = parts.findIndex(p => /^\d+[A-Za-z]?\s+\S/.test(p));
    const street = streetIdx >= 0 ? norm(parts[streetIdx]) : null;
    const hit = byName.find(x => street && x.a && x.a === street) || byName.find(x => x.n.length > 5 && (norm(parts[0]) === x.n || norm(presenter) === x.n));
    if (hit) return { lat: hit.v.address.lat, lng: hit.v.address.lng, via: 'artradar' };
    let q = streetIdx >= 0 ? parts.slice(streetIdx).filter(p => !/^(room|suite|floor|fl\.?|#)\b/i.test(p)).join(', ') : parts.join(', ');
    if (streetIdx >= 0 && streetIdx === parts.length - 1) q += ', Boston';
    q = q.replace(/\bSt\.(?=,|$)/g, 'Street').replace(/\bAve\.(?=,|$)/g, 'Avenue').replace(/\bBlvd\.(?=,|$)/g, 'Boulevard');
    if (q in cache) return cache[q];
    const wait = last + 1100 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); last = Date.now();
    const u = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'us', viewbox: '-73.6,45.1,-69.8,41.0', bounded: '1' });
    const r = await fetch(u, { headers: { 'user-agent': 'art-radar-openings-map/1.0 (personal map of Boston art events)' } });
    let res = null;
    if (r.ok) { const j = await r.json(); if (j[0]) res = { lat: +j[0].lat, lng: +j[0].lon, via: 'osm' }; }
    else if (r.status !== 404) return null;                    // temporary failure: don't cache, retry next run
    cache[q] = res; dirty = true; return res;
  }
  geocode.save = () => { if (dirty) writeFileSync(cachePath, JSON.stringify(cache, null, 1) + '\n'); };
  return geocode;
}

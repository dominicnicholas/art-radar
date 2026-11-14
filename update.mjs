#!/usr/bin/env node
// Art Radar openings: refresh the map data, publish it, and send opening alerts.
// Usage: node update.mjs [--no-push] [--no-notify] [--force-notify] [--weekly]
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const cfg = existsSync(join(ROOT, 'config.json')) ? JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')) : {};
const WINDOW_DAYS = cfg.windowDays ?? 30;          // how far ahead the map looks
const SITE_URL = cfg.siteUrl || '';                // your GitHub Pages URL, used as the alert's tap-through link
const NTFY_TOPIC = cfg.ntfyTopic || '';            // phone alerts via the ntfy app; leave empty to skip
const WEEKLY_DAY = cfg.weeklyRoundupDay ?? 0;      // 0 = Sunday
const TZ = 'America/New_York';

const HOODS = { southend: 'South End', back_bay: 'Back Bay', fen: 'Fenway', walt: 'Waltham', jp: 'Jamaica Plain',
  alls: 'Allston', east_boston: 'East Boston', southie: 'South Boston', hyde: 'Hyde Park', sea: 'Seaport',
  fort_point: 'Fort Point', chinatown: 'Chinatown' };
const hood = s => s ? (HOODS[s] || s.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')) : null;
const decode = s => s == null ? s : s.replace(/&#0?38;|&amp;/g, '&').replace(/&#8217;|&#039;|&#39;/g, '’').replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&#8211;/g, '–').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

// --- read artradar.org ---------------------------------------------------
const flight = html => { let s = ''; const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g; let m; while ((m = re.exec(html))) s += JSON.parse(m[1]); return s; };
function records(s, type) {
  const out = [], key = `"type":"${type}"`; let i = 0;
  while ((i = s.indexOf(key, i)) !== -1) {
    const st = s.lastIndexOf('{"id":', i); let d = 0, j = st, q = false;
    for (; j < s.length; j++) { const c = s[j]; if (q) { if (c === '\\') j++; else if (c === '"') q = false; continue; }
      if (c === '"') q = true; else if (c === '{') d++; else if (c === '}' && --d === 0) break; }
    try { out.push(JSON.parse(s.slice(st, j + 1))); } catch {} i = j;
  }
  return out;
}
const page = async p => { const r = await fetch('https://artradar.org/' + p, { headers: { 'user-agent': 'art-radar-openings-map (personal, daily)' } });
  if (!r.ok) throw new Error(`artradar.org/${p} returned HTTP ${r.status}`); return flight(await r.text()); };

const ymd = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const nice = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

async function getOpenings() {
  const [cal, map] = await Promise.all([page('calendar'), page('map')]);
  const venues = new Map();
  for (const l of [...records(map, 'location'), ...records(cal, 'location')]) if (l.address?.lat) venues.set(l.slug, l);
  const shows = new Map(); for (const e of records(cal, 'exhibition')) if (e.start_date) shows.set(e.slug, e);
  if (shows.size < 20 || venues.size < 20) throw new Error(`only found ${shows.size} shows and ${venues.size} venues; artradar.org may have changed its layout`);
  const today = ymd(), through = addDays(today, WINDOW_DAYS);
  const openings = [...shows.values()].map(e => {
    const v = venues.get(e.parent_slug);
    return { id: e.slug, title: decode(e.title), opens: fmt(e.start_date), closes: e.end_date ? fmt(e.end_date) : null,
      venue: decode(e.parent_location || v?.title || ''), neighborhood: hood(e.neighborhood || v?.neighborhood),
      blurb: decode(e.shortDescription || '') || null, image: e.image || null,
      address: v?.address?.address || (typeof e.address === 'string' ? e.address : null),
      lat: v?.address?.lat ?? null, lng: v?.address?.lng ?? null,
      url: 'https://artradar.org/exhibition/' + e.slug, venueUrl: v?.website || null };
  }).filter(x => x.opens > today && x.opens <= through)
    .sort((a, b) => a.opens.localeCompare(b.opens) || a.venue.localeCompare(b.venue) || a.title.localeCompare(b.title));
  return { updated: new Date().toISOString(), today, through, openings };
}

// --- alerts --------------------------------------------------------------
function line(o) { return `• ${o.title} — ${o.venue}${o.neighborhood ? ', ' + o.neighborhood : ''}`; }
function buildAlerts(data, weekly) {
  const tomorrow = addDays(data.today, 1), alerts = [];
  const tm = data.openings.filter(o => o.opens === tomorrow);
  if (tm.length) alerts.push({ title: `Opening tomorrow (${nice(tomorrow)})`, body: tm.map(line).join('\n') });
  if (weekly) {
    const wk = data.openings.filter(o => o.opens <= addDays(data.today, 7));
    const byDay = Object.entries(wk.reduce((m, o) => ((m[o.opens] ||= []).push(o), m), {}));
    alerts.push({ title: `Opening this week: ${wk.length} show${wk.length === 1 ? '' : 's'}`,
      body: byDay.length ? byDay.map(([d, os]) => `${nice(d)}\n${os.map(line).join('\n')}`).join('\n\n') : 'No new openings on Art Radar this week.' });
  }
  return alerts;
}
async function notify({ title, body }) {
  if (NTFY_TOPIC) {
    const r = await fetch('https://ntfy.sh/' + encodeURIComponent(NTFY_TOPIC), { method: 'POST', body,
      headers: { Title: title.replace(/[^\x20-\x7E]/g, ''), Tags: 'art', ...(SITE_URL ? { Click: SITE_URL } : {}) } });
    if (!r.ok) console.error(`ntfy returned HTTP ${r.status}`);
  }
  if (process.platform === 'darwin') {
    const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try { execFileSync('osascript', ['-e', `display notification "${esc(body.split('\n').slice(0, 4).join('\n'))}" with title "Art Radar" subtitle "${esc(title)}"`]); } catch {}
  }
  console.log(`\n[${title}]\n${body}`);
}

// --- main ----------------------------------------------------------------
const statePath = join(ROOT, '.state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
try {
  const data = await getOpenings();
  mkdirSync(join(ROOT, 'docs/data'), { recursive: true });
  const outPath = join(ROOT, 'docs/data/openings.json');
  const prev = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;
  const changed = !prev || JSON.stringify(prev.openings) !== JSON.stringify(data.openings) || prev.today !== data.today;
  writeFileSync(outPath, JSON.stringify(data, null, 1) + '\n');
  console.log(`${data.openings.length} openings from ${addDays(data.today, 1)} to ${data.through}`);

  if (changed && !args.has('--no-push') && existsSync(join(ROOT, '.git'))) {
    const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { stdio: 'pipe' }).toString();
    git('add', 'docs/data/openings.json');
    if (git('status', '--porcelain', 'docs/data/openings.json').trim()) {
      git('commit', '-m', `Update openings for ${data.today}`); git('push'); console.log('Pushed updated map data.');
    }
  }

  const weekly = args.has('--weekly') || new Date(data.today + 'T12:00:00Z').getUTCDay() === WEEKLY_DAY;
  if (!args.has('--no-notify') && (state.lastAlerted !== data.today || args.has('--force-notify'))) {
    for (const a of buildAlerts(data, weekly)) await notify(a);
    state.lastAlerted = data.today;
  }
  state.lastSuccess = new Date().toISOString(); delete state.lastError;
} catch (e) {
  console.error('ERROR: ' + e.message);
  if (state.lastErrorDay !== ymd() && !args.has('--no-notify')) await notify({ title: 'Art Radar update failed', body: e.message }).catch(() => {});
  state.lastError = e.message; state.lastErrorDay = ymd(); process.exitCode = 1;
}
writeFileSync(statePath, JSON.stringify(state, null, 1) + '\n');

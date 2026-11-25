#!/usr/bin/env node
// Boston art map: refresh Art Radar openings and Boston Art Review's Weekly Happenings,
// publish the map data, and send alerts.
// Usage: node update.mjs [--no-push] [--no-notify] [--force-notify] [--weekly] [--new-issue]
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recentIssues, makeGeocoder } from './bar.mjs';
import { buildIcs } from './ics.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const cfg = existsSync(join(ROOT, 'config.json')) ? JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')) : {};
const WINDOW_DAYS = cfg.windowDays ?? 30;          // how far ahead the map looks
const SITE_URL = cfg.siteUrl || '';                // your GitHub Pages URL, used as the alert's tap-through link
const NTFY_TOPIC = cfg.ntfyTopic || '';            // phone alerts via the ntfy app; leave empty to skip
const WEEKLY_DAY = cfg.weeklyRoundupDay ?? 0;      // 0 = Sunday
const DEADLINE_DAYS = cfg.openCallReminderDays ?? 3;
const TZ = 'America/New_York';
const PUSH = !args.has('--no-push') && existsSync(join(ROOT, '.git'));

const HOODS = { southend: 'South End', back_bay: 'Back Bay', fen: 'Fenway', walt: 'Waltham', jp: 'Jamaica Plain',
  alls: 'Allston', east_boston: 'East Boston', southie: 'South Boston', hyde: 'Hyde Park', sea: 'Seaport',
  fort_point: 'Fort Point', chinatown: 'Chinatown' };
const hood = s => s ? (HOODS[s] || s.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')) : null;
const decode = s => s == null ? s : s.replace(/&#0?38;|&amp;/g, '&').replace(/&#8217;|&#039;|&#39;/g, '’').replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&#8211;/g, '–').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { stdio: 'pipe' }).toString();

// --- dates -----------------------------------------------------------------
const ymd = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const nice = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const minutes = t => { const m = (t || '').match(/(\d{1,2})(?::(\d{2}))?\s*(?:[–-][^AP]*)?(AM|PM)?/i); if (!m) return 9999; const ap = m[3] || ((t.match(/(AM|PM)/i) || [])[1]) || 'PM'; return ((+m[1] % 12) + (/pm/i.test(ap) ? 12 : 0)) * 60 + (+m[2] || 0); };
const weekday = iso => new Date(iso + 'T12:00:00Z').getUTCDay();

// --- Art Radar ---------------------------------------------------------------
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

async function getArtRadar() {
  const [cal, map] = await Promise.all([page('calendar'), page('map')]);
  const venues = new Map();
  for (const l of [...records(map, 'location'), ...records(cal, 'location')]) if (l.address?.lat) venues.set(l.slug, l);
  const shows = new Map(); for (const e of records(cal, 'exhibition')) if (e.start_date) shows.set(e.slug, e);
  if (shows.size < 20 || venues.size < 20) throw new Error(`only found ${shows.size} shows and ${venues.size} venues; artradar.org may have changed its layout`);
  const all = [...shows.values()].map(e => {
    const v = venues.get(e.parent_slug);
    return { id: e.slug, title: decode(e.title), opens: fmt(e.start_date), closes: e.end_date ? fmt(e.end_date) : null,
      venue: decode(e.parent_location || v?.title || ''), neighborhood: hood(e.neighborhood || v?.neighborhood),
      blurb: decode(e.shortDescription || '') || null, image: e.image || null,
      address: v?.address?.address || (typeof e.address === 'string' ? e.address : null),
      lat: v?.address?.lat ?? null, lng: v?.address?.lng ?? null,
      url: 'https://artradar.org/exhibition/' + e.slug, venueUrl: v?.website || null };
  });
  return { all, venues: [...venues.values()] };
}

// --- Boston Art Review Weekly Happenings ---------------------------------------
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
async function getBar(venues, shows, today) {
  const issues = await recentIssues(2);                       // newest first; covers the overlap between weeks
  const seen = new Set(), events = [], closings = [], opencalls = [];
  for (const iss of issues) for (const e of iss.entries) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    if (e.kind === 'event' && (e.end || e.start) >= today) events.push(e);
    if (e.kind === 'closing' && e.end >= today) closings.push(e);
    if (e.kind === 'opencall' && e.deadline >= today) opencalls.push(e);
  }
  const geocode = makeGeocoder(join(ROOT, 'data/geocache.json'), venues);
  for (const e of [...events, ...closings]) {
    const g = e.online ? null : await geocode(e.location, e.presenter || e.venue);
    e.lat = g?.lat ?? null; e.lng = g?.lng ?? null;
  }
  geocode.save();
  // Opening receptions: link to the matching Art Radar show when there is one
  for (const e of events) if (/reception|opening/i.test(e.category)) {
    const t = norm(e.title.replace(/["“”]/g, ''));
    const s = t.length > 3 && shows.find(s => { const n = norm(s.title); return n === t || n.endsWith(' ' + t) || n.includes(t + ' '); });
    if (s) { e.show = s.id; if (e.lat == null) { e.lat = s.lat; e.lng = s.lng; } }
  }
  events.sort((a, b) => a.start.localeCompare(b.start) || minutes(a.time) - minutes(b.time));
  return { latest: issues[0], data: { updated: new Date().toISOString(), today,
    issues: issues.map(i => ({ title: i.title, date: i.date, url: i.url })),
    events, closings: closings.sort((a, b) => a.end.localeCompare(b.end)), opencalls: opencalls.sort((a, b) => a.deadline.localeCompare(b.deadline)),
    articles: issues[0].entries.filter(e => e.kind === 'article') } };
}

// --- alerts --------------------------------------------------------------------
const showLine = o => `• ${o.title} — ${o.venue}${o.neighborhood ? ', ' + o.neighborhood : ''}${o.reception ? ` (reception ${o.reception.time || nice(o.reception.date)})` : ''}`;
const eventLine = e => `• ${e.time ? e.time + ' ' : ''}${e.category}: ${e.title}${e.online ? ' (online)' : e.presenter ? ' — ' + e.presenter : ''}`;
const callLine = c => `• ${c.title} (due ${nice(c.deadline)})`;
const covered = (e, openings) => e.show && openings.some(o => o.id === e.show);   // reception already shown with its opening

function onDay(day, ar, bar) {
  const op = ar.filter(o => o.opens === day);
  const ev = (bar?.events || []).filter(e => e.start === day || (e.start < day && e.end >= day)).filter(e => !covered(e, op));
  return { op, ev };
}
function buildAlerts(today, ar, bar, { weekly, newIssue }) {
  const alerts = [], tomorrow = addDays(today, 1);
  const { op, ev } = onDay(tomorrow, ar, bar);
  const due = (bar?.opencalls || []).filter(c => c.deadline === addDays(today, DEADLINE_DAYS));
  const last = (bar?.closings || []).filter(c => c.end === tomorrow);
  const parts = [];
  if (op.length) parts.push(`OPENINGS\n${op.map(showLine).join('\n')}`);
  if (ev.length) parts.push(`EVENTS\n${ev.map(eventLine).join('\n')}`);
  if (last.length) parts.push(`LAST DAY\n${last.map(c => `• ${c.title}${c.venue ? ' — ' + c.venue : ''}`).join('\n')}`);
  if (due.length) parts.push(`OPEN CALLS DUE IN ${DEADLINE_DAYS} DAYS\n${due.map(callLine).join('\n')}`);
  if (parts.length) alerts.push({ title: `Tomorrow (${nice(tomorrow)}): ${[op.length && `${op.length} opening${op.length > 1 ? 's' : ''}`, ev.length && `${ev.length} event${ev.length > 1 ? 's' : ''}`].filter(Boolean).join(', ') || 'reminders'}`, body: parts.join('\n\n') });

  if (weekly) {
    const days = [...Array(7)].map((_, i) => addDays(today, i + 1));
    const body = days.map(d => { const { op, ev } = onDay(d, ar, bar); const l = [...op.map(showLine), ...ev.map(eventLine)]; return l.length ? `${nice(d)}\n${l.join('\n')}` : null; }).filter(Boolean);
    const n = days.reduce((s, d) => { const x = onDay(d, ar, bar); return s + x.op.length + x.ev.length; }, 0);
    alerts.push({ title: `This week: ${n} openings and events`, body: body.join('\n\n') || 'Nothing listed for the week ahead yet.' });
  }
  if (newIssue && bar) {
    const iss = bar.issues[0], evs = bar.events.filter(e => e.issue === iss.url);
    const byDay = Object.entries(evs.reduce((m, e) => ((m[e.start] ||= []).push(e), m), {}));
    const body = [byDay.map(([d, es]) => `${nice(d)}\n${es.map(eventLine).join('\n')}`).join('\n\n'),
      bar.opencalls.length && `OPEN CALLS\n${bar.opencalls.map(callLine).join('\n')}`,
      bar.closings.length && `CLOSING\n${bar.closings.map(c => `• ${c.title} (${nice(c.end)})`).join('\n')}`,
      bar.articles.length && `NEW TO READ\n${bar.articles.map(a => `• ${a.title}`).join('\n')}`].filter(Boolean).join('\n\n');
    alerts.push({ title: `New Weekly Happenings: ${evs.length} events, ${bar.opencalls.length} open calls`, body, click: iss.url });
  }
  return alerts;
}
async function notify({ title, body, click }) {
  const text = Buffer.byteLength(body) > 3900 ? body.slice(0, 3700).replace(/\n[^\n]*$/, '') + '\n… more on the map' : body;
  if (NTFY_TOPIC) {
    const r = await fetch('https://ntfy.sh/' + encodeURIComponent(NTFY_TOPIC), { method: 'POST', body: text,
      headers: { Title: title.replace(/[^\x20-\x7E]/g, ''), Tags: 'art', ...((click || SITE_URL) ? { Click: click || SITE_URL } : {}) } });
    if (!r.ok) console.error(`ntfy returned HTTP ${r.status}`);
  }
  if (process.platform === 'darwin') {
    const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try { execFileSync('osascript', ['-e', `display notification "${esc(text.split('\n').slice(0, 4).join('\n'))}" with title "Boston art" subtitle "${esc(title)}"`]); } catch {}
  }
  console.log(`\n[${title}]\n${text}`);
}

// --- main ----------------------------------------------------------------------
const statePath = join(ROOT, '.state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const today = ymd(), errors = [];
if (PUSH) { try { git('pull', '--rebase', '--autostash', '-q'); } catch (e) { errors.push('could not pull from GitHub: ' + e.message.split('\n')[0]); } }
mkdirSync(join(ROOT, 'docs/data'), { recursive: true }); mkdirSync(join(ROOT, 'data'), { recursive: true });
const write = (name, obj) => writeFileSync(join(ROOT, 'docs/data', name), JSON.stringify(obj, null, 1) + '\n');

let ar = null, arAll = [], venues = [], bar = null, latest = null;
try {
  const r = await getArtRadar(); arAll = r.all; venues = r.venues;
  const through = addDays(today, WINDOW_DAYS);
  ar = arAll.filter(x => x.opens > today && x.opens <= through).sort((a, b) => a.opens.localeCompare(b.opens) || a.venue.localeCompare(b.venue) || a.title.localeCompare(b.title));
  console.log(`Art Radar: ${ar.length} openings through ${through}`);
} catch (e) { errors.push('Art Radar: ' + e.message); }
try {
  const r = await getBar(venues, arAll, today); bar = r.data; latest = r.latest;
  console.log(`Weekly Happenings: ${bar.events.length} upcoming events (${bar.events.filter(e => e.lat != null).length} mapped), ${bar.opencalls.length} open calls, ${bar.closings.length} closing — latest issue ${latest.date}`);
} catch (e) { errors.push('Weekly Happenings: ' + e.message); }

if (ar) {
  for (const o of ar) { const rc = bar?.events.find(e => e.show === o.id); if (rc) o.reception = { date: rc.start, time: rc.time, url: rc.url }; }
  write('openings.json', { updated: new Date().toISOString(), today, through: addDays(today, WINDOW_DAYS), openings: ar });
}
if (bar) write('bar.json', bar);
if (ar || bar) {                                             // calendar feed: keep the last good data for a source that failed today
  const prev = n => { try { return JSON.parse(readFileSync(join(ROOT, 'docs/data', n), 'utf8')); } catch { return null; } };
  writeFileSync(join(ROOT, 'docs/calendar.ics'), buildIcs({ openings: ar || prev('openings.json')?.openings || [], bar: bar || prev('bar.json'), name: 'Boston art: openings & events', siteUrl: SITE_URL }));
}

if (PUSH && (ar || bar)) {
  try {
    git('add', 'docs/data', 'docs/calendar.ics', 'data');
    if (git('status', '--porcelain', 'docs/data', 'docs/calendar.ics', 'data').trim()) { git('commit', '-q', '-m', `Update map data for ${today}`); git('push', '-q'); console.log('Pushed updated map data.'); }
  } catch (e) { errors.push('could not push to GitHub: ' + e.message.split('\n')[0]); }
}

if (!args.has('--no-notify')) {
  const weekly = args.has('--weekly') || weekday(today) === WEEKLY_DAY;
  const newIssue = args.has('--new-issue') || (latest && state.lastIssue !== latest.url && state.lastIssue !== undefined);
  const daily = state.lastAlerted !== today || args.has('--force-notify');
  const alerts = buildAlerts(today, ar || [], bar, { weekly: weekly && daily, newIssue });
  for (const a of daily ? alerts : alerts.filter(a => a.title.startsWith('New Weekly'))) await notify(a);
  if (daily) state.lastAlerted = today;
  if (errors.length && state.lastErrorDay !== today) { await notify({ title: 'Boston art update had a problem', body: errors.join('\n') }).catch(() => {}); state.lastErrorDay = today; }
}
if (latest) state.lastIssue = latest.url;
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exitCode = 1; state.lastError = errors.join(' | '); } else { delete state.lastError; state.lastSuccess = new Date().toISOString(); }
writeFileSync(statePath, JSON.stringify(state, null, 1) + '\n');

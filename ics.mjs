// Build an iCalendar (.ics) feed from the map data, for subscribing in Apple/Google/Outlook calendars.
const TZ = 'America/New_York';

// Offset of Boston time from UTC (in minutes) on a given date, accounting for daylight saving.
function offsetMinutes(iso, hh, mm) {
  const guess = new Date(`${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return (utc - local) / 60000;
}
const utcStamp = (iso, minutes) => {
  const hh = Math.floor(minutes / 60), mm = minutes % 60;
  const t = new Date(`${iso}T${String(hh % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  t.setUTCDate(t.getUTCDate() + Math.floor(hh / 24));
  t.setUTCMinutes(t.getUTCMinutes() + offsetMinutes(iso, hh % 24, mm));
  return t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
};
const dateOnly = iso => iso.replace(/-/g, '');
const nextDay = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

// "6:30–8:00 PM" -> [1110, 1200]; "11:00 AM–5:00 PM" -> [660, 1020]; "6:00 PM" -> [1080, 1200]
export function parseTimes(t) {
  if (!t) return null;
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*[–-]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM))?/i);
  if (!m) return null;
  const endAp = m[6], startAp = m[3] || endAp || 'PM';
  const toMin = (h, mi, ap) => ((+h % 12) + (/pm/i.test(ap) ? 12 : 0)) * 60 + (+mi || 0);
  const s = toMin(m[1], m[2], startAp);
  let e = m[4] ? toMin(m[4], m[5], endAp) : s + 120;
  if (e <= s) e = s + 120;
  return [s, e];
}

const escText = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {                                  // RFC 5545: lines of at most 75 octets
  const out = []; let cur = '';
  for (const ch of line) { if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; } cur += ch; }
  out.push(cur); return out.join('\r\n ');
}

export function buildIcs({ openings = [], bar = null, name = 'Boston art', siteUrl = '' }) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ev = [];
  const add = ({ uid, title, start, end, allDay, location, description, url, categories }) => {
    const L = ['BEGIN:VEVENT', `UID:${uid}@boston-art-map`, `DTSTAMP:${now}`];
    if (allDay) L.push(`DTSTART;VALUE=DATE:${dateOnly(start)}`, `DTEND;VALUE=DATE:${dateOnly(end || nextDay(start))}`, 'TRANSP:TRANSPARENT');
    else L.push(`DTSTART:${start}`, `DTEND:${end}`);
    L.push(`SUMMARY:${escText(title)}`);
    if (location) L.push(`LOCATION:${escText(location)}`);
    if (description) L.push(`DESCRIPTION:${escText(description)}`);
    if (url) L.push(`URL:${url}`);
    if (categories) L.push(`CATEGORIES:${escText(categories)}`);
    L.push('END:VEVENT'); ev.push(L.map(fold).join('\r\n'));
  };

  const shownReceptions = new Set();
  for (const o of openings) {
    const loc = o.address?.replace(/, USA$/, '') || o.venue;
    const desc = [o.blurb, o.closes && `On view through ${o.closes}`, o.url].filter(Boolean).join('\n');
    const r = o.reception, rt = r && parseTimes(r.time);
    if (r && rt) {
      shownReceptions.add(o.id);
      add({ uid: `reception-${o.id}`, title: `Opening reception: ${o.title} (${o.venue})`, start: utcStamp(r.date, rt[0]), end: utcStamp(r.date, rt[1]), location: loc, description: desc, url: r.url || o.url, categories: 'Opening' });
      if (r.date !== o.opens) add({ uid: `opening-${o.id}`, title: `Opens: ${o.title} (${o.venue})`, start: o.opens, allDay: true, location: loc, description: desc, url: o.url, categories: 'Opening' });
    } else {
      add({ uid: `opening-${o.id}`, title: `Opens: ${o.title} (${o.venue})`, start: o.opens, allDay: true, location: loc, description: desc, url: o.url, categories: 'Opening' });
    }
  }
  if (bar) {
    for (const e of bar.events) {
      if (e.show && shownReceptions.has(e.show)) continue;
      const tm = parseTimes(e.time), multi = e.end && e.end !== e.start;
      const desc = [e.description, e.presenter && `Presented by ${e.presenter}`, e.time && multi && `Hours: ${e.time}`, e.url, 'From Boston Art Review’s Weekly Happenings'].filter(Boolean).join('\n');
      const base = { uid: e.id, title: `${e.category}: ${e.title}`, location: e.online ? 'Online' : e.location, description: desc, url: e.url, categories: e.category };
      if (tm && !multi) add({ ...base, start: utcStamp(e.start, tm[0]), end: utcStamp(e.start, tm[1]) });
      else add({ ...base, start: e.start, end: nextDay(e.end || e.start), allDay: true });
    }
    for (const c of bar.closings) add({ uid: c.id, title: `Last day: ${c.title}${c.venue ? ` (${c.venue})` : ''}`, start: c.end, allDay: true, location: c.location, description: [c.description, c.url].filter(Boolean).join('\n'), url: c.url, categories: 'Closing' });
    for (const c of bar.opencalls) add({ uid: c.id, title: `Deadline: ${c.title}`, start: c.deadline, allDay: true, description: [c.description, c.url].filter(Boolean).join('\n'), url: c.url, categories: 'Open call' });
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//boston-art-map//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${escText(name)}`), `X-WR-TIMEZONE:${TZ}`, fold(`X-WR-CALDESC:${escText('Openings from Boston Art Radar and events from Boston Art Review’s Weekly Happenings' + (siteUrl ? '. Map: ' + siteUrl : ''))}`),
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H', ...ev, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

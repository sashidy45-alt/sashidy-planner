'use strict';
const { hash } = require('./notifications');
const MINUTE = 60000;
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s; }
function dateInZone(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function parts(ms, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date(ms)).map(x => [x.type,x.value]));
}
// Resolve wall-clock time in an IANA zone, independently of the server's UTC clock.
function instant(date, minutes, zone) {
  if (!validDate(date) || !Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) return NaN;
  const target = Date.parse(date + 'T00:00:00Z') + minutes * MINUTE;
  let guess = target;
  for (let i=0;i<4;i++) {
    const p = parts(guess,zone);
    const represented = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);
    const diff = target - represented;
    if (!diff) return guess;
    guess += diff;
  }
  return NaN; // Nonexistent local time at a DST jump: do not move the activity.
}
function addDate(d,n) { return new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10); }
function matches(sr,date) {
  if (!validDate(sr.from) || date < sr.from || sr.skip?.[date]) return false;
  const d = new Date(date+'T00:00:00Z');
  if (sr.kind === 'daily') return true;
  if (sr.kind === 'week') return (sr.days || []).includes((d.getUTCDay()+6)%7);
  if (sr.kind === 'month') return d.getUTCDate() === Math.min(sr.monthDay || +sr.from.slice(8), new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate());
  return false;
}
function occurrences(doc,dates) {
  const tasks = (doc.tasks || []).filter(t => dates.includes(t.date));
  const have = new Set(tasks.map(t => t.seriesId ? t.seriesId+'@'+t.date : t.id));
  for (const sr of doc.series || []) for (const date of dates) {
    const id = sr.id+'@'+date;
    if (!have.has(id) && matches(sr,date) && !(doc.del?.[id] > (sr.ruleUpd || 0))) {
      tasks.push({ ...sr, id, date, seriesId:sr.id, done:false, status:'review' }); have.add(id);
    }
  }
  return tasks.filter(t => !t.done && t.status !== 'done' && !(doc.del?.[t.id] > (t.upd || 0)));
}
function reminders(doc,prefs,now=Date.now()) {
  if (!doc || !prefs.enabled) return [];
  const today = dateInZone(now,prefs.timeZone);
  const dates = [addDate(today,-1),today,addDate(today,1)];
  const result = [];
  for (const task of occurrences(doc,dates)) {
    const timed = Number.isInteger(task.start) && task.start >= 0 && task.start < 1440;
    if (timed ? !prefs.timed : !prefs.daily || task.start != null) continue;
    const minute = timed ? task.start : +prefs.dailyTime.slice(0,2)*60 + +prefs.dailyTime.slice(3);
    const start = instant(task.date,minute,prefs.timeZone), due = start - (timed ? 10*MINUTE : 0);
    // Minute scheduler with a three-minute recovery window; no stale backlog bursts.
    if (!Number.isFinite(due) || due > now || now - due >= 3*MINUTE || (timed && start <= now)) continue;
    const hhmm = String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
    const title = String(task.title || 'Actividad').slice(0,120);
    const dateLabel = new Intl.DateTimeFormat('es-EC',{timeZone:prefs.timeZone,day:'numeric',month:'short'}).format(start);
    const id = hash(task.id+'|'+task.date+'|'+minute+'|'+(timed?'timed':'daily'));
    result.push({ id, expiresAt: timed ? start : start+3*MINUTE,
      payload: { title, body: timed ? `${dateLabel} · ${hhmm} · Comienza en ${Math.ceil((start-now)/MINUTE)} min` : `${dateLabel} · Actividad para hoy, sin hora asignada`,
        tag:'sashidy-'+id, url:'/?view=day&date='+task.date+'&task='+encodeURIComponent(task.id) } });
  }
  return result;
}
module.exports = { validDate, instant, dateInZone, matches, occurrences, reminders };

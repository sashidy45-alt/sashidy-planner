'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const R=require('../lib/reminders');
const prefs={enabled:true,timed:true,daily:false,dailyTime:'08:00',timeZone:'America/Guayaquil'};
const now=Date.parse('2026-10-22T14:50:00Z');
const task={id:'meeting',title:'Reunión de tesis',date:'2026-10-22',start:600};
const doc={tasks:[task],series:[],del:{}};
test('sends ten minutes before, with activity and local scheduled time',()=>{
  const events=R.reminders(doc,prefs,now);assert.equal(events.length,1);
  assert.equal(events[0].payload.title,'Reunión de tesis');assert.match(events[0].payload.body,/10:00.*10 min/);
  assert.equal(R.reminders(doc,prefs,now-1).length,0);assert.equal(R.reminders(doc,prefs,now+180000).length,0);
});
test('disabled, completed, removed or rescheduled activities do not notify',()=>{
  assert.equal(R.reminders(doc,{...prefs,enabled:false},now).length,0);
  for(const change of [{done:true},{status:'done'},{start:660},{date:null},{start:null}])
    assert.equal(R.reminders({...doc,tasks:[{...task,...change}]},prefs,now).length,0);
  assert.equal(R.reminders({...doc,del:{meeting:1}},prefs,now).length,0);
});
test('activities without a time use the chosen daily hour only when enabled',()=>{
  const noTime={...doc,tasks:[{...task,start:null}]};
  assert.equal(R.reminders(noTime,{...prefs,daily:true,dailyTime:'09:50'},now).length,1);
  assert.equal(R.reminders(noTime,prefs,now).length,0);
});
test('midnight reminders use the next day and the correct timezone',()=>{
  const d={...doc,tasks:[{...task,date:'2026-10-23',start:5}]};
  assert.equal(R.reminders(d,prefs,Date.parse('2026-10-23T04:55:00Z')).length,1);
  assert.equal(R.instant('2026-10-22',600,'America/Guayaquil'),Date.parse('2026-10-22T15:00Z'));
});
test('recurrences work beyond the client 35-day materialization window',()=>{
  const sr={id:'repeat',title:'Reunión',from:'2026-01-01',kind:'daily',start:600};
  const d={tasks:[],series:[sr],del:{}};
  assert.equal(R.reminders(d,prefs,now).length,1);
  assert.equal(R.reminders({...d,series:[{...sr,skip:{'2026-10-22':true}}]},prefs,now).length,0);
  assert.equal(R.reminders({...d,del:{'repeat@2026-10-22':1}},prefs,now).length,0);
  assert.equal(R.reminders({...d,tasks:[{...task,id:'repeat@2026-10-22',seriesId:'repeat',done:true}]},prefs,now).length,0);
});
test('monthly month-end and weekly Monday-indexed recurrence match the agenda',()=>{
  assert.equal(R.matches({from:'2026-01-31',kind:'month',monthDay:31},'2026-02-28'),true);
  assert.equal(R.matches({from:'2026-01-01',kind:'week',days:[3]},'2026-10-22'),true);
  assert.equal(R.matches({from:'2026-01-01',kind:'week',days:[2]},'2026-10-22'),false);
});
test('DST and invalid dates do not silently shift events',()=>{
  assert.equal(R.instant('2026-07-01',600,'America/New_York'),Date.parse('2026-07-01T14:00Z'));
  assert.equal(R.instant('2026-01-01',600,'America/New_York'),Date.parse('2026-01-01T15:00Z'));
  assert.ok(Number.isNaN(R.instant('2026-03-08',150,'America/New_York')));
  assert.ok(Number.isNaN(R.instant('2026-02-30',600,'America/Guayaquil')));
});

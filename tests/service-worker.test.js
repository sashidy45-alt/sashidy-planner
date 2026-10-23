'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
function worker(){
 const listeners={},shown=[],opened=[];
 const self={location:{origin:'https://planner.example'},addEventListener:(n,f)=>listeners[n]=f,
 registration:{showNotification:async(title,options)=>shown.push({title,options})},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),{self,URL,Response});return {listeners,shown,opened};
}
test('push displays title and time as a system notification with the activity link',async()=>{
 const w=worker();let done;
 w.listeners.push({data:{json:()=>({title:'Reunión',body:'10:00 · Comienza en 10 min',tag:'one',url:'/?view=day&task=123'})},waitUntil:p=>done=p});await done;
 assert.equal(w.shown[0].title,'Reunión');assert.match(w.shown[0].options.body,/10:00/);assert.equal(w.shown[0].options.tag,'one');
 w.listeners.notificationclick({notification:{close(){},data:w.shown[0].options.data},waitUntil:p=>done=p});await done;
 assert.equal(w.opened[0],'https://planner.example/?view=day&task=123');
});
test('notification click cannot navigate to an external origin',async()=>{
 const w=worker();let done;w.listeners.notificationclick({notification:{close(){},data:{url:'https://evil.example/'}},waitUntil:p=>done=p});await done;
 assert.equal(w.opened[0],'https://planner.example/');
});

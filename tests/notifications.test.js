'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const N=require('../lib/notifications');
const api=require('../api/notifications');
const worker=require('../api/notification-dispatch');
const keys={p256dh:Buffer.alloc(65,1).toString('base64url'),auth:Buffer.alloc(16,2).toString('base64url')};
const sub={endpoint:'https://fcm.googleapis.com/fcm/send/test-device',keys};
const prefs={enabled:true,timed:true,daily:false,dailyTime:'08:00',timeZone:'America/Guayaquil'};
function response(){return {statusCode:0,setHeader(){},end(s){this.data=JSON.parse(s);}};}
test('rejects arbitrary URLs, userinfo and unsupported push destinations',()=>{
  assert.equal(N.subscription(sub).endpoint,sub.endpoint);
  for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://example.com','https://fcm.googleapis.com.evil.test/x','https://user:pass@fcm.googleapis.com/x','https://fcm.googleapis.com:8443/x'])assert.throws(()=>N.subscription({...sub,endpoint}));
});
test('validates preferences and fails closed without allowed codes',()=>{
  assert.throws(()=>N.preferences({...prefs,timeZone:'Invalid/Zone'}));
  assert.throws(()=>N.preferences({...prefs,dailyTime:'25:00'}));
  const old=process.env.ALLOWED_CODES;delete process.env.ALLOWED_CODES;
  assert.equal(N.account({headers:{authorization:'Bearer ABCD-EFGH-JKLM-NPQR'}}),null);
  if(old!==undefined)process.env.ALLOWED_CODES=old;
});
test('unauthorized registration and unsigned dispatch cannot send',async()=>{
  const res=response();await api({method:'POST',headers:{},body:{}},res);assert.equal(res.statusCode,403);
  const names=['KV_REST_API_URL','KV_REST_API_TOKEN','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT','QSTASH_CURRENT_SIGNING_KEY','QSTASH_NEXT_SIGNING_KEY','APP_URL'];
  const old={};for(const k of names){old[k]=process.env[k];process.env[k]='test';}process.env.APP_URL='https://planner.example';
  const r=response();await worker({method:'POST',headers:{},body:'tick'},r);assert.equal(r.statusCode,403);
  for(const k of names){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
});
test('dispatch deduplicates per device, retries failures and removes expired subscriptions',async()=>{
  const old={redis:N.redis,send:N.send,codes:N.codes,release:N.release};
  const map=new Map(); const owners=['ABCD-EFGH-JKLM-NPQR'];N.codes=()=>owners;
  const owner=N.hash(owners[0]),id=N.hash(sub.endpoint),key=N.subKey(owner);
  const subscriptions=new Map([[id,JSON.stringify({subscription:sub,preferences:prefs})],[id+'2',JSON.stringify({subscription:{...sub,endpoint:sub.endpoint+'2'},preferences:prefs})]]);
  const doc={doc:{tasks:[{id:'t',date:'2026-10-22',start:600,title:'Reunión'}],series:[],del:{}}};
  let sends=0, fail=0;
  N.redis=async c=>{
    if(c[0]==='HGETALL')return [...subscriptions].flat();
    if(c[0]==='HGET')return subscriptions.get(c[2])||null;
    if(c[0]==='HDEL'){subscriptions.delete(c[2]);return 1;}
    if(c[0]==='GET')return c[1]==='sashidy:doc:v1:'+owner?JSON.stringify(doc):map.get(c[1])||null;
    if(c[0]==='SET'){if(c.includes('NX')&&map.has(c[1]))return null;map.set(c[1],c[2]);return 'OK';}
    if(c[0]==='EVAL'){if(map.get(c[3])===c[4])map.delete(c[3]);return 1;}
    throw Error('Unexpected Redis command '+c[0]);
  };
  N.release=async(key,token)=>{if(map.get(key)===token)map.delete(key);};
  N.send=async()=>{if(fail)throw {statusCode:fail};sends++;};
  try{
    const now=Date.parse('2026-10-22T14:50:00Z');
    assert.equal((await worker.dispatch(now)).sent,2);
    assert.equal((await worker.dispatch(now)).sent,0);assert.equal(sends,2);
    map.clear();fail=503;assert.equal((await worker.dispatch(now)).failed,2);
    fail=0;assert.equal((await worker.dispatch(now)).sent,2);
    map.clear();fail=410;await worker.dispatch(now);assert.equal(subscriptions.size,0);
  }finally{Object.assign(N,old);}
});

test('signed QStash request verifies the exact body and destination',async()=>{
  const {createHmac,createHash}=require('node:crypto');
  const oldEnv={...process.env},oldRedis=N.redis,oldCodes=N.codes;
  const names=['KV_REST_API_URL','KV_REST_API_TOKEN','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT','QSTASH_CURRENT_SIGNING_KEY','QSTASH_NEXT_SIGNING_KEY'];
  for(const k of names)process.env[k]='test-signing-key';
  process.env.APP_URL='https://planner.example';N.redis=async()=> 'OK';N.codes=()=>[];
  const now=Math.floor(Date.now()/1000);
  function jwt(body,url){
    const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const p=Buffer.from(JSON.stringify({iss:'Upstash',sub:url,exp:now+60,nbf:now-10,body:createHash('sha256').update(body).digest('base64url')})).toString('base64url');
    return h+'.'+p+'.'+createHmac('sha256','test-signing-key').update(h+'.'+p).digest('base64url');
  }
  try{
    for(const [body,url,status] of [['tick','https://planner.example/api/notification-dispatch',200],['changed','https://planner.example/api/notification-dispatch',403],['tick','https://other.example/api/notification-dispatch',403]]){
      const r=response();await worker({method:'POST',headers:{'upstash-signature':jwt('tick',url)},body},r);assert.equal(r.statusCode,status);
    }
  }finally{for(const k of [...names,'APP_URL']){if(oldEnv[k]===undefined)delete process.env[k];else process.env[k]=oldEnv[k];}N.redis=oldRedis;N.codes=oldCodes;}
});

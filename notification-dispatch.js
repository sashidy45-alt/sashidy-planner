'use strict';
const { Receiver } = require('@upstash/qstash');
const N = require('../lib/notifications');
const { reminders } = require('../lib/reminders');
async function dispatch(now = Date.now()) {
  let sent=0, failed=0;
  for (const code of N.codes()) {
    const owner = N.hash(code), key = N.subKey(owner);
    const entries = await N.redis(['HGETALL',key]);
    if (!entries?.length) continue;
    const rawDoc = await N.redis(['GET','sashidy:doc:v1:'+owner]);
    const doc = rawDoc ? JSON.parse(rawDoc).doc : null;
    for (let i=0;i<entries.length;i+=2) {
      const id=entries[i], entry=JSON.parse(entries[i+1]);
      let sub,prefs;
      try { sub=N.subscription(entry.subscription); prefs=N.preferences(entry.preferences); } catch { continue; }
      for (const event of reminders(doc,prefs,now)) {
        const sentKey='sashidy:push:sent:'+owner+':'+id+':'+event.id;
        if (await N.redis(['GET',sentKey])) continue;
        const lock=sentKey+':lock', token=N.randomUUID();
        if (!await N.redis(['SET',lock,token,'NX','EX','90'])) continue;
        try {
          // Re-check cancellation, completion, edits and device opt-out immediately before sending.
          const [latestSub,latestDoc,alreadySent] = await Promise.all([
            N.redis(['HGET',key,id]),N.redis(['GET','sashidy:doc:v1:'+owner]),N.redis(['GET',sentKey])]);
          if (!latestSub || !latestDoc || alreadySent) continue;
          const latest=JSON.parse(latestSub);
          const current=reminders(JSON.parse(latestDoc).doc,latest.preferences,now).find(e=>e.id===event.id);
          if (!current) continue;
          await N.send(sub,current.payload,Math.max(1,Math.floor((current.expiresAt-now)/1000)));
          await N.redis(['SET',sentKey,'1','EX','1209600']); sent++;
        } catch(error) {
          if ([404,410].includes(error.statusCode)) { await N.redis(['HDEL',key,id]); break; }
          failed++;
        } finally { await N.release(lock,token); }
      }
    }
  }
  return {sent,failed};
}
module.exports = async (req,res) => {
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return N.reply(res,405,{error:'method_not_allowed'}); }
  if (!N.configured()) return N.reply(res,503,{error:'not_configured'});
  try {
    const receiver = new Receiver({currentSigningKey:process.env.QSTASH_CURRENT_SIGNING_KEY,nextSigningKey:process.env.QSTASH_NEXT_SIGNING_KEY});
    const valid = await receiver.verify({signature:req.headers['upstash-signature'] || '',body:await N.body(req,true),url:N.origin()+'/api/notification-dispatch'});
    if (!valid) return N.reply(res,403,{error:'not_allowed'});
  } catch { return N.reply(res,403,{error:'not_allowed'}); }
  try {
    const result = await dispatch();
    await N.redis(['SET','sashidy:push:heartbeat',String(Date.now()),'EX','600']);
    return N.reply(res,result.failed?503:200,result);
  } catch { return N.reply(res,503,{error:'service_unavailable'}); }
};
module.exports.config = {api:{bodyParser:false},maxDuration:60};
module.exports.dispatch = dispatch;

'use strict';
const N = require('../lib/notifications');
module.exports = async (req,res) => {
  if (!['GET','POST'].includes(req.method)) { res.setHeader('Allow','GET, POST'); return N.reply(res,405,{error:'method_not_allowed'}); }
  const owner = N.account(req);
  if (!owner || req.headers['sec-fetch-site'] === 'cross-site') return N.reply(res,403,{error:'not_allowed'});
  try {
    if (req.method === 'GET') {
      const ready = N.configured();
      const heartbeat = ready ? Number(await N.redis(['GET','sashidy:push:heartbeat'])) : 0;
      return N.reply(res,200,{ ready, publicKey:ready?process.env.VAPID_PUBLIC_KEY:null, schedulerActive:!!heartbeat && Date.now()-heartbeat < 180000 });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return N.reply(res,415,{error:'json_required'});
    let data;
    try { data = await N.body(req); } catch { return N.reply(res,400,{error:'invalid_request'}); }
    if (!data || typeof data !== 'object') return N.reply(res,400,{error:'invalid_request'});
    let sub;
    try { sub = N.subscription(data.subscription); } catch { return N.reply(res,400,{error:'invalid_subscription'}); }
    const id = N.hash(sub.endpoint), key = N.subKey(owner);
    if (data.action === 'disable') {
      await N.redis(['HDEL',key,id]);
      return N.reply(res,200,{ok:true});
    }
    if (data.action === 'status') {
      const raw = await N.redis(['HGET',key,id]);
      return N.reply(res,200,{preferences:raw?JSON.parse(raw).preferences:null});
    }
    if (!N.configured()) return N.reply(res,503,{error:'not_configured'});
    if (data.action === 'save') {
      let prefs;
      try { prefs = N.preferences(data.preferences); } catch { return N.reply(res,400,{error:'invalid_preferences'}); }
      if (!prefs.enabled) await N.redis(['HDEL',key,id]);
      else await N.saveSubscription(owner,sub,prefs);
      return N.reply(res,200,{ok:true});
    }
    if (data.action === 'test') {
      const raw = await N.redis(['HGET',key,id]);
      if (!raw || !JSON.parse(raw).preferences.enabled) return N.reply(res,409,{error:'device_disabled'});
      const allowed = await N.redis(['SET','sashidy:push:test:'+owner+':'+id,'1','NX','EX','60']);
      if (!allowed) return N.reply(res,429,{error:'try_later'});
      try { await N.send(sub,{title:'Sashidy Planner',body:'Las notificaciones están activadas en este dispositivo.',tag:'sashidy-test',url:'/?view=home'},60); }
      catch(error) {
        if ([404,410].includes(error.statusCode)) { await N.redis(['HDEL',key,id]); return N.reply(res,410,{error:'expired_subscription'}); }
        throw error;
      }
      return N.reply(res,200,{ok:true});
    }
    return N.reply(res,400,{error:'invalid_action'});
  } catch(error) { return N.reply(res,error.message==='device_limit'?409:503,{error:error.message==='device_limit'?'device_limit':'service_unavailable'}); }
};

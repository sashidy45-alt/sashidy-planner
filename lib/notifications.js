'use strict';
const { createHash, timingSafeEqual, randomUUID } = require('node:crypto');
const webpush = require('web-push');
const hash = value => createHash('sha256').update(value).digest('hex');
const norm = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/_/g, '-') : '';
const codeRE = /^[A-Z0-9-]{16,64}$/;
function codes() { return [...new Set((process.env.ALLOWED_CODES || '').split(',').map(norm).filter(c => codeRE.test(c)))]; }
function account(req) {
  const code = norm((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!codeRE.test(code) || !codes().some(c => timingSafeEqual(Buffer.from(hash(c)), Buffer.from(hash(code))))) return null;
  return hash(code);
}
function reply(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}
async function redis(command) {
  const url = new URL(process.env.KV_REST_API_URL);
  if (url.protocol !== 'https:' || !process.env.KV_REST_API_TOKEN) throw new Error('storage_unavailable');
  const response = await fetch(url, { method: 'POST', redirect: 'error',
    headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(8000), cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || data.error || !Object.hasOwn(data, 'result')) throw new Error('storage_unavailable');
  return data.result;
}
async function body(req, raw = false) {
  let value = raw ? (typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody) ? req.rawBody : undefined) : req.body;
  // Plain Vercel functions may expose a parsed body without a remaining stream.
  // QStash uses text/plain, preserving exactly the signed bytes.
  if (raw && value === undefined && (typeof req.body === 'string' || Buffer.isBuffer(req.body))) value = req.body;
  if (value === undefined) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length;
      if (size > 16384) throw new Error('invalid_request'); chunks.push(b); }
    value = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value !== 'string') {
    if (raw) throw new Error('raw_body_required');
    value = JSON.stringify(value);
  }
  if (!value || Buffer.byteLength(value) > 16384) throw new Error('invalid_request');
  return raw ? value : JSON.parse(value);
}
function origin() {
  const url = new URL(process.env.APP_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_app_url');
  return url.origin;
}
function configured() {
  return ['KV_REST_API_URL','KV_REST_API_TOKEN','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT',
    'QSTASH_CURRENT_SIGNING_KEY','QSTASH_NEXT_SIGNING_KEY','APP_URL'].every(k => !!process.env[k]);
}
function subscription(value) {
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 2048) throw new Error('invalid_subscription');
  const u = new URL(value.endpoint), h = u.hostname;
  const allowed = h === 'fcm.googleapis.com' || h === 'updates.push.services.mozilla.com' ||
    h.endsWith('.push.services.mozilla.com') || h.endsWith('.push.apple.com') || h.endsWith('.notify.windows.com');
  if (!allowed || u.protocol !== 'https:' || u.port || u.username || u.password || u.hash) throw new Error('invalid_subscription');
  const keys = value.keys || {};
  if (!/^[\w-]+$/.test(keys.p256dh || '') || Buffer.from(keys.p256dh, 'base64url').length !== 65 ||
      !/^[\w-]+$/.test(keys.auth || '') || Buffer.from(keys.auth, 'base64url').length !== 16) throw new Error('invalid_subscription');
  return { endpoint: u.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
function preferences(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.timed !== 'boolean' || typeof value.daily !== 'boolean' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.dailyTime) || typeof value.timeZone !== 'string' || value.timeZone.length > 80) throw new Error('invalid_preferences');
  new Intl.DateTimeFormat('es', { timeZone: value.timeZone }).format();
  return { enabled: value.enabled, timed: value.timed, daily: value.daily, dailyTime: value.dailyTime, timeZone: value.timeZone };
}
const subKey = owner => 'sashidy:push:v1:' + owner;
async function send(sub, payload, ttl = 600) {
  return webpush.sendNotification(sub, JSON.stringify(payload), { TTL: ttl, urgency: 'high', timeout: 8000,
    vapidDetails: { subject: process.env.VAPID_SUBJECT, publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY } });
}
async function saveSubscription(owner, sub, prefs) {
  const id = hash(sub.endpoint);
  const result = await redis(['EVAL', `
    if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 and redis.call('HLEN', KEYS[1]) >= 10 then return 0 end
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]); return 1`, '1', subKey(owner), id,
    JSON.stringify({ subscription: sub, preferences: prefs, updatedAt: Date.now() })]);
  if (Number(result) !== 1) throw new Error('device_limit');
  return id;
}
// Lease ownership prevents an old worker from releasing a newer worker's lock.
async function release(key, token) {
  return redis(['EVAL', "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", '1', key, token]);
}
module.exports = { hash, codes, account, reply, redis, body, origin, configured, subscription, preferences, subKey, send, saveSubscription, release, randomUUID };

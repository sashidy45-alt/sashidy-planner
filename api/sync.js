/* Sashidy Planner · Vercel + Upstash Redis.
 * Compatible with the Planly sync protocol (MIT, Daniil Kokorev).
 * Server-only environment: KV_REST_API_URL, KV_REST_API_TOKEN, ALLOWED_CODES.
 * ALLOWED_CODES is a comma-separated list of private pairing codes.
 * Missing/empty ALLOWED_CODES denies all access. Never put secrets in this file.
 */
'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const MAX_BODY = 1024 * 1024;
const CODE_RE = /^[A-Z0-9-]{16,64}$/;
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const empty = () => ({ version: 0, updatedAt: 0, doc: null });
const norm = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/_/g, '-') : '';
const hash = value => createHash('sha256').update(value).digest();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stamp = value => Number.isSafeInteger(value) && value >= 0;

// Compare and save in ONE Redis operation. Preserve the original JSON, including
// empty arrays and optional durations. No TTL: history does not expire here.
const CAS = `
local raw = redis.call('GET', KEYS[1])
local version = 0
if raw then version = cjson.decode(raw).version end
if version ~= tonumber(ARGV[1]) then
  return {409, raw or '{"version":0,"updatedAt":0,"doc":null}'}
end
redis.call('SET', KEYS[1], ARGV[2])
return {200, ARGV[2]}
`;

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

function permitted(code) {
  if (!CODE_RE.test(code)) return false;
  const digest = hash(code);
  return (process.env.ALLOWED_CODES || '').split(',').map(norm)
    .filter(value => CODE_RE.test(value))
    .some(value => timingSafeEqual(digest, hash(value)));
}

function safeTree(value, depth = 0, budget = { left: 100000 }) {
  if (--budget.left < 0 || depth > 32) return false;
  if (value === null || typeof value !== 'object') return true;
  return Object.keys(value).every(key => !unsafe.has(key) && safeTree(value[key], depth + 1, budget));
}

function validDoc(doc) {
  if (!plain(doc) || !safeTree(doc) || !plain(doc.settings) || !plain(doc.del) || !stamp(doc.settingsUpd)) return false;
  for (const name of ['tasks', 'folders', 'notes', 'series']) {
    if (!Array.isArray(doc[name]) || doc[name].length > 20000) return false;
    const ids = new Set();
    for (const item of doc[name]) {
      if (!plain(item) || typeof item.id !== 'string' || !item.id || item.id.length > 160 || unsafe.has(item.id) || ids.has(item.id)) return false;
      ids.add(item.id);
      if (item.upd !== undefined && !stamp(item.upd)) return false;
      const label = name === 'folders' ? 'name' : 'title';
      if (typeof item[label] !== 'string') return false;
      if (name === 'notes' && typeof item.body !== 'string') return false;
      if (item.subtasks !== undefined && (!Array.isArray(item.subtasks) || item.subtasks.some(sub =>
        !plain(sub) || typeof sub.id !== 'string' || unsafe.has(sub.id) || typeof sub.title !== 'string' || typeof sub.done !== 'boolean'))) return false;
    }
  }
  return Object.entries(doc.del).every(([id, time]) => id.length > 0 && id.length <= 160 && !unsafe.has(id) && stamp(time));
}

async function readBody(req) {
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) throw Object.assign(new Error(), { status: 413 });
  // Vercel's helper parses JSON; a normal Node server supplies a stream.
  const parsed = req.body;
  if (parsed !== undefined) {
    const raw = typeof parsed === 'string' || Buffer.isBuffer(parsed) ? parsed.toString() : JSON.stringify(parsed);
    if (Buffer.byteLength(raw) > MAX_BODY) throw Object.assign(new Error(), { status: 413 });
    return JSON.parse(raw);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY) throw Object.assign(new Error(), { status: 413 });
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function redis(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token || new URL(url).protocol !== 'https:') throw new Error('storage_unavailable');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
    cache: 'no-store'
  });
  const payload = await response.json();
  if (!response.ok || payload.error || !Object.hasOwn(payload, 'result')) throw new Error('storage_unavailable');
  return payload.result;
}

module.exports = async function handler(req, res) {
  try {
    if (!['GET', 'PUT'].includes(req.method)) {
      res.setHeader('Allow', 'GET, PUT');
      return json(res, 405, { error: 'method_not_allowed' });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'not_allowed' });
    const url = new URL(req.url, 'https://planner.invalid');
    const authorization = req.headers.authorization || '';
    const code = norm(authorization.startsWith('Bearer ') ? authorization.slice(7) : url.searchParams.get('code'));
    if (!permitted(code)) return json(res, 403, { error: 'not_allowed' });
    const key = 'sashidy:doc:v1:' + hash(code).toString('hex');

    if (req.method === 'GET') {
      const raw = await redis(['GET', key]);
      const current = raw === null ? empty() : JSON.parse(raw);
      if (!stamp(current.version) || (current.doc !== null && !validDoc(current.doc))) throw new Error('storage_unavailable');
      return json(res, 200, current);
    }

    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json_required' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.status === 413 ? 413 : 400, { error: error.status === 413 ? 'too_large' : 'bad_json' }); }
    if (!plain(body) || !stamp(body.base) || body.base >= Number.MAX_SAFE_INTEGER || !validDoc(body.doc)) return json(res, 400, { error: 'bad_doc' });
    const next = { version: body.base + 1, updatedAt: Date.now(), doc: body.doc };
    const result = await redis(['EVAL', CAS, '1', key, String(body.base), JSON.stringify(next)]);
    if (!Array.isArray(result) || ![200, 409].includes(Number(result[0]))) throw new Error('storage_unavailable');
    const current = JSON.parse(result[1]);
    if (Number(result[0]) === 409) return json(res, 409, current);
    return json(res, 200, { version: current.version, updatedAt: current.updatedAt });
  } catch (_) {
    // Do not expose credentials, pairing codes, documents or provider errors.
    return json(res, 503, { error: 'storage_unavailable' });
  }
};

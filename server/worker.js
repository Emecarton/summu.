// Summu's scan server (a Cloudflare Worker). It keeps the Gemini key hidden and passes scans from the Summu website to
// Google, so people don't need their own key. The key is a secret named GEMINI_KEY in the Worker's settings, never in this file.
// It also keeps Summu accounts (a username and password, no email) and each account's cards, in a D1 database bound as DB.
// Without that binding, scanning still works and the website keeps cards on the phone only.
const SITES = ['https://emecarton.github.io'];   // only these websites may use the server
const GOOGLE = 'https://generativelanguage.googleapis.com';
const MODEL = /^gemini-[a-z0-9.-]{1,50}$/;
const MAX_BYTES = 6000000;                          // one photo is well under this
const PER_10_MIN = 150;                             // calls per visitor (a scan is 1 to 8 calls)
const seen = new Map();                             // visitor -> [window start, calls], kept per server copy
const ACCT_PER_10_MIN = 600;                        // account calls per visitor (saving cards and photos)
const AUTH_PER_10_MIN = 20;                         // sign-ups and log-ins per visitor

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': SITES.includes(origin) ? origin : SITES[0],
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const say = (status, message) => new Response(JSON.stringify({ error: { code: status, message } }),
      { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/' && req.method === 'GET') return say(200, env.GEMINI_KEY ? 'Summu scan server is on.' : 'Summu scan server is on, but GEMINI_KEY is missing.');
    if (!SITES.includes(origin)) return say(403, 'Only the Summu website can use this server.');
    if (url.pathname === '/acct' || url.pathname.startsWith('/acct/')) return accounts(req, env, url, cors, say);
    if (!env.GEMINI_KEY) return say(503, 'Summu scan server has no Gemini key yet.');

    // Only two things are allowed: listing Google's models, and asking one Gemini model about a photo
    let path = '';
    if (req.method === 'GET' && url.pathname === '/v1beta/models') {
      const page = url.searchParams.get('pageToken');
      path = '/v1beta/models?pageSize=1000' + (page ? '&pageToken=' + encodeURIComponent(page) : '');
    } else if (req.method === 'POST') {
      const m = url.pathname.match(/^\/v1beta\/models\/([^/:]+):generateContent$/);
      if (m && MODEL.test(m[1])) path = url.pathname;
    }
    if (!path) return say(404, 'Not found.');

    // A simple limit per visitor so one person can't use up everyone's free scans
    if (tooMany(req, 'scan', PER_10_MIN)) return say(429, 'Too many scans from this phone. Wait a few minutes.');

    let body;
    if (req.method === 'POST') {
      body = await req.arrayBuffer();
      if (body.byteLength > MAX_BYTES) return say(413, 'Photo too big.');
    }
    const r = await fetch(GOOGLE + path, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
      body,
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};

// A simple limit per visitor and kind of call, so one person can't use up everyone's free scans or guess passwords
function tooMany(req, kind, max) {
  const who = kind + ':' + (req.headers.get('CF-Connecting-IP') || 'unknown'), now = Date.now();
  let w = seen.get(who);
  if (!w || now - w[0] > 600000) { w = [now, 0]; seen.set(who, w); }
  if (seen.size > 5000) seen.clear();
  return ++w[1] > max;
}

// ---------- Accounts ----------
// Passwords are never stored, only a salted PBKDF2 hash. A log-in gives the phone a random token; the server keeps only its hash.
// Each account's data is the same small set of keys the website keeps on the phone: profile, spots and one key per photo.
const NAME_RE = /^[a-z0-9_.]{3,20}$/i;
const KEY_RE = /^(profile|spots|ph_[A-Za-z0-9_-]{1,60})$/;
const MAX_VALUE = 1900000;                          // D1 keeps up to 2 MB per value; a photo is under 0.4 MB
const MAX_KEYS = 1000;                              // per account
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, display TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, born INTEGER NOT NULL, terms TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS kv (name TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (name, k))',
  'CREATE INDEX IF NOT EXISTS sessions_name ON sessions (name)',
];
let schemaReady = false;
const fails = new Map();                            // username -> [window start, wrong passwords]

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function pwHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
function same(a, b) { let d = a.length ^ b.length; for (let i = 0; i < Math.min(a.length, b.length); i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

async function accounts(req, env, url, cors, say) {
  if (!env.DB) return say(503, 'accounts_off');
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  const route = req.method + ' ' + url.pathname;
  const auth = route === 'POST /acct/signup' || route === 'POST /acct/login';
  if (tooMany(req, auth ? 'auth' : 'acct', auth ? AUTH_PER_10_MIN : ACCT_PER_10_MIN)) return say(429, 'Too many tries from this phone. Wait a few minutes.');
  if (!schemaReady) { await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))); schemaReady = true; }
  const body = async () => { try { return await req.json(); } catch (e) { return {}; } };
  const now = Date.now();
  const startSession = async user => {
    const token = randHex(32);
    await env.DB.prepare('INSERT INTO sessions (token, name, created) VALUES (?, ?, ?)').bind(await sha(token), user.name, now).run();
    return ok({ token, user: { name: user.display, born: user.born, terms: user.terms } });
  };

  if (route === 'POST /acct/signup') {
    const b = await body(), name = String(b.name || '').trim(), password = String(b.password || ''), born = Math.floor(+b.born), terms = String(b.terms || '');
    if (!NAME_RE.test(name)) return say(400, 'Pick a username with 3 to 20 letters, numbers, dots or underscores.');
    if (password.length < 8 || password.length > 200) return say(400, 'Use a password with at least 8 characters.');
    if (!born || born < 1900 || new Date().getUTCFullYear() - born < 13) return say(400, 'Summu is for people 13 and older.');
    if (!terms || terms.length > 20) return say(400, 'To use Summu, accept the Terms.');
    const id = name.toLowerCase();
    if (await env.DB.prepare('SELECT 1 FROM users WHERE name = ?').bind(id).first()) return say(409, 'That username is taken. Try another one.');
    const salt = randHex(16), user = { name: id, display: name, born, terms };
    try {
      await env.DB.prepare('INSERT INTO users (name, display, salt, hash, born, terms, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, name, salt, await pwHash(password, salt), born, terms, now).run();
    } catch (e) { return say(409, 'That username is taken. Try another one.'); }
    return startSession(user);
  }
  if (route === 'POST /acct/login') {
    const b = await body(), id = String(b.name || '').trim().toLowerCase(), password = String(b.password || '');
    let f = fails.get(id);
    if (f && now - f[0] > 600000) { fails.delete(id); f = null; }
    if (f && f[1] >= 10) return say(429, 'Too many wrong passwords. Wait a few minutes.');
    const u = NAME_RE.test(id) ? await env.DB.prepare('SELECT * FROM users WHERE name = ?').bind(id).first() : null;
    if (!u || !same(await pwHash(password, u.salt), u.hash)) {
      if (!f) { f = [now, 0]; fails.set(id, f); } f[1]++;
      if (fails.size > 5000) fails.clear();
      return say(401, 'Wrong username or password.');
    }
    fails.delete(id);
    return startSession(u);
  }

  // Everything else needs a log-in
  const m = (req.headers.get('Authorization') || '').match(/^Bearer ([0-9a-f]{64})$/);
  const tok = m ? await sha(m[1]) : '';
  const s = tok ? await env.DB.prepare('SELECT u.name, u.display, u.born, u.terms FROM sessions s JOIN users u ON u.name = s.name WHERE s.token = ?').bind(tok).first() : null;
  if (!s) return say(401, 'Log in again.');
  const key = url.searchParams.get('k') || '';

  if (route === 'GET /acct/data') {
    const rows = (await env.DB.prepare("SELECT k, v FROM kv WHERE name = ? AND k IN ('profile', 'spots')").bind(s.name).all()).results || [];
    const photos = (await env.DB.prepare("SELECT k FROM kv WHERE name = ? AND substr(k, 1, 3) = 'ph_'").bind(s.name).all()).results || [];
    const got = Object.fromEntries(rows.map(r => [r.k, JSON.parse(r.v)]));
    return ok({ user: { name: s.display, born: s.born, terms: s.terms }, profile: got.profile || null, spots: got.spots || null, photos: photos.map(r => r.k) });
  }
  if (route === 'GET /acct/kv') {
    if (!KEY_RE.test(key)) return say(400, 'Bad key.');
    const r = await env.DB.prepare('SELECT v FROM kv WHERE name = ? AND k = ?').bind(s.name, key).first();
    return r ? ok({ v: JSON.parse(r.v) }) : say(404, 'Not found.');
  }
  if (route === 'PUT /acct/kv') {
    if (!KEY_RE.test(key)) return say(400, 'Bad key.');
    const v = await req.text();
    if (v.length > MAX_VALUE) return say(413, 'Too big.');
    try { JSON.parse(v); } catch (e) { return say(400, 'Bad data.'); }
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM kv WHERE name = ?').bind(s.name).first();
    if (n && n.n >= MAX_KEYS && !(await env.DB.prepare('SELECT 1 FROM kv WHERE name = ? AND k = ?').bind(s.name, key).first())) return say(413, 'This account is full. Delete some cards.');
    await env.DB.prepare('INSERT INTO kv (name, k, v, updated) VALUES (?, ?, ?, ?) ON CONFLICT (name, k) DO UPDATE SET v = excluded.v, updated = excluded.updated')
      .bind(s.name, key, v, now).run();
    return ok({ ok: true });
  }
  if (route === 'DELETE /acct/kv') {
    if (!KEY_RE.test(key)) return say(400, 'Bad key.');
    await env.DB.prepare('DELETE FROM kv WHERE name = ? AND k = ?').bind(s.name, key).run();
    return ok({ ok: true });
  }
  if (route === 'POST /acct/terms') {
    const t = String((await body()).terms || '');
    if (!t || t.length > 20) return say(400, 'Bad terms.');
    await env.DB.prepare('UPDATE users SET terms = ? WHERE name = ?').bind(t, s.name).run();
    return ok({ ok: true });
  }
  if (route === 'POST /acct/logout') {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(tok).run();
    return ok({ ok: true });
  }
  if (route === 'DELETE /acct') {
    await env.DB.batch(['DELETE FROM kv WHERE name = ?', 'DELETE FROM sessions WHERE name = ?', 'DELETE FROM users WHERE name = ?']
      .map(q => env.DB.prepare(q).bind(s.name)));
    return ok({ ok: true });
  }
  return say(404, 'Not found.');
}

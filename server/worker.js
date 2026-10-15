// Summu's scan server (a Cloudflare Worker). It keeps the Gemini key hidden and passes scans from the Summu website to
// Google, so people don't need their own key. The key is a secret named GEMINI_KEY in the Worker's settings, never in this file.
const SITES = ['https://emecarton.github.io'];   // only these websites may use the server
const GOOGLE = 'https://generativelanguage.googleapis.com';
const MODEL = /^gemini-[a-z0-9.-]{1,50}$/;
const MAX_BYTES = 6000000;                          // one photo is well under this
const PER_10_MIN = 150;                             // calls per visitor (a scan is 1 to 8 calls)
const seen = new Map();                             // visitor -> [window start, calls], kept per server copy

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': SITES.includes(origin) ? origin : SITES[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const say = (status, message) => new Response(JSON.stringify({ error: { code: status, message } }),
      { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/' && req.method === 'GET') return say(200, env.GEMINI_KEY ? 'Summu scan server is on.' : 'Summu scan server is on, but GEMINI_KEY is missing.');
    if (!SITES.includes(origin)) return say(403, 'Only the Summu website can use this server.');
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
    const who = req.headers.get('CF-Connecting-IP') || 'unknown', now = Date.now();
    let w = seen.get(who);
    if (!w || now - w[0] > 600000) { w = [now, 0]; seen.set(who, w); }
    if (++w[1] > PER_10_MIN) return say(429, 'Too many scans from this phone. Wait a few minutes.');
    if (seen.size > 5000) seen.clear();

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

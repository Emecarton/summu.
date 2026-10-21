// Speed: Dex pictures, card cut-outs and fonts are kept on the phone after the first time, so the Vault and Dex
// fill in at once and work with a bad signal. A kept file older than 3 days is refreshed in the background.
// Pages, app code and everything else always come straight from the site.
const C = 'summu-media-v1', FRESH = 3 * 864e5;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(ks => Promise.all(ks.filter(k => k.startsWith('summu-') && k !== C).map(k => caches.delete(k))))
  .then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || !/\/(img|cut|fonts)\/(s\/)?[^/]+$/.test(u.pathname)) return;
  e.respondWith(caches.open(C).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const get = () => fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; });
    if (!hit) return get();
    const age = Date.now() - (Date.parse(hit.headers.get('date')) || 0);
    if (age > FRESH) e.waitUntil(get().catch(() => {}));
    return hit;
  }).catch(() => fetch(r)));
});

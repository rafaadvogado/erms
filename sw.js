// ERMS – service worker: guarda o programa para abrir sem internet. Nunca guarda dados do Dropbox.
const CACHE = 'erms-20261110125858';
const ARQS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQS.map(a => new Request(a, { cache: 'reload' })))).then(() => self.skipWaiting())) });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())) });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;   // Dropbox e demais: sempre pela rede
  // programa: rede primeiro (pega atualizações), cache se estiver sem internet
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')).then(r => r || fetch(e.request))));
});
// toque na notificação: abre (ou traz para frente) o ERMS na tela indicada
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || './#prazos', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(L => {
    for (const c of L) { if ('focus' in c) { c.navigate ? c.navigate(alvo).catch(() => { }) : 0; return c.focus() } }
    return self.clients.openWindow(alvo);
  }));
});

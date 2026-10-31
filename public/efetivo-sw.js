// Service worker do app de celular "Efetivo CMR".
// Escopo '/efetivo' — registrado assim de propósito para NÃO tocar no Sistema RH
// (/index.html), que continua sempre vindo da rede.
const CACHE = 'efetivo-v1';
const ARQUIVOS = [
  '/efetivo.html',
  '/efetivo.webmanifest',
  '/efetivo-icon-192.png',
  '/efetivo-icon-512.png',
  '/efetivo-icon-180.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Só GET do próprio site entra aqui; /api/* é POST e nunca é cacheado — quando
// falta sinal quem guarda o lançamento é a fila do app, não o cache.
self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Rede primeiro para ter sempre a versão nova quando há internet; cache é o
  // plano B na obra sem sinal.
  ev.respondWith(
    fetch(req)
      .then(resp => {
        if (resp && resp.ok) {
          const copia = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('/efetivo.html')))
  );
});

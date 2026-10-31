// Service worker do app instalável "CMR RH" (Sistema RH, /index.html).
// Escopo '/'. O app de celular "Efetivo CMR" tem o próprio worker com escopo
// '/efetivo' — o navegador usa sempre o escopo mais específico, então os dois
// não se atropelam.
//
// Rede primeiro, sempre: o RH vive de dados do servidor e já houve confusão
// com versão antiga na tela. O cache só entra sem internet, para abrir a última
// versão e mostrar o aviso de "sem conexão" em vez de uma página de erro.
const CACHE = 'cmr-rh-v1';
const ARQUIVOS = [
  '/',
  '/index.html',
  '/rh.webmanifest',
  '/cmr-logo.png',
  '/rh-icon-180.png',
  '/rh-icon-192.png',
  '/rh-icon-512.png',
  '/rh-icon-maskable-512.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      // só limpa caches do próprio RH; os do app de efetivo são dele
      .then(ks => Promise.all(ks.filter(k => k.startsWith('cmr-rh-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;                       // /api/* é POST: nunca passa aqui
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;             // CDN (Chart.js, fontes) segue direto
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/efetivo')) return;        // território do app de efetivo

  ev.respondWith(
    fetch(req)
      .then(resp => {
        if (resp && resp.ok && (req.mode === 'navigate' || ARQUIVOS.includes(url.pathname))) {
          const copia = resp.clone();
          caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? '/' : req, copia)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req.mode === 'navigate' ? '/' : req).then(r => r || caches.match('/index.html')))
  );
});

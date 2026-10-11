// ==========================================================================
// LUNOCA DOCERIA - Service Worker para PWA (Progressive Web App)
// ==========================================================================

const CACHE_NAME = 'lunoca-cache-v3.2.1';

const PRECACHE_ASSETS = [
  '/',
  '/css/style.css',
  '/manifest.json',
  '/img/logo.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Aviso no pré-cache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // NUNCA cachear rotas de API, Supabase, Mercado Pago ou requisições POST/PUT
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('mercadopago.com') ||
    url.hostname.includes('cloudflareinsights.com')
  ) {
    return;
  }

  // Intercepta qualquer requisição direta para /index.html e serve a raiz /
  // evitando quebras com o redirect 308 do Cloudflare Pages
  if (url.pathname === '/index.html') {
    event.respondWith(
      caches.match('/').then((cached) => cached || fetch('/'))
    );
    return;
  }

  // Estratégia Stale-While-Revalidate para assets estáticos locais
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        return cachedResponse;
      });

      return cachedResponse || fetchPromise;
    })
  );
});

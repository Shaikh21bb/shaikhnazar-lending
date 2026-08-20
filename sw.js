const VERSION = 'shaikh-sys-v2';
const CORE = [
    '/',
    '/index.html',
    '/login.html',
    '/dashboard.html',
    '/admin.html',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/apple-touch-icon.png',
    '/css/app.css',
    '/css/style.css',
    '/js/main.js',
    '/js/supabase.js',
    '/js/shyraq.js',
    '/js/agents.js',
    '/js/role.js',
    '/js/tasks.js',
    '/js/scripts.js',
    '/js/stats.js',
    '/js/clients.js',
    '/js/i18n.js',
    '/js/toasts.js',
    '/js/admin.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(VERSION)
            .then((c) => c.addAll(CORE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.origin !== location.origin) return;
    if (url.pathname.startsWith('/api/')) return;

    if (e.request.mode === 'navigate') {
        e.respondWith(
            fetch(e.request)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(VERSION).then((c) => c.put(e.request, copy));
                    return res;
                })
                .catch(() =>
                    caches.match(e.request).then((r) => r || caches.match('/dashboard.html'))
                )
        );
        return;
    }

    e.respondWith(
        caches.match(e.request).then((cached) => {
            const network = fetch(e.request)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(VERSION).then((c) => c.put(e.request, copy));
                    return res;
                })
                .catch(() => cached);
            return cached || network;
        })
    );
});
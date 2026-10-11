// PayKwacha Service Worker
const CACHE_NAME = 'paykwacha-v1';
const OFFLINE_URL = '/offline.html';

// Assets to cache immediately
const PRECACHE = [
    '/',
    '/manifest.json',
    '/betting/style.css',
    '/betting',
    '/dashboard',
    '/api-docs'
];

// Install — cache core assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(PRECACHE).catch(err => {
                console.log('Precache warning:', err.message);
            });
        })
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        })
    );
    self.clients.claim();
});

// Fetch strategy:
// - API calls → always network
// - HTML/CSS/JS → network first, fallback to cache
// - Images/fonts → cache first
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET
    if (event.request.method !== 'GET') return;

    // Skip API calls — always live
    if (url.pathname.startsWith('/api/')) return;

    // Skip external requests except fonts/images
    if (url.origin !== location.origin) {
        if (url.hostname.includes('fonts.gstatic.com') ||
            url.hostname.includes('fonts.googleapis.com') ||
            url.hostname.includes('gstatic.com')) {
            // Cache fonts
            event.respondWith(
                caches.match(event.request).then(cached => {
                    return cached || fetch(event.request).then(response => {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                        return response;
                    });
                })
            );
        }
        return;
    }

    // Same-origin requests
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Cache successful GET responses
                if (response.status === 200 && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => {
                // Network failed — try cache
                return caches.match(event.request).then(cached => {
                    if (cached) return cached;

                    // If HTML page is requested and no cache
                    if (event.request.mode === 'navigate') {
                        return caches.match(OFFLINE_URL);
                    }
                    return new Response('Offline', { status: 503 });
                });
            })
    );
});
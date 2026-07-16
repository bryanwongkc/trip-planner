const CACHE_PREFIX = 'trip-planner-'
const PRECACHE_NAME = `${CACHE_PREFIX}precache-v3`
const RUNTIME_NAME = `${CACHE_PREFIX}runtime-v3`
const PRECACHE_ENTRIES = self.__WB_MANIFEST
const PRECACHE_URLS = PRECACHE_ENTRIES.map((entry) =>
  typeof entry === 'string' ? entry : entry.url,
)

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && ![PRECACHE_NAME, RUNTIME_NAME].includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(RUNTIME_NAME)
    await cache.put(request, response.clone())
  }
  return response
}

async function navigationResponse(request) {
  try {
    return await fetch(request)
  } catch {
    return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ error: 'This request is unavailable while offline.' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request))
    return
  }

  if (PRECACHE_URLS.some((entry) => new URL(entry, self.location.origin).pathname === url.pathname)) {
    event.respondWith(cacheFirst(request))
    return
  }

  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'font' ||
    request.destination === 'image' ||
    url.pathname.startsWith('/assets/')
  ) {
    event.respondWith(cacheFirst(request))
  }
})

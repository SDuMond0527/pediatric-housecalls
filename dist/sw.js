// Service worker — deliberate passthrough.
//
// Prior versions of this file cached fetched responses in a fixed cache named
// 'phc-v1' and served them as fallback on network failure. Because the cache
// name never changed across deploys, users accumulated stale references to
// bundled JS/CSS files whose hashed filenames changed on every Vercel build.
// When the browser fetched an old hashed URL that no longer existed on the
// server, the SW would serve a broken/empty response, and the whole page
// would fail to load or fail to render pieces of the UI (encounter notes,
// schedules, etc). Two outages on 2026-09-08 traced back to this pattern.
//
// This SW does the minimum useful thing:
//  - skipWaiting on install so a new version takes effect on next navigation
//  - claim clients + purge every existing cache on activation, so any stale
//    entries left over from the old caching SW are removed the next time a
//    client picks up this file
//  - pass-through fetch handler that never caches, so nothing can go stale
//    again from this file
//
// The tradeoff: no offline caching for repeat visitors. The app is online-only
// anyway (all data lives in Neon behind authenticated API calls), so nothing
// user-facing is lost.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.map(k => caches.delete(k)))
    await self.clients.claim()
  })())
})

// No fetch handler = the browser handles every request normally, no interception,
// no caching. Explicitly omitting `addEventListener('fetch', ...)` so this SW
// truly stays out of the request path.

// Service worker — deliberate passthrough. Version: 2026-09-11-visittype-rename
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

// Also honor an explicit SKIP_WAITING message from the page, so a waiting
// SW takes over the moment the page detects it (see index.html registration).
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Purge every existing Cache Storage entry left behind by any prior SW
    // version (both this pass-through file's older revs and the pre-2026-09-08
    // caching SW). Anything that was misrouted or stale gets wiped.
    const keys = await caches.keys()
    await Promise.all(keys.map(k => caches.delete(k)))
    await self.clients.claim()
    // Force every open tab to reload once the new SW takes over. Without this
    // reload, an open tab keeps its already-parsed JS bundle in memory and
    // won't see code changes until the user manually refreshes — the entire
    // reason we ended up here.
    const clients = await self.clients.matchAll({ type: 'window' })
    for (const client of clients) {
      try { client.navigate(client.url) } catch { /* some browsers block navigate */ }
    }
  })())
})

// No fetch handler = the browser handles every request normally, no interception,
// no caching. Explicitly omitting `addEventListener('fetch', ...)` so this SW
// truly stays out of the request path.

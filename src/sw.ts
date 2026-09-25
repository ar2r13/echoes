const cache = 'mirror-v1'
const shell = ['/', '/index.js', '/index.css', '/manifest.json', '/favicon.svg']

self.addEventListener('install', event => {
	event.waitUntil(caches.open(cache).then(storage => storage.addAll(shell)))
})

self.addEventListener('activate', event => {
	event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cache).map(key => caches.delete(key)))))
})

self.addEventListener('fetch', event => {
	if (event.request.method !== 'GET') return

	event.respondWith(fetch(event.request).then(response => {
		const copy = response.clone()
		void caches.open(cache).then(storage => storage.put(event.request, copy))

		return response
	}).catch(() => caches.match(event.request).then(response => response ?? caches.match('/'))))
})

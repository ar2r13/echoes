const cache = `auto-playback-${__VERSION__}`
const shell = ['/', '/index.js', '/index.css', '/manifest.json', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png', '/hat.wav']

self.addEventListener('install', event => {
	event.waitUntil(caches.open(cache).then(storage => storage.addAll(shell)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
	event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cache).map(key => caches.delete(key)))).then(() => clients.claim()))
})

self.addEventListener('fetch', event => {
	const url = new URL(event.request.url)
	if (event.request.method !== 'GET' || url.origin !== location.origin) return

	event.respondWith(fetch(event.request).then(response => {
		if (response.ok) event.waitUntil(caches.open(cache).then(storage => storage.put(event.request, response.clone())))

		return response
	}).catch(async () => {
		const response = await caches.match(event.request)
		if (response) return response
		if (event.request.mode === 'navigate') return await caches.match('/') ?? Response.error()
		return Response.error()
	}))
})

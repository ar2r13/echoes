import './style.css'
import './app.ts'

if ('serviceWorker' in navigator) {
	const controlled = Boolean(navigator.serviceWorker.controller)
	window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }))
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (controlled) location.reload()
	})
}

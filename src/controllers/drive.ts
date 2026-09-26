import { Signal } from '@lit-labs/signals'
import { recordings, type Recording } from './recordings.ts'

export type SyncPhase = 'off' | 'signing' | 'idle' | 'syncing'

type Stored = { account : string, wifiOnly : boolean, syncedAt : number }
type Token = { value : string, expires : number }
type DriveFile = { id : string, name : string, mimeType : string, appProperties? : Record<string, string> }

// The same Google OAuth client as Ornithology and Loopscribe, so it is one app to the person's Google account.
const client = '796743385947-shne49ojkthlsbtnnusobb5m5qf2sdgc.apps.googleusercontent.com'
// The app's own hidden folder on the person's Drive: the app sees nothing else there, and nobody sees it in Drive.
const scope = 'https://www.googleapis.com/auth/drive.appdata'
const api = 'https://www.googleapis.com/drive/v3'
const upload = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id'
const settingsKey = 'drive-sync'
const tokenKey = 'drive-token'
// Long enough for Undo to win over a deletion, short enough that a take is backed up soon after it is saved.
const delay = 5000

class AuthError extends Error {}

// A take's details travel as the Drive file's appProperties, so one listing tells a device everything
// it needs. Peaks become one base-36 digit each to fit the 124-byte limit of a property.
const describe = (recording : Recording) => ({
	recording: recording.id,
	name: recording.name,
	created: String(recording.created),
	duration: recording.duration.toFixed(3),
	bpm: String(recording.bpm),
	peaks: recording.peaks.map(value => Math.round(Math.min(1, Math.max(0, value)) * 35).toString(36)).join('')
})

const read = (file : DriveFile) : Recording | null => {
	const details = file.appProperties
	if (!details?.recording) return null

	return {
		id: details.recording,
		name: details.name ?? 'Take',
		file: file.name,
		created: Number(details.created) || 0,
		duration: Number(details.duration) || 0,
		bpm: Number(details.bpm) || 0,
		peaks: [...details.peaks ?? ''].map(digit => parseInt(digit, 36) / 35),
		sync: 'cloud',
		drive: file.id
	}
}

const script = () => new Promise<void>((resolve, reject) => {
	if (window.google?.accounts?.oauth2) return resolve()
	const element = document.createElement('script')
	element.src = 'https://accounts.google.com/gsi/client'
	element.async = true
	element.onload = () => resolve()
	element.onerror = () => {
		element.remove()
		reject(new Error('Google sign-in did not load'))
	}
	document.head.append(element)
})

// Backs recordings up to Google Drive and brings other devices' takes in. Everything runs in the
// browser with a short-lived token from Google Identity Services; there is no server.
class DriveController {
	readonly phase = new Signal.State<SyncPhase>('off')
	readonly progress = new Signal.State({ done: 0, total: 0 })
	readonly account = new Signal.State('')
	readonly syncedAt = new Signal.State(0)
	// Why the last run stopped short, if it did.
	readonly problem = new Signal.State<'' | 'signin' | 'offline' | 'wifi'>('')
	readonly downloads = new Signal.State<ReadonlyMap<string, number>>(new Map())

	#wifiOnly = new Signal.State(true)
	#token : Token | null = null
	#script : Promise<void> | null = null
	#client : google.accounts.oauth2.TokenClient | null = null
	#asking : { resolve : (token : string) => void, reject : (error : Error) => void } | null = null
	#run : Promise<void> | null = null
	#again = false
	#abort : AbortController | null = null
	#fetches = new Map<string, AbortController>()
	#timer = 0
	#attempt = 0

	constructor () {
		try {
			const stored = JSON.parse(localStorage.getItem(settingsKey) ?? 'null') as Stored | null
			if (stored?.account) {
				this.account.set(stored.account)
				this.#wifiOnly.set(stored.wifiOnly)
				this.syncedAt.set(stored.syncedAt)
				this.phase.set('idle')
			}
			const token = JSON.parse(localStorage.getItem(tokenKey) ?? 'null') as Token | null
			if (token && token.expires > Date.now()) this.#token = token
		} catch {
			// Unreadable settings count as sync off.
		}

		recordings.addEventListener('change', () => this.schedule())
		window.addEventListener('online', () => this.schedule(0))
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible' && Date.now() - this.syncedAt.get() > 60_000) this.schedule(0)
		})
		navigator.connection?.addEventListener('change', () => this.schedule(0))
		this.schedule(0)
	}

	get enabled () {
		return this.phase.get() !== 'off' && this.phase.get() !== 'signing'
	}

	get wifiOnly () {
		return this.#wifiOnly.get()
	}

	set wifiOnly (value : boolean) {
		this.#wifiOnly.set(value)
		this.#store()
		this.schedule(0)
	}

	// Loads Google's sign-in script ahead of the tap, so the sign-in window still counts as opened by that tap.
	prepare () {
		return this.#script ??= script().catch(error => {
			this.#script = null
			throw error
		})
	}

	// Call from a tap: the sign-in window is blocked otherwise.
	async connect () {
		if (this.phase.get() !== 'off') return

		const attempt = ++this.#attempt
		this.phase.set('signing')
		try {
			const token = await this.#authorize(true)
			const about = await this.#json<{ user : { emailAddress : string } }>(`${api}/about?fields=user(emailAddress)`, token)
			if (attempt !== this.#attempt) return

			// Takes restored from an earlier backup match by id, so nothing is uploaded twice.
			this.account.set(about.user.emailAddress)
			this.phase.set('idle')
			this.#store()
			await this.sync(true)
		} catch {
			if (attempt === this.#attempt) this.phase.set('off')
		}
	}

	// Stops waiting for a sign-in the person gave up on. Google's window cannot be closed from here.
	cancel () {
		if (this.phase.get() !== 'signing') return

		this.#attempt++
		this.#asking?.reject(new Error('Cancelled'))
		this.#asking = null
		this.phase.set('off')
	}

	async disconnect () {
		this.#attempt++
		clearTimeout(this.#timer)
		this.#abort?.abort()
		for (const controller of this.#fetches.values()) controller.abort()
		const token = this.#token?.value
		if (token) window.google?.accounts.oauth2.revoke(token, () => {})

		this.#token = null
		this.account.set('')
		this.syncedAt.set(0)
		this.problem.set('')
		this.phase.set('off')
		localStorage.removeItem(settingsKey)
		localStorage.removeItem(tokenKey)
		await this.#run?.catch(() => {})
		await recordings.detach()
	}

	schedule (wait = delay) {
		if (!this.enabled) return

		clearTimeout(this.#timer)
		this.#timer = window.setTimeout(() => void this.sync(false), wait)
	}

	// `asked` is true when the person tapped Sync now: it may open Google's sign-in and ignores Wi‑Fi only.
	sync (asked : boolean) : Promise<void> {
		if (!this.enabled) return Promise.resolve()

		clearTimeout(this.#timer)
		if (this.#run) {
			// Something changed while a run was going: one more pass afterwards picks it up.
			this.#again = true
			return this.#run
		}

		// Ask for the token first, before any await, while the tap still counts.
		const token = this.#authorize(asked)
		this.#abort = new AbortController()
		const signal = this.#abort.signal
		this.#run = this.#pass(token, asked, signal).finally(() => {
			this.#run = null
			this.#abort = null
			if (this.phase.get() === 'syncing') this.phase.set('idle')
			if (this.#again && !signal.aborted) {
				this.#again = false
				this.schedule(0)
			}
		})
		return this.#run
	}

	stop () {
		this.#again = false
		this.#abort?.abort()
	}

	// Brings one take that is only on Drive onto this device. Call from a tap, like sync.
	async download (recording : Recording) {
		if (recording.sync !== 'cloud' || !recording.drive || this.#fetches.has(recording.id)) return

		const token = this.#authorize(true)
		const controller = new AbortController()
		this.#fetches.set(recording.id, controller)
		this.#setDownload(recording.id, 0)
		try {
			const response = await this.#request(`${api}/files/${recording.drive}?alt=media`, await token, { signal: controller.signal })
			const total = Number(response.headers.get('content-length')) || 0
			const reader = response.body!.getReader()
			const chunks : Uint8Array[] = []
			let received = 0
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				chunks.push(value)
				received += value.length
				if (total) this.#setDownload(recording.id, received / total)
			}
			const type = response.headers.get('content-type')?.split(';')[0] ?? ''
			await recordings.store(recording.id, new Blob(chunks as BlobPart[], { type }))
		} catch (error) {
			if (error instanceof AuthError) this.problem.set('signin')
			if (!controller.signal.aborted) throw error
		} finally {
			this.#fetches.delete(recording.id)
			this.#setDownload(recording.id, -1)
		}
	}

	cancelDownload (recording : Recording) {
		this.#fetches.get(recording.id)?.abort()
	}

	async #pass (token : Promise<string>, asked : boolean, signal : AbortSignal) {
		if (!asked && this.wifiOnly && navigator.connection?.type === 'cellular') {
			void token.catch(() => {})
			this.problem.set('wifi')
			return
		}
		if (!navigator.onLine) {
			void token.catch(() => {})
			this.problem.set('offline')
			return
		}

		this.phase.set('syncing')
		this.progress.set({ done: 0, total: 0 })
		try {
			await this.#exchange(await token, signal)
			this.problem.set('')
			this.syncedAt.set(Date.now())
			this.#store()
		} catch (error) {
			if (signal.aborted) return
			this.problem.set(error instanceof AuthError ? 'signin' : 'offline')
		}
	}

	async #exchange (token : string, signal : AbortSignal) {
		await recordings.ready
		// Signed in again as someone else: what this device knows about Drive belongs to the other account.
		const about = await this.#json<{ user : { emailAddress : string } }>(`${api}/about?fields=user(emailAddress)`, token, { signal })
		if (about.user.emailAddress !== this.account.get()) {
			await recordings.detach()
			this.account.set(about.user.emailAddress)
			this.#store()
		}

		const files = await this.#list(token, signal)
		const remote = new Map(files.map(file => [file.id, file]))

		// Deleted here: delete there too.
		for (const removal of [...recordings.removed]) {
			if (remote.has(removal.drive)) await this.#delete(removal.drive, token, signal)
			remote.delete(removal.drive)
			await recordings.forget(removal.drive)
		}

		// Deleted on another device: gone here as well.
		await recordings.drop(recordings.list.get().filter(item => item.drive && !remote.has(item.drive)).map(item => item.id))

		// Backed up from another device: listed here, downloaded when played.
		const incoming = [...remote.values()].map(read).filter(item => item !== null)
		const known = new Map(recordings.list.get().map(item => [item.id, item]))
		// An upload whose answer never arrived is already there: take it as uploaded.
		for (const item of incoming) {
			const local = known.get(item.id)
			if (local && !local.sync) await recordings.mark(item.id, { sync: 'synced', drive: item.drive })
		}
		await recordings.adopt(incoming)

		const pending = recordings.list.get().filter(item => !item.sync)
		this.progress.set({ done: 0, total: pending.length })
		for (const [index, item] of pending.entries()) {
			signal.throwIfAborted()
			let blob : Blob
			try {
				blob = await recordings.open(item)
			} catch {
				continue
			}
			const id = await this.#upload(item, blob, token, signal)
			// Deleted while it was uploading: take it back off Drive.
			if (!await recordings.mark(item.id, { sync: 'synced', drive: id })) await this.#delete(id, token, signal)
			this.progress.set({ done: index + 1, total: pending.length })
		}
	}

	async #list (token : string, signal : AbortSignal) {
		const files : DriveFile[] = []
		let page = ''
		do {
			const query = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,mimeType,appProperties)' })
			if (page) query.set('pageToken', page)
			const result = await this.#json<{ files : DriveFile[], nextPageToken? : string }>(`${api}/files?${query}`, token, { signal })
			files.push(...result.files)
			page = result.nextPageToken ?? ''
		} while (page)

		return files
	}

	async #upload (recording : Recording, blob : Blob, token : string, signal : AbortSignal) {
		const body = new FormData()
		body.append('metadata', new Blob([JSON.stringify({ name: recording.file, parents: ['appDataFolder'], appProperties: describe(recording) })], { type: 'application/json' }))
		body.append('file', blob)
		const result = await this.#json<{ id : string }>(upload, token, { method: 'POST', body, signal })

		return result.id
	}

	async #delete (id : string, token : string, signal : AbortSignal) {
		try {
			await this.#request(`${api}/files/${id}`, token, { method: 'DELETE', signal })
		} catch (error) {
			// Already gone is as good as deleted.
			if (!(error instanceof Error && error.message === '404')) throw error
		}
	}

	async #json<T> (url : string, token : string, init? : RequestInit) {
		return await (await this.#request(url, token, init)).json() as T
	}

	async #request (url : string, token : string, init : RequestInit = {}) {
		const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}` } })
		if (response.status === 401) {
			this.#token = null
			localStorage.removeItem(tokenKey)
			throw new AuthError('Signed out')
		}
		if (!response.ok) throw new Error(String(response.status))

		return response
	}

	// Resolves to a valid token. Without one it opens Google's window, but only when `interactive`,
	// because a window nobody tapped for is blocked.
	#authorize (interactive : boolean) : Promise<string> {
		const token = this.#token
		if (token && token.expires - 60_000 > Date.now()) return Promise.resolve(token.value)
		if (!interactive) return Promise.reject(new AuthError('Sign-in needed'))
		if (!window.google?.accounts?.oauth2) return this.prepare().then(() => this.#authorize(true))

		this.#asking?.reject(new Error('Superseded'))
		return new Promise((resolve, reject) => {
			this.#asking = { resolve, reject }
			this.#client ??= google.accounts.oauth2.initTokenClient({
				client_id: client,
				scope,
				callback: response => {
					const asking = this.#asking
					this.#asking = null
					if (!response.access_token) return asking?.reject(new AuthError(response.error ?? 'Not allowed'))

					// Kept across reloads for its hour, so a backup can carry on without asking again.
					// It only reaches this app's own Drive folder.
					this.#token = { value: response.access_token, expires: Date.now() + Number(response.expires_in) * 1000 }
					localStorage.setItem(tokenKey, JSON.stringify(this.#token))
					this.problem.set('')
					asking?.resolve(response.access_token)
				},
				error_callback: error => {
					this.#asking?.reject(new Error(error.type))
					this.#asking = null
				}
			})
			const hint = this.account.get()
			this.#client.requestAccessToken(hint ? { prompt: '', login_hint: hint } : {})
		})
	}

	#setDownload (id : string, progress : number) {
		const next = new Map(this.downloads.get())
		if (progress < 0) next.delete(id)
		else next.set(id, progress)
		this.downloads.set(next)
	}

	#store () {
		const stored : Stored = { account: this.account.get(), wifiOnly: this.wifiOnly, syncedAt: this.syncedAt.get() }
		localStorage.setItem(settingsKey, JSON.stringify(stored))
	}
}

export const drive = new DriveController()

import { Signal } from '@lit-labs/signals'

// `sync` is absent while a take lives only on this device, 'synced' once it is on this device and
// on Google Drive, and 'cloud' for one another device backed up that has not been downloaded here.
// `drive` is its file id on Drive.
export type Recording = { id : string, name : string, file : string, created : number, duration : number, bpm : number, peaks : number[], sync? : 'synced' | 'cloud', drive? : string }

// A take deleted here that still has to be deleted from Drive.
export type Removal = { id : string, drive : string }

const extensions : Record<string, string> = { 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }
const index = 'index.json'
const removals = 'removed.json'

const newest = (a : Recording, b : Recording) => b.created - a.created

// Takes are plain audio files in the origin private file system, with their details in index.json
// beside them. It is site data, not the HTTP cache, so clearing cached files keeps them.
// It fires `change` when the person adds or deletes a take, so a backup can follow.
class RecordingsController extends EventTarget {
	readonly list = new Signal.State<Recording[]>([])

	#removed : Removal[] = []
	#folder : Promise<FileSystemDirectoryHandle> | null = null
	// Index writes run one after another, so a slow one never lands over a newer list.
	#queue : Promise<unknown> = Promise.resolve()
	readonly ready = this.#load()

	get removed () {
		return this.#removed
	}

	async add (blob : Blob, details : Pick<Recording, 'duration' | 'bpm' | 'peaks'>) {
		await this.ready
		const number = Math.max(0, ...this.list.get().map(item => Number(/^Take (\d+)$/.exec(item.name)?.[1] ?? 0))) + 1
		const id = crypto.randomUUID()
		const recording : Recording = { id, name: `Take ${number}`, file: `${id}.${extensions[blob.type.split(';')[0]] ?? 'audio'}`, created: Date.now(), ...details }
		await this.#write(recording.file, blob)
		await this.#save([recording, ...this.list.get()])
		// Without this the browser may evict them when the disk runs low. Clearing site data still removes them.
		void navigator.storage.persist?.().catch(() => {})
		this.dispatchEvent(new Event('change'))

		return recording
	}

	async open (recording : Recording) {
		const folder = await this.#open()
		return await (await folder.getFileHandle(recording.file)).getFile()
	}

	// Returns the audio held in memory, so an undo can write it back. A take only on Drive has none.
	async remove (recording : Recording) {
		await this.ready
		let blob : Blob | null = null
		if (recording.sync !== 'cloud') {
			const file = await this.open(recording)
			blob = new Blob([await file.arrayBuffer()], { type: file.type })
		}
		if (recording.drive) await this.#saveRemoved([...this.#removed, { id: recording.id, drive: recording.drive }])
		await this.#save(this.list.get().filter(item => item.id !== recording.id))
		if (blob) await (await this.#open()).removeEntry(recording.file).catch(() => {})
		this.dispatchEvent(new Event('change'))

		return blob
	}

	async restore (recording : Recording, blob : Blob | null) {
		await this.ready
		let restored = recording
		if (recording.drive) {
			// Still waiting to be deleted from Drive: just keep it there. Otherwise it went already,
			// so it goes back up as a new take, or is gone for good if it never was on this device.
			if (this.#removed.some(item => item.drive === recording.drive)) await this.#saveRemoved(this.#removed.filter(item => item.drive !== recording.drive))
			else if (blob) restored = { ...recording, sync: undefined, drive: undefined }
			else return
		}
		if (blob) await this.#write(recording.file, blob)
		await this.#save([...this.list.get().filter(item => item.id !== recording.id), restored].sort(newest))
		this.dispatchEvent(new Event('change'))
	}

	// What a backup learns: takes from other devices, takes deleted elsewhere, uploads and downloads.

	async adopt (items : Recording[]) {
		await this.ready
		const known = new Set(this.list.get().map(item => item.id))
		const fresh = items.filter(item => !known.has(item.id))
		if (fresh.length) await this.#save([...this.list.get(), ...fresh].sort(newest))
	}

	async mark (id : string, patch : Pick<Recording, 'sync' | 'drive'>) {
		await this.ready
		if (!this.list.get().some(item => item.id === id)) return false
		await this.#save(this.list.get().map(item => item.id === id ? { ...item, ...patch } : item))
		return true
	}

	async store (id : string, blob : Blob) {
		await this.ready
		const recording = this.list.get().find(item => item.id === id)
		if (!recording) return
		await this.#write(recording.file, blob)
		await this.mark(id, { sync: 'synced' })
	}

	async drop (ids : string[]) {
		await this.ready
		const gone = this.list.get().filter(item => ids.includes(item.id))
		if (!gone.length) return
		await this.#save(this.list.get().filter(item => !ids.includes(item.id)))
		const folder = await this.#open()
		await Promise.all(gone.filter(item => item.sync !== 'cloud').map(item => folder.removeEntry(item.file).catch(() => {})))
	}

	async forget (drive : string) {
		await this.#saveRemoved(this.#removed.filter(item => item.drive !== drive))
	}

	// Backup turned off: every take here is only on this device again, and the ones never downloaded go.
	async detach () {
		await this.ready
		await this.#saveRemoved([])
		await this.#save(this.list.get().filter(item => item.sync !== 'cloud').map(({ sync, drive, ...item }) => item))
	}

	#open () {
		return this.#folder ??= navigator.storage.getDirectory().then(root => root.getDirectoryHandle('recordings', { create: true }))
	}

	async #load () {
		try {
			const folder = await this.#open()
			const file = await (await folder.getFileHandle(index)).getFile()
			this.list.set((JSON.parse(await file.text()) as Recording[]).sort(newest))
			this.#removed = JSON.parse(await (await (await folder.getFileHandle(removals)).getFile()).text()) as Removal[]
		} catch {
			// No index yet, or no file system here (some private modes): saving reports it.
		}
	}

	async #save (list : Recording[]) {
		const previous = this.list.get()
		this.list.set(list)
		try {
			await this.#enqueue(index, list)
		} catch (error) {
			this.list.set(previous)
			throw error
		}
	}

	async #saveRemoved (list : Removal[]) {
		this.#removed = list
		await this.#enqueue(removals, list)
	}

	#enqueue (name : string, value : unknown) {
		const write = this.#queue.then(() => this.#write(name, new Blob([JSON.stringify(value)], { type: 'application/json' })))
		this.#queue = write.catch(() => {})
		return write
	}

	async #write (name : string, blob : Blob) {
		const folder = await this.#open()
		const writable = await (await folder.getFileHandle(name, { create: true })).createWritable()
		await writable.write(blob)
		await writable.close()
	}
}

export const recordings = new RecordingsController()

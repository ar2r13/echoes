import { Signal } from '@lit-labs/signals'

export type Recording = { id : string, name : string, file : string, created : number, duration : number, bpm : number, peaks : number[] }

const extensions : Record<string, string> = { 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }
const index = 'index.json'

const newest = (a : Recording, b : Recording) => b.created - a.created

// Takes are plain audio files in the origin private file system, with their details in index.json
// beside them. It is site data, not the HTTP cache, so clearing cached files keeps them.
class RecordingsController {
	readonly list = new Signal.State<Recording[]>([])

	#folder : Promise<FileSystemDirectoryHandle> | null = null
	// Index writes run one after another, so a slow one never lands over a newer list.
	#queue : Promise<unknown> = Promise.resolve()
	#ready = this.#load()

	async add (blob : Blob, details : Pick<Recording, 'duration' | 'bpm' | 'peaks'>) {
		await this.#ready
		const number = Math.max(0, ...this.list.get().map(item => Number(/^Take (\d+)$/.exec(item.name)?.[1] ?? 0))) + 1
		const id = crypto.randomUUID()
		const recording : Recording = { id, name: `Take ${number}`, file: `${id}.${extensions[blob.type.split(';')[0]] ?? 'audio'}`, created: Date.now(), ...details }
		await this.#write(recording.file, blob)
		await this.#save([recording, ...this.list.get()])
		// Without this the browser may evict them when the disk runs low. Clearing site data still removes them.
		void navigator.storage.persist?.().catch(() => {})

		return recording
	}

	async open (recording : Recording) {
		const folder = await this.#open()
		return await (await folder.getFileHandle(recording.file)).getFile()
	}

	// Returns the audio held in memory, so an undo can write it back.
	async remove (recording : Recording) {
		await this.#ready
		const file = await this.open(recording)
		const blob = new Blob([await file.arrayBuffer()], { type: file.type })
		await this.#save(this.list.get().filter(item => item.id !== recording.id))
		await (await this.#open()).removeEntry(recording.file).catch(() => {})

		return blob
	}

	async restore (recording : Recording, blob : Blob) {
		await this.#ready
		await this.#write(recording.file, blob)
		await this.#save([...this.list.get().filter(item => item.id !== recording.id), recording].sort(newest))
	}

	#open () {
		return this.#folder ??= navigator.storage.getDirectory().then(root => root.getDirectoryHandle('recordings', { create: true }))
	}

	async #load () {
		try {
			const folder = await this.#open()
			const file = await (await folder.getFileHandle(index)).getFile()
			this.list.set((JSON.parse(await file.text()) as Recording[]).sort(newest))
		} catch {
			// No index yet, or no file system here (some private modes): saving reports it.
		}
	}

	async #save (list : Recording[]) {
		const previous = this.list.get()
		this.list.set(list)
		const write = this.#queue.then(() => this.#write(index, new Blob([JSON.stringify(list)], { type: 'application/json' })))
		this.#queue = write.catch(() => {})
		try {
			await write
		} catch (error) {
			this.list.set(previous)
			throw error
		}
	}

	async #write (name : string, blob : Blob) {
		const folder = await this.#open()
		const writable = await (await folder.getFileHandle(name, { create: true })).createWritable()
		await writable.write(blob)
		await writable.close()
	}
}

export const recordings = new RecordingsController()

import { Signal } from '@lit-labs/signals'

export type MirrorStatus = 'idle' | 'requesting' | 'arming' | 'recording' | 'playing' | 'error'
export type ClickSound = 'click' | 'woodblock' | 'hihat'
type Settings = { bpm : number, defaultBpm? : number, silenceBeats : number, threshold : number, sound : ClickSound, volume : number, metronomeVolume? : number, bufferSeconds? : number, input? : string }
// `onset` is where the first note sits in `buffer`. When `grid` is set, sample 0 of `buffer`
// is a metronome beat as it reached the mic, so starting it on a beat keeps it in time.
export type Phrase = { buffer : AudioBuffer, peaks : number[], duration : number, onset : number, grid : boolean }

const peakCount = 48
export const bufferOptions = [30, 60, 120, 300]
const recordingWarningSeconds = 30
// The ring holds a little more than the longest take, for the preroll before its first note.
const ringMargin = 1
const preroll = .25
const tail = .35
const lead = .05
// How far after each click we look for its echo in the mic, and how much of it we cancel.
const echoWindow = .5
const echoLength = .09
const echoPre = .005
const echoDepth = 24
// Phones deliver mic audio with a delay that wanders by a few milliseconds from click to click,
// so the round trip comes from the loudness envelope and each click is found again on its own.
const echoBin = .001
const echoJitter = .012
const alignLength = .02
const settingsKey = 'echo-settings'
// First one the browser can record wins: Opus where possible, AAC on Safari.
const recorderTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
const microphone = { autoGainControl: false, echoCancellation: false, noiseSuppression: false }

// Loudest sample in each of `peakCount` slices, scaled so the loudest slice is 1.
const measure = (samples : Float32Array) => {
	const size = Math.max(1, Math.floor(samples.length / peakCount))
	const peaks = Array.from({ length: peakCount }, (_, index) => {
		let peak = 0
		for (let at = index * size; at < Math.min(samples.length, (index + 1) * size); at++) peak = Math.max(peak, Math.abs(samples[at]))
		return peak
	})
	const top = Math.max(...peaks) || 1

	return peaks.map(value => value / top)
}

// 16-bit mono WAV, so a phrase saves exactly as it was heard.
export const wav = (buffer : AudioBuffer) => {
	const samples = buffer.getChannelData(0)
	const rate = buffer.sampleRate
	const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
	const text = (at : number, value : string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)))
	text(0, 'RIFF')
	view.setUint32(4, 36 + samples.length * 2, true)
	text(8, 'WAVEfmt ')
	view.setUint32(16, 16, true)
	view.setUint16(20, 1, true)
	view.setUint16(22, 1, true)
	view.setUint32(24, rate, true)
	view.setUint32(28, rate * 2, true)
	view.setUint16(32, 2, true)
	view.setUint16(34, 16, true)
	text(36, 'data')
	view.setUint32(40, samples.length * 2, true)
	samples.forEach((value, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, value)) * 0x7fff, true))

	return new Blob([view], { type: 'audio/wav' })
}

// Posts mono mic blocks tagged with the context frame they were rendered at,
// so every recorded sample has an exact position on the metronome's clock.
const tapSource = `
class EchoTap extends AudioWorkletProcessor {
	constructor () {
		super()
		this.block = new Float32Array(512)
		this.fill = 0
		this.start = 0
	}

	process (inputs) {
		const channel = inputs[0] && inputs[0][0]
		if (!channel) return true
		// A skipped quantum would shift everything after it; start a fresh block instead.
		if (this.fill && currentFrame !== this.start + this.fill) this.fill = 0
		if (!this.fill) this.start = currentFrame
		this.block.set(channel, this.fill)
		this.fill += channel.length
		if (this.fill >= this.block.length) {
			this.port.postMessage({ frame: this.start, data: this.block }, [this.block.buffer])
			this.block = new Float32Array(512)
			this.fill = 0
		}
		return true
	}
}
registerProcessor('echo-tap', EchoTap)
`

class AudioController {
	readonly status = new Signal.State<MirrorStatus>('idle')
	readonly level = new Signal.State(0)
	readonly transport = new Signal.State(false)
	readonly tempoVersion = new Signal.State(0)
	readonly phrase = new Signal.State<Phrase | null>(null)
	readonly error = new Signal.State('')
	readonly mic = new Signal.State(false)
	readonly beat = new Signal.State(0)
	readonly recordingSecondsLeft = new Signal.State(0)
	// Taps in the current tap-tempo run; drops to 0 once the run times out.
	readonly taps = new Signal.State(0)
	// Every tap ever, so the UI can restart its press animation.
	readonly tapped = new Signal.State(0)
	// When the plain recorder started (performance.now()), or 0 while it is off.
	readonly recorder = new Signal.State(0)
	// Id of the saved recording playing now.
	readonly saved = new Signal.State<string | null>(null)
	// Microphones the browser reports; their labels stay empty until mic access is granted.
	readonly inputs = new Signal.State<{ id : string, label : string }[]>([])

	bpm = 60
	#defaultBpm = 60
	#silenceBeats = 2
	#threshold = .055
	#sound : ClickSound = 'click'
	#volume = .8
	#metronomeVolume = 1
	#bufferSeconds = 120
	#device = ''

	#context : AudioContext | null = null
	#stream : MediaStream | null = null
	#input : MediaStreamAudioSourceNode | null = null
	#tap : AudioWorkletNode | null = null
	#sink : GainNode | null = null
	#tapReady : Promise<void> | null = null
	#meter : number | null = null
	#timer : number | null = null
	#nextBeat = 0
	#origin = 0
	#clicks : number[] = []
	#taps : number[] = []
	#tapTimeout : number | null = null
	#ring : Float32Array | null = null
	#rawLevel = 0
	// Level of the room with nothing played, so a very low threshold never mistakes it for playing.
	#floor = 0
	#noteAt = 0
	#firstNote = 0
	// Where recent phrases began inside the beat, as the mic heard them.
	#starts : number[] = []
	#attemptAt = 0
	#soundAt = 0
	#lastSoundAt = 0
	#qualified = false
	#source : AudioBufferSourceNode | null = null
	#gain : GainNode | null = null
	#playStart = 0
	#hat : AudioBuffer | null = null
	#session = 0
	#clickFrames : number[] = []
	#pending : number[] = []
	#firstFrame = -1
	#written = 0
	// Running average of what the mic hears right after each click: the click as it comes
	// back through speakers, room and mic. It gives the exact round trip and a template to cancel.
	#envelope : Float32Array | null = null
	#envelopeCount = 0
	#echoOnset = -1
	#template : Float32Array | null = null
	#templateCount = 0
	#recording : { recorder : MediaRecorder, chunks : Blob[] } | null = null
	#recorderSession = 0
	#savedSource : AudioBufferSourceNode | null = null
	#savedGain : GainNode | null = null
	#decoded : { id : string, buffer : AudioBuffer } | null = null

	constructor () {
		const stored = localStorage.getItem(settingsKey)
		if (!stored) return

		const settings = JSON.parse(stored) as Settings
		this.bpm = settings.bpm
		this.#defaultBpm = settings.defaultBpm ?? 60
		this.#silenceBeats = settings.silenceBeats
		this.#threshold = settings.threshold
		this.#sound = settings.sound
		this.#volume = settings.volume
		this.#metronomeVolume = settings.metronomeVolume ?? 1
		if (bufferOptions.includes(settings.bufferSeconds!)) this.#bufferSeconds = settings.bufferSeconds!
		this.#device = settings.input ?? ''
	}

	get #constraints () : MediaTrackConstraints {
		return this.#device ? { ...microphone, deviceId: { ideal: this.#device } } : microphone
	}

	// Id of the chosen microphone, or '' for the system default.
	get input () {
		return this.#device
	}

	set input (id : string) {
		if (id === this.#device) return
		this.#device = id
		this.#saveSettings()
		// A running Auto Playback reopens on the new microphone.
		if (this.mirrorRunning) {
			this.stopMirror()
			void this.startMirror()
		}
	}

	async listInputs () {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices()
			this.inputs.set(devices.filter(device => device.kind === 'audioinput' && device.deviceId).map(device => ({ id: device.deviceId, label: device.label })))
		} catch {
			this.inputs.set([])
		}
	}

	get mirrorRunning () {
		return this.mic.get()
	}

	// Longest phrase that can be captured. The mic's ring buffer is sized to it.
	get bufferSeconds () {
		return this.#bufferSeconds
	}

	set bufferSeconds (value : number) {
		if (value === this.#bufferSeconds) return
		this.#bufferSeconds = value
		this.#saveSettings()
		if (!this.#ring || !this.#context) return

		// A take in progress lives in the old ring; drop it rather than cut it.
		this.#ring = this.#newRing(this.#context)
		this.#resetAttempt()
	}

	#newRing (context : AudioContext) {
		this.#firstFrame = -1
		this.#pending = []
		return new Float32Array(Math.ceil(context.sampleRate * (this.#bufferSeconds + ringMargin)))
	}

	get beatDuration () {
		return 60 / this.bpm
	}

	get sound () {
		return this.#sound
	}

	set sound (value : ClickSound) {
		if (value === this.#sound) return
		this.#sound = value
		this.#resetEcho()
		this.#saveSettings()
	}

	// Where the reset button takes the tempo.
	get defaultBpm () {
		return this.#defaultBpm
	}

	set defaultBpm (value : number) {
		this.#defaultBpm = Math.min(240, Math.max(30, Math.round(value)))
		this.#saveSettings()
	}

	get silenceBeats () {
		return this.#silenceBeats
	}

	set silenceBeats (value : number) {
		this.#silenceBeats = value
		this.#saveSettings()
	}

	get threshold () {
		return this.#threshold
	}

	set threshold (value : number) {
		this.#threshold = value
		this.#saveSettings()
	}

	// The threshold actually applied: never below what the quiet room already measures.
	get gate () {
		return Math.max(this.threshold, this.#floor * 2.5)
	}

	get volume () {
		return this.#volume
	}

	set volume (value : number) {
		this.#volume = Math.min(1, Math.max(0, value))
		if (this.#gain) this.#gain.gain.value = this.#volume
		if (this.#savedGain) this.#savedGain.gain.value = this.#volume
		this.#saveSettings()
	}

	get metronomeVolume () {
		return this.#metronomeVolume
	}

	set metronomeVolume (value : number) {
		this.#metronomeVolume = Math.min(1, Math.max(0, value))
		this.#saveSettings()
	}

	get progress () {
		const phrase = this.phrase.get()
		if (!this.#source || !this.#context || !phrase) return 0

		return Math.min(1, Math.max(0, (this.#context.currentTime - this.#playStart) / phrase.duration))
	}

	// Output-to-mic round trip. Measured from the metronome's own echo once it is heard.
	// Phones often strip their own speaker from the mic, so without an echo it is learned
	// from where phrases start against the beat (as a position inside the beat, which is all
	// placement needs). The browser's own estimate is the last resort: phones under-report it.
	get latency () {
		const context = this.#context
		if (context && this.#echoOnset >= 0) return this.#echoOnset / context.sampleRate
		if (this.#starts.length) return this.#learned()

		const settings = this.#stream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency? : number }) | undefined
		return (context?.baseLatency || 0) + (context?.outputLatency || 0) + (settings?.latency || 0)
	}

	async startTransport () {
		if (this.transport.get()) return

		const context = await this.#getContext()
		this.transport.set(true)
		this.#nextBeat = this.#origin = context.currentTime + .08
		this.#schedule()
		this.#timer = window.setInterval(() => this.#schedule(), 25)
	}

	stopTransport () {
		if (this.#timer !== null) window.clearInterval(this.#timer)
		this.#timer = null
		this.transport.set(false)
	}

	async startMirror () {
		if (this.mirrorRunning) return

		const session = ++this.#session
		this.#stopPlayback()
		try {
			this.error.set('')
			this.mic.set(true)
			this.status.set('requesting')
			const context = await this.#getContext()
			this.#tapReady ??= context.audioWorklet.addModule(URL.createObjectURL(new Blob([tapSource], { type: 'text/javascript' })))
			const [stream] = await Promise.all([
				navigator.mediaDevices.getUserMedia({ audio: this.#constraints }),
				this.#tapReady
			])
			if (session !== this.#session) {
				stream.getTracks().forEach(track => track.stop())
				return
			}

			this.#stream = stream
			// Device names show up only once the mic is allowed.
			void this.listInputs()
			this.#ring = this.#newRing(context)
			this.#floor = 0
			this.#starts = []
			this.#resetEcho()
			this.#input = context.createMediaStreamSource(stream)
			this.#tap = new AudioWorkletNode(context, 'echo-tap', { channelCount: 1, channelCountMode: 'explicit', numberOfOutputs: 1 })
			this.#tap.port.onmessage = ({ data }) => this.#block(data.frame, data.data)
			// A silent sink keeps the worklet in the rendered graph.
			this.#sink = context.createGain()
			this.#sink.gain.value = 0
			this.#input.connect(this.#tap).connect(this.#sink).connect(context.destination)
			this.#resetAttempt()
			this.status.set('arming')
			this.#watchLevel()
		} catch (error) {
			if (session !== this.#session) return

			this.#fail(error)
			this.#releaseMirror()
		}
	}

	#fail (error : unknown) {
		this.error.set(error instanceof DOMException && error.name === 'NotAllowedError'
			? 'Microphone access is blocked. Allow it in your browser settings.'
			: 'Could not start the microphone. Check your audio device and try again.')
		this.status.set('error')
	}

	// Records the mic as it is, like a voice recorder, until stopRecorder(). Echo stops meanwhile.
	async startRecorder () {
		if (this.recorder.get()) return

		const session = ++this.#recorderSession
		this.stopMirror()
		this.stopSaved()
		this.error.set('')
		this.recorder.set(performance.now())
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: this.#constraints })
			if (session !== this.#recorderSession) {
				stream.getTracks().forEach(track => track.stop())
				return
			}

			const type = recorderTypes.find(type => MediaRecorder.isTypeSupported(type))
			const recorder = new MediaRecorder(stream, type ? { mimeType: type } : {})
			const chunks : Blob[] = []
			recorder.addEventListener('dataavailable', event => chunks.push(event.data))
			recorder.start()
			this.#recording = { recorder, chunks }
			// The clock counts from when the mic actually opened.
			this.recorder.set(performance.now())
		} catch (error) {
			if (session !== this.#recorderSession) return

			this.recorder.set(0)
			this.#fail(error)
		}
	}

	// Stops the recorder and returns the take, or null when nothing was captured.
	async stopRecorder () {
		const recording = this.#recording
		const started = this.recorder.get()
		this.#recorderSession++
		this.#recording = null
		this.recorder.set(0)
		if (!recording) return null

		const { recorder, chunks } = recording
		const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }))
		recorder.stop()
		await stopped
		recorder.stream.getTracks().forEach(track => track.stop())
		const blob = new Blob(chunks, { type: recorder.mimeType })
		if (!blob.size) return null

		try {
			const context = await this.#getContext()
			const buffer = await context.decodeAudioData(await blob.arrayBuffer())
			return { blob, duration: buffer.duration, peaks: measure(buffer.getChannelData(0)) }
		} catch {
			return { blob, duration: (performance.now() - started) / 1000, peaks: [] }
		}
	}

	async playSaved (id : string, load : () => Promise<Blob>) {
		this.stopSaved()
		this.#stopPlayback()
		if (this.status.get() === 'playing') this.status.set(this.#stream ? 'arming' : 'idle')
		this.#resetAttempt()
		this.saved.set(id)
		try {
			const context = await this.#getContext()
			const buffer = this.#decoded?.id === id ? this.#decoded.buffer : await context.decodeAudioData(await (await load()).arrayBuffer())
			this.#decoded = { id, buffer }
			// Another take was started, or this one stopped, while it decoded.
			if (this.saved.get() !== id) return

			const source = context.createBufferSource()
			const gain = context.createGain()
			source.buffer = buffer
			gain.gain.value = this.#volume
			source.connect(gain).connect(context.destination)
			source.addEventListener('ended', () => {
				if (this.#savedSource === source) this.stopSaved()
			}, { once: true })
			source.start()
			this.#savedSource = source
			this.#savedGain = gain
		} catch {
			if (this.saved.get() === id) this.saved.set(null)
		}
	}

	stopSaved () {
		const source = this.#savedSource
		this.#savedSource = null
		this.#savedGain = null
		this.saved.set(null)
		try {
			source?.stop()
		} catch {}
		source?.disconnect()
	}

	stopMirror () {
		this.#session++
		this.#stopPlayback()
		this.#releaseMirror()
		this.#resetAttempt()
		this.status.set('idle')
		this.level.set(0)
	}

	dispose () {
		this.stopTransport()
		this.stopMirror()
		this.stopSaved()
		void this.stopRecorder()
		void this.#context?.close()
		this.#context = null
		this.#tapReady = null
	}

	setTempo (bpm : number) {
		this.bpm = Math.min(240, Math.max(30, Math.round(bpm)))
		this.tempoVersion.set(this.tempoVersion.get() + 1)
		this.#starts = []
		if (this.transport.get()) this.#origin = this.#nextBeat
		this.#saveSettings()
	}

	#saveSettings () {
		localStorage.setItem(settingsKey, JSON.stringify({
			bpm: this.bpm,
			defaultBpm: this.defaultBpm,
			silenceBeats: this.silenceBeats,
			threshold: this.threshold,
			sound: this.sound,
			volume: this.volume,
			metronomeVolume: this.metronomeVolume,
			bufferSeconds: this.bufferSeconds,
			input: this.#device
		} satisfies Settings))
	}

	tapTempo () {
		const now = performance.now()
		if (!this.#taps.length || now - this.#taps.at(-1)! > 2000) this.#taps = []
		this.#taps.push(now)
		this.#taps = this.#taps.slice(-5)
		this.taps.set(Math.min(this.taps.get() + 1, 4))
		this.tapped.set(this.tapped.get() + 1)
		if (this.#tapTimeout !== null) clearTimeout(this.#tapTimeout)
		this.#tapTimeout = window.setTimeout(() => {
			this.#tapTimeout = null
			this.taps.set(0)
		}, 2000)
		if (this.#taps.length < 2) return

		const duration = this.#taps.at(-1)! - this.#taps[0]
		this.setTempo(60000 * (this.#taps.length - 1) / duration)
	}

	async tick () {
		navigator.vibrate?.(1)
		const context = await this.#getContext()
		const time = context.currentTime + .005
		const oscillator = context.createOscillator()
		const gain = context.createGain()
		oscillator.type = 'sine'
		oscillator.frequency.value = 980
		gain.gain.setValueAtTime(0, time)
		gain.gain.linearRampToValueAtTime(.35 * this.metronomeVolume, time + .002)
		gain.gain.exponentialRampToValueAtTime(.0001, time + .045)
		oscillator.connect(gain).connect(context.destination)
		oscillator.start(time)
		oscillator.stop(time + .05)
	}

	playLast () {
		if (this.status.get() === 'playing') {
			this.#stopPlayback()
			this.status.set(this.#stream ? 'arming' : 'idle')
			return
		}

		const phrase = this.phrase.get()
		if (phrase) void this.#play(phrase)
	}

	async #getContext () {
		this.#context ??= new AudioContext({ latencyHint: 'interactive' })
		if (this.#context.state !== 'running') await this.#context.resume()
		this.#hat ??= await this.#context.decodeAudioData(await (await fetch('/hat.wav')).arrayBuffer())

		return this.#context
	}

	#releaseMirror () {
		if (this.#meter !== null) cancelAnimationFrame(this.#meter)
		this.#stream?.getTracks().forEach(track => track.stop())
		this.#input?.disconnect()
		this.#tap?.disconnect()
		this.#sink?.disconnect()
		if (this.#tap) this.#tap.port.onmessage = null
		this.#meter = null
		this.#stream = null
		this.#input = null
		this.#tap = null
		this.#sink = null
		this.#ring = null
		this.mic.set(false)
	}

	#schedule () {
		const context = this.#context
		if (!context || !this.transport.get()) return

		while (this.#nextBeat < context.currentTime + .12) {
			this.#click(this.#nextBeat, true)
			const delay = Math.max(0, (this.#nextBeat - context.currentTime) * 1000)
			window.setTimeout(() => {
				if (this.transport.get()) this.beat.set(this.beat.get() + 1)
			}, delay)
			this.#nextBeat += this.beatDuration
		}
	}

	#click (at : number, grid : boolean) {
		const context = this.#context
		if (!context) return

		// Clicks start on whole frames so every one sounds identical and its echo can be averaged.
		const frame = Math.round(at * context.sampleRate)
		const time = frame / context.sampleRate
		if (grid) {
			this.#clicks.push(time)
			this.#clicks = this.#clicks.filter(click => click > time - 2)
			this.#clickFrames.push(frame)
			this.#clickFrames = this.#clickFrames.filter(click => click > frame - (this.#bufferSeconds + ringMargin) * context.sampleRate)
			if (this.#ring) this.#pending.push(frame)
		}

		const gain = context.createGain()
		gain.connect(context.destination)

		if (this.sound === 'hihat') {
			const source = context.createBufferSource()
			source.buffer = this.#hat
			gain.gain.setValueAtTime(this.metronomeVolume, time)
			source.connect(gain)
			source.start(time)

			return
		}

		const woodblock = this.sound === 'woodblock'
		const oscillator = context.createOscillator()
		oscillator.type = woodblock ? 'triangle' : 'sine'
		oscillator.frequency.value = woodblock ? 1250 : 980
		gain.gain.setValueAtTime(0, time)
		gain.gain.linearRampToValueAtTime((woodblock ? .9 : 1) * this.metronomeVolume, time + .002)
		gain.gain.exponentialRampToValueAtTime(.0001, time + (woodblock ? .03 : .045))
		oscillator.connect(gain)
		oscillator.start(time)
		oscillator.stop(time + .05)
	}

	#watchLevel () {
		const sample = () => {
			if (!this.#stream) return

			this.level.set(Math.min(1, this.#rawLevel / .35))
			this.#meter = requestAnimationFrame(sample)
		}

		this.#meter = requestAnimationFrame(sample)
	}

	#block (frame : number, data : Float32Array) {
		const ring = this.#ring
		const context = this.#context
		if (!ring || !context) return

		const offset = frame % ring.length
		const head = Math.min(data.length, ring.length - offset)
		ring.set(data.subarray(0, head), offset)
		if (head < data.length) ring.set(data.subarray(head), 0)

		if (this.#firstFrame < 0) this.#firstFrame = frame
		this.#written = frame + data.length
		this.#listenEcho(ring, context.sampleRate)

		let sum = 0
		for (const value of data) sum += value * value
		this.#rawLevel = Math.sqrt(sum / data.length)
		this.#trackFloor(this.#rawLevel)
		this.#detect(this.#rawLevel, frame / context.sampleRate, (frame + data.length) / context.sampleRate)
	}

	#resetEcho () {
		this.#envelope = null
		this.#envelopeCount = 0
		this.#echoOnset = -1
		this.#template = null
		this.#templateCount = 0
	}

	// Folds the loudness after every fully captured click into an average envelope, finds
	// where the click comes back, and keeps a click-aligned average of the echo itself.
	#listenEcho (ring : Float32Array, rate : number) {
		const size = Math.round(echoWindow * rate)
		const bin = Math.round(echoBin * rate)
		while (this.#pending.length && this.#pending[0] + size <= this.#written) {
			const click = this.#pending.shift()!
			if (click < this.#firstFrame || click <= this.#written - ring.length) continue
			// Loudness never averages away, so playing would bury the clicks: measure between phrases.
			// Until a first measurement exists, also measure during a take, since with a bad browser
			// estimate the leaking clicks themselves can keep it open.
			const quiet = this.status.get() === 'arming' && !this.#qualified
			if (this.status.get() === 'playing' || this.saved.get() || (!quiet && this.#echoOnset >= 0)) continue

			const envelope = this.#envelope ??= new Float32Array(Math.floor(size / bin))
			const weight = 1 / Math.min(++this.#envelopeCount, echoDepth)
			for (let index = 0; index < envelope.length; index++) {
				let sum = 0
				for (let at = click + index * bin; at < click + (index + 1) * bin; at++) sum += Math.abs(ring[at % ring.length])
				envelope[index] += (sum / bin - envelope[index]) * weight
			}
			if (this.#envelopeCount < 4) continue

			this.#locateEcho(bin, rate)
			if (this.#echoOnset >= 0 && quiet) this.#learnTemplate(ring, click, rate)
		}
	}

	#locateEcho (bin : number, rate : number) {
		const envelope = this.#envelope!
		let peak = 0
		for (const value of envelope) peak = Math.max(peak, value)

		// The click fills a small slice of the window, so the median is the room.
		const noise = Array.from(envelope).sort((a, b) => a - b)[envelope.length >> 1]
		const previous = this.#echoOnset
		if (!peak || peak < noise * 6) {
			this.#echoOnset = -1
		} else {
			this.#echoOnset = envelope.findIndex(value => value - noise >= (peak - noise) * .35) * bin
		}

		// A different round trip (another output, another mic) needs a fresh echo template.
		if (this.#echoOnset < 0 || previous < 0 || Math.abs(this.#echoOnset - previous) > .005 * rate) {
			this.#template = null
			this.#templateCount = 0
		}
	}

	#learnTemplate (ring : Float32Array, click : number, rate : number) {
		const base = click + this.#echoOnset - Math.round(echoPre * rate)
		const read = (at : number) => ring[((at % ring.length) + ring.length) % ring.length]
		const length = Math.round((echoPre + echoLength) * rate)
		if (!this.#template) {
			this.#template = Float32Array.from({ length }, (_, index) => read(base + index))
			this.#templateCount = 1
			return
		}

		const template = this.#template
		const { lag } = this.#align(read, base, rate)
		const weight = 1 / Math.min(++this.#templateCount, 16)
		for (let index = 0; index < length; index++) template[index] += (read(base + lag + index) - template[index]) * weight
	}

	// Finds where the template sits near `base`: a coarse pass on the click's attack, then a fine one.
	#align (read : (at : number) => number, base : number, rate : number) {
		const template = this.#template!
		const reach = Math.round(echoJitter * rate)
		const span = Math.min(template.length, Math.round((echoPre + alignLength) * rate))
		const score = (lag : number) => {
			let dot = 0
			for (let index = 0; index < span; index++) dot += read(base + lag + index) * template[index]
			return dot
		}

		let lag = 0
		let best = -Infinity
		for (let at = -reach; at <= reach; at += 4) {
			const value = score(at)
			if (value > best) {
				best = value
				lag = at
			}
		}
		const coarse = lag
		for (let at = coarse - 3; at <= coarse + 3; at++) {
			const value = score(at)
			if (value > best) {
				best = value
				lag = at
			}
		}

		return { lag }
	}

	// Falls to quiet blocks at once and creeps up slowly, only while waiting for a phrase.
	#trackFloor (level : number) {
		if (this.status.get() !== 'arming' || this.#qualified) return

		this.#floor = !this.#floor || level < this.#floor ? level : this.#floor + (level - this.#floor) * .003
	}

	// Subtracts the echo template at every beat inside the recording, each one found where it
	// actually landed, so the phrase carries only what was played and never doubles the metronome.
	#cancelClicks (samples : Float32Array, from : number, rate : number) {
		const template = this.#template
		if (!template || this.#echoOnset < 0) return

		let power = 0
		for (const value of template) power += value * value
		if (!power) return

		const read = (at : number) => at >= 0 && at < samples.length ? samples[at] : 0
		for (const click of this.#clickFrames) {
			const base = click + this.#echoOnset - Math.round(echoPre * rate) - from
			if (base + template.length <= 0 || base >= samples.length) continue

			const { lag } = this.#align(read, base, rate)
			let dot = 0
			for (let index = 0; index < template.length; index++) dot += read(base + lag + index) * template[index]

			// The template is the click at its usual level, so a real match needs a gain near 1.
			const gain = dot / power
			if (gain < .4 || gain > 1.8) continue

			for (let index = 0; index < template.length; index++) {
				const position = base + lag + index
				if (position >= 0 && position < samples.length) samples[position] -= gain * template[index]
			}
		}
	}

	// Metronome clicks leak into the mic one round trip after they are scheduled.
	#guarded (time : number) {
		const latency = this.latency
		return this.#clicks.some(click => time >= click + latency - .015 && time <= click + latency + .1)
	}

	#detect (level : number, start : number, time : number) {
		const status = this.status.get()
		if (status !== 'arming' && status !== 'recording') return
		// A saved take playing through the speakers is not a phrase.
		if (this.saved.get()) return

		const sounding = level >= this.gate
		const guarded = this.#guarded(time)
		if (sounding) {
			this.#attemptAt ||= start

			if (!guarded) {
				if (!this.#soundAt) {
					this.#soundAt = time
					this.#noteAt = start
				}
				if (time - this.#soundAt >= .065) {
					this.#firstNote ||= this.#noteAt
					this.#qualified = true
					this.#lastSoundAt = time
					if (status !== 'recording') this.status.set('recording')
				}
			} else {
				this.#soundAt = 0
			}
		} else {
			this.#soundAt = 0
			if (this.#attemptAt && !this.#qualified && !guarded && time - this.#attemptAt >= .12) this.#resetAttempt()
		}

		if (this.#qualified) {
			const remaining = this.#bufferSeconds - (time - (this.#firstNote || this.#attemptAt))
			// Short buffers warn for their last third only, so the countdown isn't always on.
			const warning = Math.min(recordingWarningSeconds, this.#bufferSeconds / 3)
			this.recordingSecondsLeft.set(remaining <= warning ? Math.max(0, Math.ceil(remaining)) : 0)
			if (remaining <= 0) {
				this.#finish(time)
				return
			}
			if (time - this.#lastSoundAt >= this.silenceBeats * this.beatDuration) this.#finish(time)
		}
	}

	#resetAttempt () {
		this.#attemptAt = 0
		this.#soundAt = 0
		this.#lastSoundAt = 0
		this.#qualified = false
		this.#noteAt = 0
		this.#firstNote = 0
		this.recordingSecondsLeft.set(0)
		if (this.status.get() === 'recording') this.status.set('arming')
	}

	#finish (time : number) {
		const ring = this.#ring
		const context = this.#context
		if (!ring || !context) return

		const rate = context.sampleRate
		const onset = this.#attemptAt
		const earliest = Math.max(this.#firstFrame, Math.round(time * rate) - ring.length + 1)
		let from = Math.round((onset - preroll) * rate)
		let grid = false
		if (this.transport.get()) {
			if (this.#echoOnset < 0) this.#learnStart(this.#attack(ring, this.#firstNote || onset, rate))

			// Start the take exactly on the beat before the first note, as that beat reached the mic.
			const latency = this.latency
			const beat = this.beatDuration
			const line = this.#origin + Math.floor((onset - preroll - latency - this.#origin) / beat) * beat
			const start = Math.round(line * rate) + Math.round(latency * rate)
			if (start >= earliest) {
				from = start
				grid = true
			}
		}
		from = Math.max(from, earliest)
		let to = Math.round(Math.min(time, this.#lastSoundAt + tail) * rate)
		// A take on the grid also ends on a beat: whole beats from the one before the first note.
		if (grid) {
			const beat = this.beatDuration * rate
			to = Math.min(Math.round(time * rate), from + Math.round(Math.ceil((to - from) / beat) * beat))
		}
		const samples = new Float32Array(Math.max(1, to - from))
		for (let index = 0; index < samples.length; index++) samples[index] = ring[(from + index) % ring.length]
		this.#cancelClicks(samples, from, rate)

		// A take opened by leaking clicks before the echo was measured is empty once they are removed.
		if (!this.#audible(samples)) {
			this.#resetAttempt()
			return
		}

		const buffer = context.createBuffer(1, samples.length, rate)
		buffer.copyToChannel(samples, 0)
		const phrase = { buffer, peaks: measure(samples), duration: buffer.duration, onset: onset - from / rate, grid }

		this.#resetAttempt()
		this.phrase.set(phrase)
		void this.#play(phrase)
	}

	// Pins the first note to the 64-sample window where it crosses the gate.
	#attack (ring : Float32Array, near : number, rate : number) {
		const gate = this.gate
		const center = Math.round(near * rate)
		for (let start = center - 1024; start < center + 512; start += 64) {
			let sum = 0
			for (let index = start; index < start + 64; index++) sum += ring[((index % ring.length) + ring.length) % ring.length] ** 2
			if (Math.sqrt(sum / 64) >= gate) return start / rate
		}

		return near
	}

	#learnStart (note : number) {
		const beat = this.beatDuration
		this.#starts.push((((note - this.#origin) % beat) + beat) % beat)
		this.#starts = this.#starts.slice(-5)
	}

	// Circular mean over the beat, so starts just before and just after it average correctly.
	#learned () {
		const beat = this.beatDuration
		let x = 0
		let y = 0
		for (const start of this.#starts) {
			x += Math.cos(start / beat * 2 * Math.PI)
			y += Math.sin(start / beat * 2 * Math.PI)
		}
		const angle = Math.atan2(y, x)

		return (angle < 0 ? angle + 2 * Math.PI : angle) / (2 * Math.PI) * beat
	}

	#audible (samples : Float32Array) {
		const gate = this.gate
		for (let start = 0; start + 512 <= samples.length; start += 512) {
			let sum = 0
			for (let index = start; index < start + 512; index++) sum += samples[index] * samples[index]
			if (Math.sqrt(sum / 512) >= gate) return true
		}

		return false
	}

	// A take that starts on a beat is started on the next live beat, so everything in it
	// keeps the position against the metronome it was played at.
	async #play (phrase : Phrase) {
		const context = await this.#getContext()
		this.stopSaved()
		this.#stopPlayback()
		this.#resetAttempt()
		this.status.set('playing')

		const now = context.currentTime
		let when = now + lead
		if (this.transport.get() && phrase.grid) {
			const beat = this.beatDuration
			const line = this.#origin + Math.ceil((now + lead - this.#origin) / beat) * beat
			when = Math.round(line * context.sampleRate) / context.sampleRate
		}

		const source = context.createBufferSource()
		const gain = context.createGain()
		source.buffer = phrase.buffer
		gain.gain.value = this.#volume
		source.connect(gain).connect(context.destination)
		source.addEventListener('ended', () => {
			if (this.#source !== source) return

			this.#source = null
			this.#gain = null
			if (this.#stream) this.status.set('arming')
			else if (this.status.get() === 'playing') this.status.set('idle')
		}, { once: true })
		source.start(when)
		this.#source = source
		this.#gain = gain
		this.#playStart = when
	}

	#stopPlayback () {
		const source = this.#source
		this.#source = null
		this.#gain = null
		try {
			source?.stop()
		} catch {}
		source?.disconnect()
	}
}

export const audio = new AudioController()

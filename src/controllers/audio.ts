import { Signal } from '@lit-labs/signals'

export type MirrorStatus = 'idle' | 'requesting' | 'arming' | 'recording' | 'playing' | 'error'
export type ClickSound = 'click' | 'woodblock' | 'hihat'
// `onset` is where the first note sits in `buffer`. When `grid` is set, sample 0 of `buffer`
// is a metronome beat as it reached the mic, so starting it on a beat keeps it in time.
export type Phrase = { buffer : AudioBuffer, peaks : number[], duration : number, onset : number, grid : boolean }

const peakCount = 48
const ringSeconds = 60
const preroll = .25
const tail = .35
const lead = .05
// How far after each click we look for its echo in the mic, and how much of it we cancel.
const echoWindow = .5
const echoLength = .09
const echoPre = .002
const echoDepth = 24

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
	// Taps in the current tap-tempo run; drops to 0 once the run times out.
	readonly taps = new Signal.State(0)
	// Every tap ever, so the UI can restart its press animation.
	readonly tapped = new Signal.State(0)

	bpm = 92
	silenceBeats = 2
	threshold = .055
	#sound : ClickSound = 'click'
	#volume = .8

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
	#attemptAt = 0
	#soundAt = 0
	#lastSoundAt = 0
	#qualified = false
	#source : AudioBufferSourceNode | null = null
	#gain : GainNode | null = null
	#playStart = 0
	#noise : AudioBuffer | null = null
	#session = 0
	#clickFrames : number[] = []
	#pending : number[] = []
	#firstFrame = -1
	#written = 0
	// Running average of what the mic hears right after each click: the click as it comes
	// back through speakers, room and mic. It gives the exact round trip and a template to cancel.
	#echo : Float32Array | null = null
	#echoCount = 0
	#echoStart = -1
	#echoOnset = 0

	get mirrorRunning () {
		return this.mic.get()
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
	}

	get progress () {
		const phrase = this.phrase.get()
		if (!this.#source || !this.#context || !phrase) return 0

		return Math.min(1, Math.max(0, (this.#context.currentTime - this.#playStart) / phrase.duration))
	}

	// Output-to-mic round trip. Measured from the metronome's own echo once it is heard;
	// until then (or with headphones, where nothing leaks) the browser's own estimate.
	get latency () {
		const context = this.#context
		if (context && this.#echoStart >= 0) return this.#echoOnset / context.sampleRate

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
				navigator.mediaDevices.getUserMedia({
					audio: {
						autoGainControl: false,
						echoCancellation: false,
						noiseSuppression: false
					}
				}),
				this.#tapReady
			])
			if (session !== this.#session) {
				stream.getTracks().forEach(track => track.stop())
				return
			}

			this.#stream = stream
			this.#ring = new Float32Array(Math.ceil(context.sampleRate * ringSeconds))
			this.#firstFrame = -1
			this.#floor = 0
			this.#pending = []
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

			this.error.set(error instanceof DOMException && error.name === 'NotAllowedError'
				? 'Microphone access is blocked. Allow it in your browser settings.'
				: 'Could not start the microphone. Check your audio device and try again.')
			this.status.set('error')
			this.#releaseMirror()
		}
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
		void this.#context?.close()
		this.#context = null
		this.#tapReady = null
	}

	setTempo (bpm : number) {
		this.bpm = Math.min(240, Math.max(30, Math.round(bpm)))
		this.tempoVersion.set(this.tempoVersion.get() + 1)
		this.#resetClock()
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
		const context = await this.#getContext()
		this.#click(context.currentTime + .005, false)
	}

	playLast () {
		const phrase = this.phrase.get()
		if (phrase) void this.#play(phrase)
	}

	async #getContext () {
		this.#context ??= new AudioContext({ latencyHint: 'interactive' })
		if (this.#context.state !== 'running') await this.#context.resume()

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

	#resetClock () {
		if (!this.#context || !this.transport.get()) return

		this.#nextBeat = this.#origin = this.#context.currentTime + .08
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
			this.#clickFrames = this.#clickFrames.filter(click => click > frame - ringSeconds * context.sampleRate)
			if (this.#ring) this.#pending.push(frame)
		}

		const gain = context.createGain()
		gain.connect(context.destination)

		if (this.sound === 'hihat') {
			this.#noise ??= this.#createNoise(context)
			const source = context.createBufferSource()
			const filter = context.createBiquadFilter()
			source.buffer = this.#noise
			filter.type = 'highpass'
			filter.frequency.value = 7000
			gain.gain.setValueAtTime(0, time)
			gain.gain.linearRampToValueAtTime(.35, time + .001)
			gain.gain.exponentialRampToValueAtTime(.0001, time + .05)
			source.connect(filter).connect(gain)
			source.start(time)
			source.stop(time + .06)

			return
		}

		const woodblock = this.sound === 'woodblock'
		const oscillator = context.createOscillator()
		oscillator.type = woodblock ? 'triangle' : 'sine'
		oscillator.frequency.value = woodblock ? 1250 : 980
		gain.gain.setValueAtTime(0, time)
		gain.gain.linearRampToValueAtTime(woodblock ? .4 : .28, time + .002)
		gain.gain.exponentialRampToValueAtTime(.0001, time + (woodblock ? .03 : .045))
		oscillator.connect(gain)
		oscillator.start(time)
		oscillator.stop(time + .05)
	}

	#createNoise (context : AudioContext) {
		const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * .06), context.sampleRate)
		const data = buffer.getChannelData(0)
		for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1

		return buffer
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

		// Detection hears the mic with the metronome's own echo removed.
		const heard = this.#removeEcho(data, frame, context.sampleRate)
		let sum = 0
		for (const value of heard) sum += value * value
		this.#rawLevel = Math.sqrt(sum / data.length)
		this.#trackFloor(this.#rawLevel)
		this.#detect(this.#rawLevel, frame / context.sampleRate, (frame + data.length) / context.sampleRate)
	}

	#resetEcho () {
		this.#echo = null
		this.#echoCount = 0
		this.#echoStart = -1
	}

	// Folds the mic audio after every fully captured click into the echo average while
	// nothing else is playing, then finds where the click comes back.
	#listenEcho (ring : Float32Array, rate : number) {
		const size = Math.round(echoWindow * rate)
		let added = false
		while (this.#pending.length && this.#pending[0] + size <= this.#written) {
			const click = this.#pending.shift()!
			if (click < this.#firstFrame || click <= this.#written - ring.length) continue
			if (this.status.get() !== 'arming' || this.#qualified) continue

			const echo = this.#echo ??= new Float32Array(size)
			const weight = 1 / Math.min(++this.#echoCount, echoDepth)
			for (let index = 0; index < size; index++) echo[index] += (ring[(click + index) % ring.length] - echo[index]) * weight
			added = true
		}
		if (added && this.#echoCount >= 4) this.#locateEcho(rate)
	}

	#locateEcho (rate : number) {
		const echo = this.#echo!
		let peak = 0
		for (const value of echo) peak = Math.max(peak, Math.abs(value))

		// Robust noise floor: the click occupies a small slice of the window, so the median ignores it.
		const sample = Array.from({ length: Math.floor(echo.length / 4) }, (_, index) => Math.abs(echo[index * 4])).sort((a, b) => a - b)
		const noise = sample[sample.length >> 1] / .6745
		if (!peak || peak < noise * 20) {
			this.#echoStart = -1
			return
		}

		const onset = echo.findIndex(value => Math.abs(value) >= peak * .35)
		this.#echoOnset = onset
		this.#echoStart = Math.max(0, onset - Math.round(echoPre * rate))
	}

	#removeEcho (data : Float32Array, frame : number, rate : number) {
		if (!this.#echo || this.#echoStart < 0) return data

		const template = this.#echo.subarray(this.#echoStart, Math.min(this.#echo.length, this.#echoStart + Math.round(echoLength * rate)))
		const heard = data.slice()
		for (let index = this.#clickFrames.length - 1; index >= 0; index--) {
			const at = this.#clickFrames[index] + this.#echoStart - frame
			if (at + template.length <= 0) break
			if (at >= heard.length) continue

			for (let position = Math.max(0, at); position < Math.min(heard.length, at + template.length); position++) heard[position] -= template[position - at]
		}

		return heard
	}

	// Falls to quiet blocks at once and creeps up slowly, only while waiting for a phrase.
	#trackFloor (level : number) {
		if (this.status.get() !== 'arming' || this.#qualified) return

		this.#floor = !this.#floor || level < this.#floor ? level : this.#floor + (level - this.#floor) * .003
	}

	// Subtracts the averaged click echo at every beat inside the recording, so the phrase
	// carries only what was played and never doubles the live metronome.
	#cancelClicks (samples : Float32Array, from : number, rate : number) {
		if (!this.#echo || this.#echoStart < 0) return

		const template = this.#echo.subarray(this.#echoStart, Math.min(this.#echo.length, this.#echoStart + Math.round(echoLength * rate)))
		let power = 0
		for (const value of template) power += value * value
		if (!power) return

		for (const click of this.#clickFrames) {
			const at = click + this.#echoStart - from
			if (at + template.length <= 0 || at >= samples.length) continue

			let best = 0
			let shift = 0
			for (let lag = -6; lag <= 6; lag++) {
				let dot = 0
				for (let index = 0; index < template.length; index++) {
					const position = at + lag + index
					if (position >= 0 && position < samples.length) dot += samples[position] * template[index]
				}
				if (dot > best) {
					best = dot
					shift = lag
				}
			}

			// The template is the click at its usual level, so a real match needs a gain near 1.
			const gain = best / power
			if (gain < .4 || gain > 1.8) continue

			for (let index = 0; index < template.length; index++) {
				const position = at + shift + index
				if (position >= 0 && position < samples.length) samples[position] -= gain * template[index]
			}
		}
	}

	// Metronome clicks leak into the mic one round trip after they are scheduled.
	#guarded (time : number) {
		if (this.#echoStart >= 0) return false

		const latency = this.latency
		return this.#clicks.some(click => time >= click + latency - .01 && time <= click + latency + .06)
	}

	#detect (level : number, start : number, time : number) {
		const status = this.status.get()
		if (status !== 'arming' && status !== 'recording') return

		const sounding = level >= this.gate
		const guarded = this.#guarded(time)
		if (sounding) {
			this.#attemptAt ||= start

			if (!guarded) {
				this.#soundAt ||= time
				if (time - this.#soundAt >= .065) {
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

		if (this.#qualified && time - this.#lastSoundAt >= this.silenceBeats * this.beatDuration) this.#finish(time)
	}

	#resetAttempt () {
		this.#attemptAt = 0
		this.#soundAt = 0
		this.#lastSoundAt = 0
		this.#qualified = false
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
		const to = Math.round(Math.min(time, this.#lastSoundAt + tail) * rate)
		const samples = new Float32Array(Math.max(1, to - from))
		for (let index = 0; index < samples.length; index++) samples[index] = ring[(from + index) % ring.length]
		this.#cancelClicks(samples, from, rate)

		const buffer = context.createBuffer(1, samples.length, rate)
		buffer.copyToChannel(samples, 0)
		const phrase = { buffer, peaks: this.#peaks(samples), duration: buffer.duration, onset: onset - from / rate, grid }

		this.#resetAttempt()
		this.phrase.set(phrase)
		void this.#play(phrase)
	}

	#peaks (samples : Float32Array) {
		const size = Math.max(1, Math.floor(samples.length / peakCount))
		const peaks = Array.from({ length: peakCount }, (_, index) => {
			let peak = 0
			for (let at = index * size; at < Math.min(samples.length, (index + 1) * size); at++) peak = Math.max(peak, Math.abs(samples[at]))
			return peak
		})
		const top = Math.max(...peaks) || 1

		return peaks.map(value => value / top)
	}

	// A take that starts on a beat is started on the next live beat, so everything in it
	// keeps the position against the metronome it was played at.
	async #play (phrase : Phrase) {
		const context = await this.#getContext()
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

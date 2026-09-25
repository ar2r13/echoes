import { Signal } from '@lit-labs/signals'

export type MirrorStatus = 'idle' | 'requesting' | 'arming' | 'recording' | 'playing' | 'error'

class AudioController {
	readonly status = new Signal.State<MirrorStatus>('idle')
	readonly level = new Signal.State(0)
	readonly beat = new Signal.State(-1)
	readonly lastClip = new Signal.State<string | null>(null)
	readonly error = new Signal.State('')

	bpm = 92
	beats = 4
	beatUnit = 4
	silenceBeats = 2
	threshold = .055
	clickVolume = .42

	#context : AudioContext | null = null
	#stream : MediaStream | null = null
	#analyser : AnalyserNode | null = null
	#meter : number | null = null
	#timer : number | null = null
	#nextBeat = 0
	#beat = 0
	#recorder : MediaRecorder | null = null
	#chunks : Blob[] = []
	#attemptAt = 0
	#soundAt = 0
	#lastSoundAt = 0
	#qualified = false
	#discard = false
	#player : HTMLAudioElement | null = null
	#session = 0

	get running () {
		return this.status.get() !== 'idle' && this.status.get() !== 'error'
	}

	get beatDuration () {
		return 60 / this.bpm * 4 / this.beatUnit
	}

	async start () {
		if (this.running) return

		const session = ++this.#session
		try {
			this.error.set('')
			this.status.set('requesting')
			this.#context = new AudioContext()
			await this.#context.resume()
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					autoGainControl: false,
					echoCancellation: false,
					noiseSuppression: false
				}
			})
			if (session !== this.#session) {
				stream.getTracks().forEach(track => track.stop())
				return
			}
			this.#stream = stream
			this.#analyser = this.#context.createAnalyser()
			this.#analyser.fftSize = 1024
			this.#context.createMediaStreamSource(this.#stream).connect(this.#analyser)
			this.status.set('arming')
			this.#startMetronome()
			this.#watchLevel()
		} catch (error) {
			if (session !== this.#session) return

			this.error.set(error instanceof DOMException && error.name === 'NotAllowedError'
				? 'Нужен доступ к микрофону. Разрешите его в настройках браузера.'
				: 'Не удалось запустить микрофон. Проверьте аудиоустройство и попробуйте снова.')
			this.status.set('error')
			this.#release()
		}
	}

	stop () {
		this.#session++
		this.#discard = true
		if (this.#recorder?.state === 'recording') this.#recorder.stop()
		this.#player?.pause()
		this.#player = null
		this.#release()
		this.status.set('idle')
		this.level.set(0)
		this.beat.set(-1)
	}

	setTempo (bpm : number) {
		this.bpm = Math.min(240, Math.max(30, Math.round(bpm)))
		this.#resetClock()
	}

	setSignature (beats : number, beatUnit : number) {
		this.beats = beats
		this.beatUnit = beatUnit
		this.#resetClock()
	}

	playLast () {
		const clip = this.lastClip.get()
		if (!clip || this.status.get() === 'playing') return

		void this.#play(clip, Boolean(this.#stream))
	}

	#release () {
		if (this.#timer !== null) window.clearInterval(this.#timer)
		if (this.#meter !== null) cancelAnimationFrame(this.#meter)
		this.#stream?.getTracks().forEach(track => track.stop())
		void this.#context?.close()
		this.#timer = null
		this.#meter = null
		this.#stream = null
		this.#context = null
		this.#analyser = null
		this.#recorder = null
	}

	#startMetronome () {
		if (!this.#context) return

		this.#nextBeat = this.#context.currentTime + .08
		this.#beat = 0
		this.#schedule()
		this.#timer = window.setInterval(() => this.#schedule(), 25)
	}

	#resetClock () {
		if (!this.#context) return

		this.#nextBeat = this.#context.currentTime + .08
		this.#beat = 0
	}

	#schedule () {
		const context = this.#context
		if (!context) return

		while (this.#nextBeat < context.currentTime + .12) {
			const beat = this.#beat
			this.#click(this.#nextBeat, beat === 0)
			window.setTimeout(() => {
				this.beat.set(beat)
			}, Math.max(0, (this.#nextBeat - context.currentTime) * 1000))
			this.#nextBeat += this.beatDuration
			this.#beat = (this.#beat + 1) % this.beats
		}
	}

	#click (time : number, accent : boolean) {
		const context = this.#context
		if (!context) return

		const oscillator = context.createOscillator()
		const gain = context.createGain()
		oscillator.frequency.value = accent ? 1320 : 880
		gain.gain.setValueAtTime(0, time)
		gain.gain.linearRampToValueAtTime(this.clickVolume * (accent ? 1 : .68), time + .002)
		gain.gain.exponentialRampToValueAtTime(.0001, time + .045)
		oscillator.connect(gain).connect(context.destination)
		oscillator.start(time)
		oscillator.stop(time + .05)
	}

	#watchLevel () {
		const analyser = this.#analyser
		if (!analyser) return

		const data = new Float32Array(analyser.fftSize)
		const sample = () => {
			if (!this.#analyser) return

			analyser.getFloatTimeDomainData(data)
			let sum = 0
			for (const value of data) sum += value * value
			const level = Math.sqrt(sum / data.length)
			this.level.set(Math.min(1, level / .35))
			this.#detect(level, performance.now())
			this.#meter = requestAnimationFrame(sample)
		}

		this.#meter = requestAnimationFrame(sample)
	}

	#detect (level : number, now : number) {
		const status = this.status.get()
		if (status === 'playing' || status === 'idle' || status === 'error') return

		const sounding = level >= this.threshold
		if (sounding) {
			if (!this.#soundAt) {
				this.#soundAt = now
			}

			if (!this.#attemptAt) {
				this.#attemptAt = now
				this.#beginRecording()
			}

			if (now - this.#soundAt >= 65) {
				this.#qualified = true
				this.#lastSoundAt = now
				this.status.set('recording')
			}
		} else {
			this.#soundAt = 0
			if (this.#attemptAt && !this.#qualified && now - this.#attemptAt >= 90) this.#discardRecording()
		}

		if (this.#qualified && now - this.#lastSoundAt >= this.silenceBeats * this.beatDuration * 1000) {
			this.#finishRecording()
		}
	}

	#beginRecording () {
		if (!this.#stream || this.#recorder?.state === 'recording') return

		const type = ['audio/webm;codecs=opus', 'audio/mp4'].find(value => MediaRecorder.isTypeSupported(value))
		this.#chunks = []
		this.#discard = false
		this.#recorder = new MediaRecorder(this.#stream, type ? { mimeType: type } : undefined)
		this.#recorder.addEventListener('dataavailable', event => {
			if (event.data.size) this.#chunks.push(event.data)
		})
		this.#recorder.addEventListener('stop', () => this.#recordingStopped())
		this.#recorder.start(100)
	}

	#discardRecording () {
		if (this.#recorder?.state !== 'recording') return

		this.#discard = true
		this.#recorder.stop()
	}

	#finishRecording () {
		if (this.#recorder?.state !== 'recording') return

		this.status.set('playing')
		this.#recorder.stop()
	}

	#recordingStopped () {
		const recorder = this.#recorder
		const discard = this.#discard || !this.#qualified
		this.#attemptAt = 0
		this.#soundAt = 0
		this.#lastSoundAt = 0
		this.#qualified = false
		this.#recorder = null

		if (discard || !recorder || !this.#chunks.length) {
			this.#chunks = []
			if (this.running) this.status.set('arming')
			return
		}

		const old = this.lastClip.get()
		if (old) URL.revokeObjectURL(old)
		const clip = URL.createObjectURL(new Blob(this.#chunks, { type: recorder.mimeType }))
		this.#chunks = []
		this.lastClip.set(clip)
		void this.#play(clip, true)
	}

	async #play (clip : string, resume : boolean) {
		this.status.set('playing')
		this.#player = new Audio(clip)
		this.#player.addEventListener('ended', () => {
			this.#player = null
			this.status.set(resume && this.#stream ? 'arming' : 'idle')
		}, { once: true })

		try {
			await this.#player.play()
		} catch {
			this.#player = null
			this.status.set(resume && this.#stream ? 'arming' : 'idle')
		}
	}
}

export const audio = new AudioController()

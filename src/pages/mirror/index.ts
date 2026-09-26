import { SignalWatcher } from '@lit-labs/signals'
import { LitElement, html } from 'lit'
import { customElement } from 'lit/decorators.js'
import { keyed } from 'lit/directives/keyed.js'
import { audio, type ClickSound } from '../../controllers/audio.ts'
import '../../components/bpm-wheel.ts'

type Mode = 'off' | 'listen' | 'repeat'

const endings = [{ beats: 2, label: '2 beats' }, { beats: 4, label: '1 bar' }, { beats: 8, label: '2 bars' }]
const sounds : { value : ClickSound, label : string }[] = [{ value: 'click', label: 'Click' }, { value: 'woodblock', label: 'Woodblock' }, { value: 'hihat', label: 'Hi-hat' }]

const icons = {
	play: html`<svg viewBox='0 0 24 24' aria-hidden=true><path d='M8 5l11 7-11 7z' fill=currentColor></path></svg>`,
	pause: html`<svg viewBox='0 0 24 24' aria-hidden=true><rect x=6 y=5 width=4 height=14 rx=1.5 fill=currentColor></rect><rect x=14 y=5 width=4 height=14 rx=1.5 fill=currentColor></rect></svg>`,
	sliders: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M4 7h10M18 7h2M4 17h4M12 17h8'></path><circle cx=16 cy=7 r=2></circle><circle cx=10 cy=17 r=2></circle></svg>`,
	repeat: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M17 2l3 3-3 3'></path><path d='M4 11V9a4 4 0 0 1 4-4h12'></path><path d='M7 22l-3-3 3-3'></path><path d='M20 13v2a4 4 0 0 1-4 4H4'></path></svg>`,
	mic: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><rect x=9 y=3 width=6 height=11 rx=3></rect><path d='M5 11a7 7 0 0 0 14 0'></path><path d='M12 18v3'></path></svg>`
}

const resample = (values : number[], count : number) => Array.from({ length: count }, (_, index) => values[Math.floor(index * values.length / count)] ?? 0)

@customElement('mirror-page')
class MirrorPage extends SignalWatcher(LitElement) {
	#tools : AbortController | null = null
	#wide = matchMedia('(width >= 64rem)')
	#frame = 0
	#history : number[] = Array(60).fill(0)
	#sampledAt = 0
	#recordedAt = 0
	#resize = () => this.requestUpdate()
	#keyboard = (event : KeyboardEvent) => {
		if (event.altKey || event.ctrlKey || event.metaKey) return
		const target = event.target as HTMLElement | null
		if (target?.matches('input:not([type=range]), textarea, select') || target?.isContentEditable) return

		const actions : Record<string, () => void> = {
			Space: () => this.#toggleMetronome(),
			KeyR: () => this.#toggleEcho(),
			KeyT: () => audio.tapTempo(),
			KeyL: () => audio.playLast()
		}
		const action = actions[event.code]
		if (!action) return

		// Space works wherever focus is, so it must not also press the focused button.
		event.preventDefault()
		if (!event.repeat) action()
	}
	#release = (event : KeyboardEvent) => {
		if (event.code === 'Space') event.preventDefault()
	}

	createRenderRoot () {
		return this
	}

	connectedCallback () {
		super.connectedCallback()
		window.addEventListener('keydown', this.#keyboard)
		window.addEventListener('keyup', this.#release)
		this.#wide.addEventListener('change', this.#resize)
		this.#registerTools()
		this.#tick()
	}

	disconnectedCallback () {
		window.removeEventListener('keydown', this.#keyboard)
		window.removeEventListener('keyup', this.#release)
		this.#wide.removeEventListener('change', this.#resize)
		cancelAnimationFrame(this.#frame)
		this.#tools?.abort()
		audio.dispose()
		super.disconnectedCallback()
	}

	render () {
		audio.tempoVersion.get()
		audio.beat.get()
		audio.level.get()

		return this.#wide.matches ? this.#desktop() : this.#mobile()
	}

	get #mode () : Mode {
		if (audio.status.get() === 'playing') return 'repeat'
		return audio.mic.get() ? 'listen' : 'off'
	}

	// Playing the last phrase while Echo is off.
	get #replaying () {
		return audio.status.get() === 'playing' && !audio.mic.get()
	}

	#mobile () {
		const mode = this.#mode
		const current = audio.status.get()
		const phrase = audio.phrase.get()
		const text = current === 'error'
			? audio.error.get()
			: this.#replaying ? 'Playing last phrase' : { off: 'Off', listen: current === 'requesting' ? 'Connecting the mic…' : 'Play — I’ll repeat after the pause', repeat: 'Mic paused' }[mode]
		const panel = mode === 'listen'
			? html`
				<div class='phrase listen'>
					<span class=blink></span>
					<span>${current === 'recording' ? 'Recording' : 'Listening'}</span>
					${this.#bars(this.#history.slice(-30))}
				</div>`
			: mode === 'repeat'
				? html`
					<div class='phrase repeat'>
						${icons.repeat}
						<span>Playing back</span>
						${this.#bars(resample(phrase?.peaks ?? [], 30), audio.progress)}
					</div>`
				: html`<p class='phrase hint'>Turn it on and play — after a pause, your phrase plays back in time.</p>`

		return html`
			<main class='page mobile'>
				<header class=top>
					<h1>Echo</h1>
					<button class='icon-button' aria-label=Settings @click=${this.#openSettings}>${icons.sliders}</button>
				</header>

				<section class=stage aria-label=Metronome>
					${this.#pulse()}
					<bpm-wheel .value=${audio.bpm} @change=${this.#wheel}></bpm-wheel>
					${this.#transport()}
				</section>

				<section class=${`repeat-card ${mode}`} aria-live=polite>
					<button class=repeat-toggle aria-pressed=${audio.mic.get()} aria-keyshortcuts=R @click=${this.#toggleEcho}>
						<span class=stack>
							<strong>Repeat</strong>
							${keyed(text, html`<span class=${current === 'error' ? 'status error' : 'status'}>${text}</span>`)}
						</span>
						<span class=switch></span>
					</button>
					${panel}
					<div class=last-row>
						${this.#playLast()}
						<div class=stack>
							<strong>Last phrase</strong>
							<span class=meta>${phrase ? this.#length(phrase.duration) : 'Nothing yet'}</span>
						</div>
					</div>
				</section>

				<dialog class=sheet @click=${this.#dismiss}>
					<div class=grip></div>
					<header class=sheet-head>
						<h2>Settings</h2>
						<button class='button' @click=${this.#closeSettings}>Done</button>
					</header>
					${this.#settings()}
				</dialog>
			</main>
		`
	}

	#desktop () {
		const mode = this.#mode
		const current = audio.status.get()
		const phrase = audio.phrase.get()
		const progress = audio.progress
		const peaks = phrase?.peaks ?? []
		const strip = mode === 'listen'
			? this.#bars(this.#history)
			: mode === 'repeat'
				? this.#bars(resample(peaks, 60), progress)
				: this.#bars(Array(60).fill(0))
		const pill = current === 'error'
			? 'Microphone unavailable'
			: this.#replaying ? 'Playing last phrase' : {
				off: 'Echo off — metronome only',
				listen: current === 'requesting' ? 'Echo · connecting the mic…' : 'Echo · listening — play your phrase',
				repeat: 'Echo · playing back — mic paused'
			}[mode]
		const caption = current === 'recording' ? 'Recording' : mode === 'repeat' ? 'Playing back' : 'Listening'
		const ring = mode === 'off'
			? html`
				<span class=ring-idle>
					${icons.mic}
					<strong>Start Echo</strong>
					<span>Play a phrase — it plays back after you pause</span>
				</span>`
			: html`
				${keyed(caption, html`<span class=ring-caption>${caption}</span>`)}
				<span class=ring-position>${this.#position()}</span>
				<span class=ring-unit>bar · beat</span>
				<span class=ring-hint>${audio.mic.get() ? 'Click to stop' : ''}</span>`

		return html`
			<main class='page desktop'>
				<aside class=left>
					<header class=brand>
						<h1>Echo</h1>
						<p>call &amp; response practice</p>
					</header>
					<section class='card metronome' aria-label=Metronome>
						<header class=card-head>
							<h2 class=label>Metronome</h2>
							${this.#pulse()}
						</header>
						<bpm-wheel .value=${audio.bpm} @change=${this.#wheel}></bpm-wheel>
						${this.#transport()}
					</section>
				</aside>

				<section class=${`center ${mode}`} aria-live=polite>
					<p class=pill>${mode === 'listen' ? html`<span class=blink></span>` : ''}${keyed(pill, html`<span>${pill}</span>`)}</p>

					<div class=ring-area>
						<button class=ring aria-label=${audio.mic.get() ? 'Stop Echo' : 'Start Echo'} aria-pressed=${audio.mic.get()} aria-keyshortcuts=R @click=${this.#toggleEcho}>
							<svg viewBox='0 0 300 300' aria-hidden=true>
								<circle class=track cx=150 cy=150 r=146 pathLength=100></circle>
								<circle class=arc cx=150 cy=150 r=146 pathLength=100 style=${`stroke-dasharray: ${mode === 'repeat' ? Math.max(4, progress * 100) : 0} 100`}></circle>
							</svg>
							<span class=ring-face>${ring}</span>
						</button>
						<div class=strip>${strip}</div>
						${audio.error.get() ? html`<p class=error role=alert>${audio.error.get()}</p>` : ''}
					</div>

					<p class=shortcuts><kbd>Space</kbd> — metronome · <kbd>R</kbd> — Echo on/off · <kbd>T</kbd> — tap · <kbd>L</kbd> — last phrase</p>
				</section>

				<aside class=right>
					<section class='card last'>
						<h2 class=label>Last phrase</h2>
						<div class=last-wave>${this.#bars(resample(peaks, 36))}</div>
						<div class=last-row>
							${this.#playLast()}
							<div class=stack>
								<span class=meta>${phrase ? this.#length(phrase.duration) : 'Nothing yet'}</span>
								<span class=muted>${mode === 'listen' ? 'Mic pauses while it plays' : 'Only the latest is kept'}</span>
							</div>
						</div>
					</section>
					<section class='card'>
						<h2 class=label>Settings</h2>
						${this.#settings()}
					</section>
				</aside>
			</main>
		`
	}

	#pulse () {
		const running = audio.transport.get()
		const beat = audio.beat.get()
		return html`<span class=${`pulse ${running ? beat % 2 ? 'odd' : 'even' : ''}`} style=${`--beat: ${audio.beatDuration}s`} aria-hidden=true></span>`
	}

	#transport () {
		const running = audio.transport.get()
		return html`
			<div class=transport>
				${this.#tapButton()}
				<button class=${`play-button ${running ? 'solid' : ''}`} aria-label=${running ? 'Pause metronome' : 'Start metronome'}
					aria-pressed=${running} aria-keyshortcuts=Space @click=${this.#toggleMetronome}>
					${running ? icons.pause : icons.play}
				</button>
				<span class=tap aria-hidden=true></span>
			</div>
		`
	}

	#tapButton () {
		const taps = audio.taps.get()
		const tapped = audio.tapped.get()
		const flash = tapped ? tapped % 2 ? 'odd' : 'even' : ''
		return html`
			<button class=${`button round tap ${flash} ${taps ? 'active' : ''}`} aria-keyshortcuts=T @click=${() => audio.tapTempo()}>
				<span>Tap</span>
				<span class=tap-dots aria-hidden=true>
					${[1, 2, 3, 4].map(index => html`<i class=${index <= taps ? 'on' : ''}></i>`)}
				</span>
			</button>
		`
	}

	#playLast () {
		return html`
			<button class='icon-button solid play' aria-label='Play last phrase' aria-keyshortcuts=L
				?disabled=${!audio.phrase.get()} @click=${() => audio.playLast()}>${icons.play}</button>
		`
	}

	#settings () {
		const sensitivity = 21 - Math.round(audio.threshold * 100)
		const decibels = Math.round(20 * Math.log10(audio.threshold))
		const marker = Math.min(1, audio.gate / .35)

		return html`
			<div class=settings>
				<fieldset>
					<legend>End of phrase <span class=muted>How much silence counts as a pause</span></legend>
					<div class=segmented>
						${endings.map(item => html`
							<button aria-pressed=${audio.silenceBeats === item.beats} @click=${() => this.#set(() => audio.silenceBeats = item.beats)}>${item.label}</button>
						`)}
					</div>
				</fieldset>

				<label class=field>
					<span class=field-head>Mic sensitivity <span class=meta>${decibels} dB</span></span>
					<span class=level style=${`--level: ${audio.level.get()}; --marker: ${marker}`} aria-hidden=true></span>
					<input type=range min=1 max=20 .value=${String(sensitivity)}
						@input=${(event : Event) => this.#set(() => audio.threshold = (21 - Number((event.target as HTMLInputElement).value)) / 100)}>
					<span class=muted>Anything below the marker counts as silence. Play something to check.</span>
				</label>

				<label class=field>
					<span class=field-head>Playback volume <span class=meta>${Math.round(audio.volume * 100)}%</span></span>
					<input type=range min=0 max=100 .value=${String(Math.round(audio.volume * 100))}
						@input=${(event : Event) => this.#set(() => audio.volume = Number((event.target as HTMLInputElement).value) / 100)}>
				</label>

				<fieldset>
					<legend>Metronome sound</legend>
					<div class=chips>
						${sounds.map(item => html`
							<button class=chip aria-pressed=${audio.sound === item.value} @click=${() => this.#set(() => audio.sound = item.value)}>${item.label}</button>
						`)}
					</div>
				</fieldset>
			</div>
		`
	}

	#bars (values : number[], progress? : number) {
		return html`
			<span class=bars aria-hidden=true>
				${values.map((value, index) => html`<span class=${progress !== undefined && index / values.length >= progress ? 'bar ahead' : 'bar'} style=${`--h: ${value}`}></span>`)}
			</span>
		`
	}

	#position () {
		const current = audio.status.get()
		const phrase = audio.phrase.get()
		const seconds = current === 'recording'
			? (performance.now() - this.#recordedAt) / 1000
			: current === 'playing' && phrase ? Math.max(0, audio.progress * phrase.duration - phrase.onset) : -1
		if (seconds < 0) return '—'

		const beats = Math.floor(seconds / audio.beatDuration)
		return `${Math.floor(beats / 4) + 1}.${beats % 4 + 1}`
	}

	#length (duration : number) {
		const bars = Math.max(1, Math.round(duration / (audio.beatDuration * 4)))
		const seconds = Math.round(duration)
		return `${bars} ${bars === 1 ? 'bar' : 'bars'} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
	}

	#tick () {
		const now = performance.now()
		const current = audio.status.get()
		if (current === 'recording' && !this.#recordedAt) this.#recordedAt = now
		if (current !== 'recording') this.#recordedAt = 0

		if (now - this.#sampledAt > 70) {
			this.#sampledAt = now
			this.#history.push(audio.mic.get() ? audio.level.get() : 0)
			this.#history.shift()
			if (audio.mic.get() || current === 'playing') this.requestUpdate()
		}

		this.#frame = requestAnimationFrame(() => this.#tick())
	}

	#toggleEcho () {
		if (audio.mirrorRunning) audio.stopMirror()
		else void audio.startMirror()
	}

	#toggleMetronome () {
		if (audio.transport.get()) audio.stopTransport()
		else void audio.startTransport()
	}

	#openSettings () {
		this.querySelector<HTMLDialogElement>('dialog.sheet')?.showModal()
	}

	#closeSettings () {
		this.querySelector<HTMLDialogElement>('dialog.sheet')?.close()
	}

	#dismiss (event : MouseEvent) {
		if (event.target === event.currentTarget) this.#closeSettings()
	}

	#set (change : () => void) {
		change()
		this.requestUpdate()
	}

	#wheel (event : CustomEvent<number>) {
		audio.setTempo(event.detail)
		void audio.tick()
		this.requestUpdate()
	}

	#registerTools () {
		if (!document.modelContext?.registerTool) return

		this.#tools = new AbortController()
		void Promise.resolve(document.modelContext.registerTool({
			name: 'set_tempo',
			title: 'Set tempo',
			description: 'Sets the Echo metronome tempo in BPM.',
			inputSchema: {
				type: 'object',
				properties: {
					bpm: { type: 'integer', minimum: 30, maximum: 240 }
				},
				required: ['bpm'],
				additionalProperties: false
			},
			annotations: { readOnlyHint: false, untrustedContentHint: false },
			execute: input => {
				const value = input as { bpm : number }
				if (!Number.isInteger(value.bpm) || value.bpm < 30 || value.bpm > 240) throw new Error('Invalid BPM')
				audio.setTempo(value.bpm)
				this.requestUpdate()

				return { bpm: audio.bpm }
			}
		}, { signal: this.#tools.signal })).catch(() => {})
	}
}

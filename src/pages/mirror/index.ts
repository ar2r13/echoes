import { SignalWatcher } from '@lit-labs/signals'
import { LitElement, html } from 'lit'
import { customElement } from 'lit/decorators.js'
import { keyed } from 'lit/directives/keyed.js'
import { audio, bufferOptions, wav, type ClickSound, type Phrase } from '../../controllers/audio.ts'
import { drive } from '../../controllers/drive.ts'
import { recordings, type Recording } from '../../controllers/recordings.ts'
import '../../components/bpm-wheel.ts'
import '../../components/sync-bar.ts'

type Mode = 'off' | 'listen' | 'repeat'

const endings = [{ beats: 2, label: '2 beats' }, { beats: 4, label: '1 bar' }, { beats: 8, label: '2 bars' }]
const buffers = bufferOptions.map(seconds => ({ seconds, label: seconds < 60 ? `${seconds} s` : `${seconds / 60} min` }))
const sounds : { value : ClickSound, label : string }[] = [{ value: 'click', label: 'Click' }, { value: 'woodblock', label: 'Woodblock' }, { value: 'hihat', label: 'Hi-hat' }]

const icons = {
	play: html`<svg viewBox='0 0 24 24' aria-hidden=true><path d='M8 5l11 7-11 7z' fill=currentColor></path></svg>`,
	pause: html`<svg viewBox='0 0 24 24' aria-hidden=true><rect x=6 y=5 width=4 height=14 rx=1.5 fill=currentColor></rect><rect x=14 y=5 width=4 height=14 rx=1.5 fill=currentColor></rect></svg>`,
	sliders: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M4 7h10M18 7h2M4 17h4M12 17h8'></path><circle cx=16 cy=7 r=2></circle><circle cx=10 cy=17 r=2></circle></svg>`,
	repeat: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M17 2l3 3-3 3'></path><path d='M4 11V9a4 4 0 0 1 4-4h12'></path><path d='M7 22l-3-3 3-3'></path><path d='M20 13v2a4 4 0 0 1-4 4H4'></path></svg>`,
	mic: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><rect x=9 y=3 width=6 height=11 rx=3></rect><path d='M5 11a7 7 0 0 0 14 0'></path><path d='M12 18v3'></path></svg>`,
	reset: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M3 12a9 9 0 1 0 3-6.7'></path><path d='M3 4v5h5'></path></svg>`,
	chevron: html`<svg viewBox='0 0 24 24' aria-hidden=true class='stroke chevron'><path d='M6 9l6 6 6-6'></path></svg>`,
	next: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M9 6l6 6-6 6'></path></svg>`,
	bookmark: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M6 3h12v18l-6-4-6 4z'></path></svg>`,
	bookmarked: html`<svg viewBox='0 0 24 24' aria-hidden=true class='stroke filled'><path d='M6 3h12v18l-6-4-6 4z'></path></svg>`,
	close: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M6 6l12 12M18 6L6 18'></path></svg>`,
	search: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><circle cx=11 cy=11 r=7></circle><path d='M20 20l-4-4'></path></svg>`,
	trash: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'></path></svg>`,
	check: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M5 12.5l4.5 4.5L19 7.5'></path></svg>`,
	copy: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><rect x=8 y=8 width=12 height=12 rx=2.5></rect><path d='M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'></path></svg>`,
	heart: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'></path></svg>`,
	download: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M12 5v10M7.5 10.5L12 15l4.5-4.5M6 19h12'></path></svg>`,
	more: html`<svg viewBox='0 0 24 24' aria-hidden=true><circle cx=12 cy=5 r=1.8 fill=currentColor></circle><circle cx=12 cy=12 r=1.8 fill=currentColor></circle><circle cx=12 cy=19 r=1.8 fill=currentColor></circle></svg>`,
	pending: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z'></path><path d='M12 16v-5M9.5 13.5L12 11l2.5 2.5'></path></svg>`,
	synced: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z'></path><path d='M9.5 13.5l2 2 3.5-3.5'></path></svg>`
}

const wallets = [
	{ id: 'evm', network: 'EVM', tokens: 'Ethereum, BNB Chain, Polygon, Arbitrum, Base… · any token', address: '0xc09c52493b580681dbfC43CF455256a7A1C9c7db' }
]

type Notice = { heading : string, detail : string, pill : string, failed? : boolean }

const clock = (seconds : number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

const daysAgo = (at : number) => Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 864e5)
const day = (at : number) => ['Today', 'Yesterday'][daysAgo(at)] ?? dayFormat.format(at)
const time = (at : number) => timeFormat.format(at)

// Quick tempo changes under the wheel: half time, double time and a 4/4 → 3/4 metric modulation.
const shifts = [
	{ factor: 1 / 2, label: '½×', name: 'Half time' },
	{ factor: 2, label: '2×', name: 'Double time' },
	{ factor: 3 / 4, label: '4→3', name: 'Metric modulation 4/4 to 3/4' }
]

const resample = (values : number[], count : number) => Array.from({ length: count }, (_, index) => values[Math.floor(index * values.length / count)] ?? 0)

@customElement('mirror-page')
class MirrorPage extends SignalWatcher(LitElement) {
	#tools : AbortController | null = null
	#wide = matchMedia('(width >= 64rem)')
	#frame = 0
	#history : number[] = Array(60).fill(0)
	#sampledAt = 0
	#recordedAt = 0
	#settingsOpen = false
	#libraryOpen = false
	#query = ''
	#savedPhrase : Phrase | null = null
	#notice : Notice | null = null
	#noticeTimer = 0
	#deleted : { recording : Recording, blob : Blob | null } | null = null
	#deletedTimer = 0
	#copied = ''
	#copiedTimer = 0
	#resize = () => this.requestUpdate()
	#keyboard = (event : KeyboardEvent) => {
		if (event.altKey || event.ctrlKey || event.metaKey) return
		const target = event.target as HTMLElement | null
		if (target?.matches('input:not([type=range]), textarea, select') || target?.isContentEditable) return

		const actions : Record<string, () => void> = {
			Space: () => this.#toggleAll(),
			KeyE: () => this.#toggleEcho(),
			KeyM: () => this.#toggleMetronome(),
			KeyT: () => audio.tapTempo(),
			KeyL: () => audio.playLast(),
			KeyR: () => void this.#toggleRecorder()
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
		clearTimeout(this.#noticeTimer)
		clearTimeout(this.#deletedTimer)
		clearTimeout(this.#copiedTimer)
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

	// Playing the last phrase while Auto Playback is off.
	get #replaying () {
		return audio.status.get() === 'playing' && !audio.mic.get()
	}

	#mobile () {
		const mode = this.#mode
		const current = audio.status.get()
		const phrase = audio.phrase.get()
		const recordingSecondsLeft = audio.recordingSecondsLeft.get()
		const recording = Boolean(audio.recorder.get())
		const count = recordings.list.get().length
		const title = this.#replaying ? 'Last phrase' : { off: 'Auto Playback', listen: 'Listening', repeat: 'Playing back' }[mode]
		const text = current === 'error'
			? audio.error.get()
			: recording ? 'Paused while recording' : this.#replaying ? 'Mic paused' : {
				off: 'Tap, then play a phrase',
				listen: current === 'requesting' ? 'Connecting the mic…' : current === 'recording' ? recordingSecondsLeft ? `Recording ends in ${recordingSecondsLeft}s` : 'Recording' : 'Pause — it plays right back',
				repeat: 'Mic paused'
			}[mode]
		const badge = { off: icons.mic, listen: html`<span class=blink></span>`, repeat: icons.repeat }[mode]
		const wave = mode === 'listen'
			? this.#bars(this.#history.slice(-24))
			: mode === 'repeat' ? this.#bars(resample(phrase?.peaks ?? [], 24), audio.progress) : this.#bars(Array(24).fill(0))
		const notice = this.#notice

		return html`
			<main class='page mobile'>
				<header class=top>
					${this.#logo()}
					<div class=actions>
						<button class=button aria-label=${`All recordings, ${count}`} @click=${this.#openLibrary}>${icons.bookmark}${count}</button>
						<button class='icon-button' aria-label=Settings @click=${this.#openSettings}>${icons.sliders}</button>
					</div>
				</header>

				${notice ? this.#toast(notice.heading, notice.detail, notice.failed ? 'trash' : 'check', notice.failed ? undefined : { label: 'Open', run: () => this.#openLibrary() }) : ''}

				<section class=stage aria-label=Metronome>
					${this.#dial()}
					${this.#tempoBar()}
					${this.#transport()}
				</section>

				<section class=${`echo-card ${mode}`} aria-live=polite>
					<button class=echo-bar aria-label=${audio.mic.get() ? 'Stop Auto Playback' : 'Start Auto Playback'} aria-pressed=${audio.mic.get()} aria-keyshortcuts=E
						?disabled=${recording} @click=${this.#toggleEcho}>
						<span class=badge>${badge}</span>
						<span class=stack>
							<strong>${title}</strong>
							${keyed(text, html`<span class=${current === 'error' ? 'status error' : 'status'}>${text}</span>`)}
						</span>
						${wave}
					</button>
					<div class=last-row>
						${this.#playLast()}
						<div class=stack>
							<strong>Last phrase</strong>
							<span class=meta>${phrase ? this.#length(phrase.duration) : 'Nothing yet'}</span>
						</div>
						${this.#saveButton()}
					</div>
				</section>

				<dialog id=settings class=sheet @click=${this.#dismiss}>
					<div class=grip></div>
					<header class=sheet-head>
						<h2>Settings</h2>
						<button class=icon-button aria-label=Close @click=${this.#closeSettings}>${icons.close}</button>
					</header>
					${this.#settings(false)}
					<button class=support-link @click=${this.#openSupport}>${icons.heart}Free &amp; open source · Support the project</button>
				</dialog>

				${this.#library(false)}
				${this.#support(false)}
			</main>
		`
	}

	#desktop () {
		const mode = this.#mode
		const current = audio.status.get()
		const phrase = audio.phrase.get()
		const recordingSecondsLeft = audio.recordingSecondsLeft.get()
		const progress = audio.progress
		const peaks = phrase?.peaks ?? []
		const strip = mode === 'listen'
			? this.#bars(this.#history)
			: mode === 'repeat'
				? this.#bars(resample(peaks, 60), progress)
				: this.#bars(Array(60).fill(0))
		const recorder = audio.recorder.get()
		const all = recordings.list.get()
		const pill = this.#notice
			? this.#notice.pill
			: recorder ? `Recording ${clock((performance.now() - recorder) / 1000)} — press Rec again to save`
			: current === 'error' ? 'Microphone unavailable'
			: this.#replaying ? 'Playing last phrase' : {
				off: 'Auto Playback off — metronome only',
				listen: current === 'requesting' ? 'Connecting the mic…' : 'Listening — play your phrase',
				repeat: 'Playing it back — mic paused'
			}[mode]
		const pillClass = this.#notice ? 'pill notice' : recorder ? 'pill rec' : 'pill'
		const caption = current === 'recording' ? recordingSecondsLeft ? `Recording ends in ${recordingSecondsLeft}s` : 'Recording' : mode === 'repeat' ? 'Playing back' : 'Listening'
		const ring = mode === 'off'
			? html`
				<span class=ring-idle>
					${icons.mic}
					<strong>Start Auto Playback</strong>
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
					<header class=brand>${this.#logo()}</header>
					<section class='card metronome' aria-label=Metronome>
						<h2 class=label>Metronome</h2>
						${this.#dial()}
						${this.#tempoBar()}
						${this.#transport()}
					</section>
				</aside>

				<section class=${`center ${mode}`} aria-live=polite>
					<p class=${pillClass}>${mode === 'listen' || recorder ? html`<span class=blink></span>` : ''}${keyed(pill, html`<span>${pill}</span>`)}</p>

					<div class=ring-area>
						<button class=ring aria-label=${audio.mic.get() ? 'Stop Auto Playback' : 'Start Auto Playback'} aria-pressed=${audio.mic.get()} aria-keyshortcuts=E
							?disabled=${Boolean(recorder)} @click=${this.#toggleEcho}>
							<svg viewBox='0 0 300 300' aria-hidden=true>
								<circle class=track cx=150 cy=150 r=146 pathLength=100></circle>
								<circle class=arc cx=150 cy=150 r=146 pathLength=100 style=${`stroke-dasharray: ${mode === 'repeat' ? Math.max(4, progress * 100) : 0} 100`}></circle>
							</svg>
							<span class=ring-face>${ring}</span>
						</button>
						<div class=strip>${strip}</div>
						${audio.error.get() ? html`<p class=error role=alert>${audio.error.get()}</p>` : ''}
					</div>

					<p class=shortcuts><kbd>Space</kbd> — Auto Playback + metronome · <kbd>E</kbd> — Auto Playback · <kbd>M</kbd> — metronome · <kbd>T</kbd> — tap · <kbd>L</kbd> — last phrase · <kbd>R</kbd> — record</p>
				</section>

				<aside class=right>
					<section class='card last'>
						<header class=last-head>
							<h2 class=label>Last phrase <span>${phrase ? clock(phrase.duration) : '—'}</span></h2>
							${this.#saveButton()}
						</header>
						<div class=last-wave>
							${this.#playLast()}
							${this.#bars(resample(peaks, 36))}
						</div>
					</section>
					<section class='card saved'>
						<h2 class=label><span>Saved</span><span>${all.length}</span></h2>
						${all.length
							? html`<div class=rows>${all.slice(0, 3).map(item => this.#row(item, false, daysAgo(item.created) ? dateFormat.format(item.created) : time(item.created)))}</div>`
							: html`<p class=muted>Nothing saved yet.</p>`}
						<button class=button @click=${this.#openLibrary}>All recordings ${icons.next}</button>
					</section>
					<section class='card settings-card'>
						<h2>
							<button class='label disclosure' aria-expanded=${this.#settingsOpen} aria-controls=desktop-settings
								@click=${() => this.#set(() => this.#settingsOpen = !this.#settingsOpen)}>Settings ${icons.chevron}</button>
						</h2>
						<div id=desktop-settings ?hidden=${!this.#settingsOpen}>${this.#settings(true)}</div>
					</section>
					<button class=support-link @click=${this.#openSupport}>${icons.heart}Free &amp; open source · Support</button>
				</aside>

				${this.#library(true)}
				${this.#support(true)}
			</main>
		`
	}

	#dial () {
		return html`
			<div class=dial>
				${this.#pulse()}
				<bpm-wheel .value=${audio.bpm} @change=${this.#wheel}></bpm-wheel>
			</div>
		`
	}

	#logo () {
		return html`
			<h1>
				<button class=logo aria-label='Auto Playback Metronome — support the project' @click=${this.#openSupport}>Auto Playback<br>Metronome <span class=version>${__VERSION__}</span></button>
			</h1>
		`
	}

	#support (wide : boolean) {
		return html`
			<dialog id=support class=${wide ? 'modal support' : 'sheet support'} aria-label='Support the project' @click=${this.#dismiss}>
				${wide ? '' : html`<div class=grip></div>`}
				<header class=sheet-head>
					<h2>Support the project</h2>
					<button class=icon-button aria-label=Close @click=${this.#closeSupport}>${icons.close}</button>
				</header>
				<p class=muted>Auto Playback Metronome is free and open source, with no ads or accounts. If it helps your practice, a tip in crypto keeps it going. Any amount, any token.</p>
				<div class=wallets>
					${wallets.map(wallet => {
						const copied = this.#copied === wallet.id
						return html`
							<article class=wallet>
								<header>
									<span class=stack>
										<strong><span class=dot aria-hidden=true></span>${wallet.network}</strong>
										<span class=muted>${wallet.tokens}</span>
									</span>
									<button class=${copied ? 'button small copied' : 'button small'} aria-label=${`Copy ${wallet.network} address`}
										@click=${(event : Event) => void this.#copy(wallet.id, event.currentTarget as HTMLElement)}>${copied ? icons.check : icons.copy}${copied ? 'Copied' : 'Copy'}</button>
								</header>
								<code>${wallet.address}</code>
							</article>
						`
					})}
					<p class=note>Send only on the network shown on each card — funds sent on another network can be lost.</p>
				</div>
			</dialog>
		`
	}

	#library (wide : boolean) {
		const all = recordings.list.get()
		const query = this.#query.trim().toLowerCase()
		const shown = this.#libraryOpen ? all.filter(item => !query || `${item.name} ${item.bpm} bpm ${day(item.created)} ${time(item.created)}`.toLowerCase().includes(query)) : []
		const groups : { label : string, items : Recording[] }[] = []
		for (const item of shown) {
			const label = day(item.created)
			if (groups.at(-1)?.label !== label) groups.push({ label, items: [] })
			groups.at(-1)!.items.push(item)
		}
		const deleted = this.#deleted

		return html`
			<dialog id=library class=${wide ? 'drawer library' : 'sheet library'} aria-label='All recordings' @click=${this.#dismiss} @close=${this.#libraryClosed}>
				<header class=library-head>
					${wide ? '' : html`<div class=grip></div>`}
					<div class=sheet-head>
						<h2>All recordings <span class=meta>${all.length}</span></h2>
						<button class=icon-button aria-label=Close @click=${this.#closeLibrary}>${icons.close}</button>
					</div>
					<label class=search>
						${icons.search}
						<input type=search aria-label='Search recordings' placeholder='Search by name, BPM or date' .value=${this.#query}
							@input=${(event : Event) => this.#set(() => this.#query = (event.target as HTMLInputElement).value)}>
					</label>
					<sync-bar></sync-bar>
				</header>
				<div class=list>
					${this.#libraryOpen && !shown.length
						? html`<p class=empty>${all.length ? 'Nothing matches.' : 'No recordings yet. Save the last phrase or press Rec to keep one.'}</p>`
						: ''}
					${groups.map(group => html`
						<section>
							<h3 class=label>${group.label}</h3>
							${group.items.map(item => this.#row(item, true, time(item.created)))}
						</section>
					`)}
				</div>
				${deleted ? this.#toast('Recording deleted', `${deleted.recording.name} · ${clock(deleted.recording.duration)}`, 'trash', { label: 'Undo', run: () => void this.#undo() }) : ''}
			</dialog>
		`
	}

	#row (recording : Recording, removable : boolean, when : string) {
		const playing = audio.saved.get() === recording.id
		const cloud = recording.sync === 'cloud'
		const loading = drive.downloads.get().get(recording.id)
		const menu = `menu-${recording.id}`
		const mark = !drive.enabled || cloud ? ''
			: recording.sync ? html`<span class='sync-mark synced' role=img aria-label='Backed up to Drive' title='Backed up to Drive'>${icons.synced}</span>`
			: html`<span class=sync-mark role=img aria-label='Waiting to sync' title='Waiting to sync'>${icons.pending}</span>`
		const main = !cloud
			? html`<button class='icon-button solid play' aria-label=${`${playing ? 'Pause' : 'Play'} ${recording.name}`}
				@click=${() => playing ? audio.stopSaved() : void audio.playSaved(recording.id, () => recordings.open(recording))}>${playing ? icons.pause : icons.play}</button>`
			: loading === undefined
				? html`<button class='icon-button play' aria-label=${`Download ${recording.name}`} @click=${() => void drive.download(recording).catch(() => {})}>${icons.download}</button>`
				: html`
					<button class='icon-button play loading' aria-label=${`Cancel download of ${recording.name}`} style=${`--progress: ${loading}`} @click=${() => drive.cancelDownload(recording)}>
						<svg viewBox='0 0 44 44' aria-hidden=true><circle class=track cx=22 cy=22 r=19 pathLength=100></circle><circle class=arc cx=22 cy=22 r=19 pathLength=100></circle></svg>
						<span class=meta>${Math.min(99, Math.round(loading * 100))}</span>
					</button>`

		return html`
			<article class=${`recording ${playing ? 'playing' : ''} ${cloud ? 'cloud' : ''}`}>
				${main}
				<div class=body>
					<div class=line><strong>${recording.name}</strong><span class=meta>${mark}${when}</span></div>
					<div class=line>${this.#bars(resample(recording.peaks, 30))}<span class=meta>${clock(recording.duration)} · ${recording.bpm} BPM${cloud ? ' · on Drive' : ''}</span></div>
				</div>
				${removable ? html`
					<button class='icon-button more' popovertarget=${menu} aria-label=${`More options for ${recording.name}`} style=${`anchor-name: --${menu}`}>${icons.more}</button>
					<div id=${menu} class=row-menu popover style=${`position-anchor: --${menu}`}>
						<button class=danger @click=${() => this.#delete(recording, menu)}>${icons.trash}Delete</button>
					</div>
				` : ''}
			</article>
		`
	}

	#toast (heading : string, detail : string, icon : 'check' | 'trash', action? : { label : string, run : () => void }) {
		return html`
			<div class=${`toast ${icon}`} role=status>
				<span class=badge>${icons[icon]}</span>
				<span class=stack>
					<strong>${heading}</strong>
					<span class=meta>${detail}</span>
				</span>
				${action ? html`<button class=button @click=${action.run}>${action.label}</button>` : ''}
			</div>
		`
	}

	#saveButton () {
		const phrase = audio.phrase.get()
		const saved = Boolean(phrase) && phrase === this.#savedPhrase
		return html`
			<button class=${saved ? 'button small done' : 'button small'} aria-label=${saved ? 'Last phrase saved' : 'Save last phrase'}
				?disabled=${!phrase} @click=${this.#saveLast}>
				${saved ? icons.bookmarked : icons.bookmark}${saved ? 'Saved' : 'Save'}
			</button>
		`
	}

	#recButton () {
		const started = audio.recorder.get()
		return html`
			<button class=${started ? 'button round rec on' : 'button round rec'} aria-label=${started ? 'Stop recording and save' : 'Record until stopped'}
				aria-pressed=${Boolean(started)} aria-keyshortcuts=R @click=${this.#toggleRecorder}>
				<span class=dot aria-hidden=true></span>
				${started ? html`<span class=clock>${clock((performance.now() - started) / 1000)}</span>` : 'Rec'}
			</button>
		`
	}

	#pulse () {
		const running = audio.transport.get()
		const beat = audio.beat.get()
		return html`<span class=${`pulse ${running ? beat % 2 ? 'odd' : 'even' : ''}`} style=${`--beat: ${audio.beatDuration}s`} aria-hidden=true></span>`
	}

	#tempoBar () {
		return html`
			<div class=tempo-bar role=group aria-label='Quick tempo'>
				<button aria-label=${`Reset to default tempo, ${audio.defaultBpm} BPM`} @click=${() => this.#tempo(audio.defaultBpm)}>
					${icons.reset}${audio.defaultBpm}
				</button>
				${shifts.map(item => html`<button aria-label=${item.name} @click=${() => this.#tempo(audio.bpm * item.factor)}>${item.label}</button>`)}
			</div>
		`
	}

	#transport () {
		const running = audio.transport.get()
		return html`
			<div class=transport>
				${this.#tapButton()}
				<button class=${`play-button ${running ? 'solid' : ''}`} aria-label=${running ? 'Pause metronome' : 'Start metronome'}
					aria-pressed=${running} aria-keyshortcuts=M @click=${this.#toggleMetronome}>
					${running ? icons.pause : icons.play}
				</button>
				${this.#recButton()}
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
		const playing = audio.status.get() === 'playing'
		return html`
			<button class='icon-button solid play' aria-label=${playing ? 'Stop last phrase' : 'Play last phrase'} aria-pressed=${playing} aria-keyshortcuts=L
				?disabled=${!audio.phrase.get()} @click=${() => audio.playLast()}>${playing ? icons.pause : icons.play}</button>
		`
	}

	#settings (wide : boolean) {
		const sensitivity = 21 - Math.round(audio.threshold * 100)
		const decibels = Math.round(20 * Math.log10(audio.threshold))
		const marker = Math.min(1, audio.gate / .35)

		return html`
			<div class=settings>
				${wide ? html`
					<label class='field inline'>
						<span class=field-head>Default tempo</span>
						<span class=number>
							<input type=number min=30 max=240 inputmode=numeric .value=${String(audio.defaultBpm)}
								@change=${(event : Event) => this.#setDefault(event.target as HTMLInputElement)}>
							<span class=meta>BPM</span>
						</span>
					</label>` : html`
					<div class='field inline'>
						<span class=stack>
							<strong>Default tempo</strong>
							<span class=muted>Where the reset button takes you</span>
						</span>
						<span class=stepper role=group aria-label='Default tempo'>
							<button aria-label='Lower default tempo' ?disabled=${audio.defaultBpm <= 30} @click=${() => this.#set(() => audio.defaultBpm--)}>−</button>
							<output aria-live=polite>${audio.defaultBpm}</output>
							<button aria-label='Raise default tempo' ?disabled=${audio.defaultBpm >= 240} @click=${() => this.#set(() => audio.defaultBpm++)}>+</button>
						</span>
					</div>`}

				<fieldset>
					<legend>End of phrase <span class=muted>How much silence counts as a pause</span></legend>
					<div class=segmented>
						${endings.map(item => html`
							<button aria-pressed=${audio.silenceBeats === item.beats} @click=${() => this.#set(() => audio.silenceBeats = item.beats)}>${item.label}</button>
						`)}
					</div>
				</fieldset>

				<fieldset>
					<legend>Recording buffer <span class=muted>Longest phrase that can be captured</span></legend>
					<div class=segmented>
						${buffers.map(item => html`
							<button aria-pressed=${audio.bufferSeconds === item.seconds} @click=${() => this.#set(() => audio.bufferSeconds = item.seconds)}>${item.label}</button>
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

				<label class=field>
					<span class=field-head>Metronome volume <span class=meta>${Math.round(audio.metronomeVolume * 100)}%</span></span>
					<input type=range min=0 max=100 .value=${String(Math.round(audio.metronomeVolume * 100))}
						@input=${(event : Event) => this.#set(() => audio.metronomeVolume = Number((event.target as HTMLInputElement).value) / 100)}>
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
			if (audio.mic.get() || current === 'playing' || audio.recorder.get()) this.requestUpdate()
		}

		this.#frame = requestAnimationFrame(() => this.#tick())
	}

	#toggleEcho () {
		if (audio.recorder.get()) return
		if (audio.mirrorRunning) audio.stopMirror()
		else void audio.startMirror()
	}

	#toggleAll () {
		if (audio.recorder.get()) return
		if (audio.mirrorRunning) {
			audio.stopMirror()
			audio.stopTransport()
		} else {
			void audio.startMirror()
			void audio.startTransport()
		}
	}

	#toggleMetronome () {
		if (audio.transport.get()) audio.stopTransport()
		else void audio.startTransport()
	}

	async #toggleRecorder () {
		if (!audio.recorder.get()) {
			void audio.startRecorder()
			return
		}

		const take = await audio.stopRecorder()
		if (take) await this.#keep(take.blob, take.duration, take.peaks, true)
	}

	async #saveLast () {
		const phrase = audio.phrase.get()
		if (!phrase || phrase === this.#savedPhrase) return

		this.#set(() => this.#savedPhrase = phrase)
		if (!await this.#keep(wav(phrase.buffer), phrase.duration, phrase.peaks, false)) this.#set(() => this.#savedPhrase = null)
	}

	async #keep (blob : Blob, duration : number, peaks : number[], announce : boolean) {
		try {
			const recording = await recordings.add(blob, { duration, bpm: audio.bpm, peaks })
			if (announce) this.#notify({ heading: 'Saved to recordings', detail: `${recording.name} · ${clock(duration)}`, pill: `${recording.name} saved · ${clock(duration)}` })
			return true
		} catch {
			this.#notify({ heading: 'Could not save', detail: 'This browser blocks storage here', pill: 'Could not save — this browser blocks storage here', failed: true })
			return false
		}
	}

	#notify (notice : Notice) {
		clearTimeout(this.#noticeTimer)
		this.#set(() => this.#notice = notice)
		this.#noticeTimer = window.setTimeout(() => this.#set(() => this.#notice = null), 3500)
	}

	#delete (recording : Recording, menu : string) {
		this.querySelector<HTMLElement>(`#${CSS.escape(menu)}`)?.hidePopover()
		void this.#remove(recording)
	}

	async #remove (recording : Recording) {
		if (audio.saved.get() === recording.id) audio.stopSaved()
		drive.cancelDownload(recording)
		let blob : Blob | null
		try {
			blob = await recordings.remove(recording)
		} catch {
			return
		}

		clearTimeout(this.#deletedTimer)
		this.#set(() => this.#deleted = { recording, blob })
		this.#deletedTimer = window.setTimeout(() => this.#set(() => this.#deleted = null), 4000)
	}

	async #undo () {
		const deleted = this.#deleted
		if (!deleted) return

		clearTimeout(this.#deletedTimer)
		this.#set(() => this.#deleted = null)
		await recordings.restore(deleted.recording, deleted.blob)
	}

	#openSettings () {
		this.querySelector<HTMLDialogElement>('#settings')?.showModal()
	}

	#closeSettings () {
		this.querySelector<HTMLDialogElement>('#settings')?.close()
	}

	#openSupport () {
		this.querySelector<HTMLDialogElement>('#support')?.showModal()
	}

	#closeSupport () {
		this.querySelector<HTMLDialogElement>('#support')?.close()
	}

	async #copy (id : string, button : HTMLElement) {
		const address = button.closest('.wallet')!.querySelector('code')!
		try {
			await navigator.clipboard.writeText(address.textContent!)
		} catch {
			// Without clipboard access, select the address so it can be copied by hand at least.
			getSelection()?.selectAllChildren(address)
			if (!document.execCommand('copy')) return
		}

		clearTimeout(this.#copiedTimer)
		this.#set(() => this.#copied = id)
		this.#copiedTimer = window.setTimeout(() => this.#set(() => this.#copied = ''), 1800)
	}

	#openLibrary () {
		clearTimeout(this.#noticeTimer)
		this.#notice = null
		this.#set(() => this.#libraryOpen = true)
		this.querySelector<HTMLDialogElement>('#library')?.showModal()
	}

	#closeLibrary () {
		this.querySelector<HTMLDialogElement>('#library')?.close()
	}

	#libraryClosed () {
		audio.stopSaved()
		this.#set(() => this.#libraryOpen = false)
	}

	// A click on the dialog itself, outside its content, lands on the backdrop.
	#dismiss (event : MouseEvent) {
		if (event.target === event.currentTarget) (event.currentTarget as HTMLDialogElement).close()
	}

	#set (change : () => void) {
		change()
		this.requestUpdate()
	}

	#setDefault (input : HTMLInputElement) {
		const value = Number(input.value)
		if (input.value !== '' && Number.isFinite(value)) audio.defaultBpm = value
		// Show the clamped value, or put the old one back after an empty entry.
		input.value = String(audio.defaultBpm)
		this.requestUpdate()
	}

	#tempo (bpm : number) {
		audio.setTempo(bpm)
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
			description: 'Sets the Auto Playback Metronome tempo in BPM.',
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

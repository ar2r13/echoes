import { SignalWatcher } from '@lit-labs/signals'
import { LitElement, html } from 'lit'
import { customElement } from 'lit/decorators.js'
import { audio, type MirrorStatus } from '../../controllers/audio.ts'

const labels : Record<MirrorStatus, { title : string, detail : string }> = {
	idle: { title: 'Готов к запуску', detail: 'Микрофон пока выключен' },
	requesting: { title: 'Подключаю микрофон', detail: 'Разрешите доступ в окне браузера' },
	arming: { title: 'Слушаю', detail: 'Сыграйте фразу — запись начнётся сама' },
	recording: { title: 'Записываю', detail: 'Закончите фразу и оставьте паузу' },
	playing: { title: 'Отражение', detail: 'Слушайте последнюю сыгранную фразу' },
	error: { title: 'Нет доступа к микрофону', detail: 'Проверьте разрешения браузера' }
}

@customElement('mirror-page')
class MirrorPage extends SignalWatcher(LitElement) {
	#tools : AbortController | null = null

	createRenderRoot () {
		return this
	}

	connectedCallback () {
		super.connectedCallback()
		this.#registerTools()
	}

	disconnectedCallback () {
		this.#tools?.abort()
		audio.stop()
		super.disconnectedCallback()
	}

	render () {
		const status = audio.status.get()
		const state = labels[status]
		const running = audio.running
		const level = audio.level.get()
		const currentBeat = audio.beat.get()

		return html`
			<main class=page>
				<header class=brand>
					<div class=mark aria-hidden=true>M</div>
					<div>
						<h1>Mirror</h1>
						<p>Сыграйте. Остановитесь. Услышьте себя.</p>
					</div>
				</header>

				<section class='panel pulse-panel' aria-label=Метроном>
					<div class=beat-row aria-label='Доли такта'>
						${Array.from({ length: audio.beats }, (_, index) => html`
							<span class=${`beat ${index === 0 ? 'accent' : ''} ${running && currentBeat === index ? 'active' : ''}`}></span>
						`)}
					</div>

					<div class=tempo>
						<label for=bpm>BPM</label>
						<input id=bpm class=tempo-input type=number min=30 max=240 .value=${String(audio.bpm)}
							@change=${(event : Event) => this.#tempo(event)}>
					</div>
					<input class=tempo-range type=range min=30 max=240 .value=${String(audio.bpm)} aria-label='Темп, ударов в минуту'
						@input=${(event : Event) => this.#tempo(event)}>

					<div class=signature>
						<label>
							<span>Размер</span>
							<span class=fraction>
								<select @change=${(event : Event) => this.#signature(event, true)}>
									${[2, 3, 4, 5, 6, 7, 8, 9, 12].map(value => html`<option value=${value} ?selected=${value === audio.beats}>${value}</option>`)}
								</select>
								<span></span>
								<select @change=${(event : Event) => this.#signature(event, false)}>
									${[4, 8].map(value => html`<option value=${value} ?selected=${value === audio.beatUnit}>${value}</option>`)}
								</select>
							</span>
						</label>

						<label>
							<span>Пауза до ответа</span>
							<select @change=${(event : Event) => this.#silence(event)}>
								${[1, 2, 3, 4].map(value => html`<option value=${value} ?selected=${value === audio.silenceBeats}>${value} ${value === 1 ? 'доля' : 'доли'}</option>`)}
							</select>
						</label>
					</div>
				</section>

				<section class=${`panel mirror-panel ${status}`} aria-live=polite>
					<div class=status-row>
						<span class=status-dot aria-hidden=true></span>
						<div>
							<h2>${state.title}</h2>
							<p>${state.detail}</p>
						</div>
					</div>

					<div class=meter aria-label='Уровень микрофона'>
						<span style=${`inline-size: ${Math.max(2, level * 100)}%`}></span>
					</div>

					${audio.error.get() ? html`<p class=error role=alert>${audio.error.get()}</p>` : ''}

					<div class=actions>
						<button class='button primary' @click=${() => running ? audio.stop() : audio.start()}>
							${running ? html`<span class=stop-icon aria-hidden=true></span> Остановить` : html`<span class=play-icon aria-hidden=true></span> Начать сессию`}
						</button>
						<button class=button ?disabled=${!audio.lastClip.get() || status === 'playing'} @click=${() => audio.playLast()}>
							Повторить последнее
						</button>
					</div>
				</section>

				<details class=setup>
					<summary>Настроить чувствительность</summary>
					<label>
						<span>Порог микрофона</span>
						<input type=range min=1 max=20 .value=${String(Math.round(audio.threshold * 100))}
							@input=${(event : Event) => audio.threshold = Number((event.target as HTMLInputElement).value) / 100}>
					</label>
					<p>Если метроном сам запускает запись, сдвиньте порог вправо. Если тихие ноты не распознаются — влево.</p>
				</details>

				<footer>Запись остаётся только в этом браузере и заменяется следующей фразой.</footer>
			</main>
		`
	}

	#tempo (event : Event) {
		audio.setTempo(Number((event.target as HTMLInputElement).value))
		this.requestUpdate()
	}

	#signature (event : Event, numerator : boolean) {
		const value = Number((event.target as HTMLSelectElement).value)
		audio.setSignature(numerator ? value : audio.beats, numerator ? audio.beatUnit : value)
		this.requestUpdate()
	}

	#silence (event : Event) {
		audio.silenceBeats = Number((event.target as HTMLSelectElement).value)
		this.requestUpdate()
	}

	#registerTools () {
		if (!document.modelContext?.registerTool) return

		this.#tools = new AbortController()
		void Promise.resolve(document.modelContext.registerTool({
			name: 'configure_metronome',
			title: 'Настроить метроном',
			description: 'Устанавливает темп и музыкальный размер в интерфейсе Mirror.',
			inputSchema: {
				type: 'object',
				properties: {
					bpm: { type: 'integer', minimum: 30, maximum: 240 },
					beats: { type: 'integer', enum: [2, 3, 4, 5, 6, 7, 8, 9, 12] },
					beatUnit: { type: 'integer', enum: [4, 8] }
				},
				required: ['bpm', 'beats', 'beatUnit'],
				additionalProperties: false
			},
			annotations: { readOnlyHint: false, untrustedContentHint: false },
			execute: input => {
				const value = input as { bpm : number, beats : number, beatUnit : number }
				if (!Number.isInteger(value.bpm) || value.bpm < 30 || value.bpm > 240) throw new Error('Некорректный BPM')
				if (![2, 3, 4, 5, 6, 7, 8, 9, 12].includes(value.beats)) throw new Error('Некорректное число долей')
				if (![4, 8].includes(value.beatUnit)) throw new Error('Некорректная длительность доли')
				audio.setTempo(value.bpm)
				audio.setSignature(value.beats, value.beatUnit)
				this.requestUpdate()

				return { bpm: audio.bpm, beats: audio.beats, beatUnit: audio.beatUnit }
			}
		}, { signal: this.#tools.signal })).catch(() => {})
	}
}

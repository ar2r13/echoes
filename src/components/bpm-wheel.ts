import { LitElement, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'

const min = 30
const max = 240
const values = Array.from({ length: max - min + 1 }, (_, index) => min + index)

@customElement('bpm-wheel')
export class BpmWheel extends LitElement {
	@property({ type: Number }) value = 92

	#list : HTMLElement | null = null
	#steering = 0

	createRenderRoot () {
		return this
	}

	render () {
		return html`
			<div class=wheel role=spinbutton tabindex=0 aria-label='Tempo, BPM'
				aria-valuemin=${min} aria-valuemax=${max} aria-valuenow=${this.value}
				@scroll=${this.#scroll} @scrollend=${this.#settle} @keydown=${this.#key}>
				<div class=spacer></div>
				${values.map(value => {
					const distance = Math.abs(value - this.value)
					return html`<div class=${distance === 0 ? 'item selected' : distance === 1 ? 'item near' : 'item'} aria-hidden=true>${value}</div>`
				})}
				<div class=spacer></div>
			</div>
			<span class=unit aria-hidden=true>BPM</span>
		`
	}

	firstUpdated () {
		this.#list = this.querySelector('.wheel')
		this.#scrollTo(this.value, 'instant')
	}

	updated () {
		if (this.#list && this.#valueAtScroll() !== this.value && !this.#steering) this.#scrollTo(this.value, 'smooth')
	}

	get #step () {
		return this.#list?.querySelector<HTMLElement>('.item')?.offsetHeight || 1
	}

	#valueAtScroll () {
		const value = min + Math.round((this.#list?.scrollTop ?? 0) / this.#step)
		return Math.min(max, Math.max(min, value))
	}

	#scrollTo (value : number, behavior : ScrollBehavior) {
		if (!this.#list) return

		// Programmatic scrolls fire intermediate scroll events; ignore them until it settles.
		window.clearTimeout(this.#steering)
		this.#steering = window.setTimeout(() => this.#settle(), 600)
		this.#list.scrollTo({ top: (value - min) * this.#step, behavior })
	}

	#settle () {
		window.clearTimeout(this.#steering)
		this.#steering = 0
	}

	#scroll () {
		if (this.#steering) return

		const value = this.#valueAtScroll()
		if (value !== this.value) this.#change(value)
	}

	#key (event : KeyboardEvent) {
		const steps : Record<string, number> = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10, Home: min - max, End: max - min }
		const step = steps[event.key]
		if (step === undefined) return

		event.preventDefault()
		const value = Math.min(max, Math.max(min, this.value + step))
		this.#change(value)
		this.#scrollTo(value, 'instant')
	}

	#change (value : number) {
		this.value = value
		this.dispatchEvent(new CustomEvent('change', { detail: value, bubbles: true }))
	}
}

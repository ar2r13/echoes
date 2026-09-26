import { SignalWatcher } from '@lit-labs/signals'
import { LitElement, html } from 'lit'
import { customElement } from 'lit/decorators.js'
import { drive } from '../controllers/drive.ts'
import { recordings } from '../controllers/recordings.ts'

const icons = {
	upload: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z'></path><path d='M12 16v-5M9.5 13.5L12 11l2.5 2.5'></path></svg>`,
	synced: html`<svg viewBox='0 0 24 24' aria-hidden=true class=stroke><path d='M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z'></path><path d='M9.5 13.5l2 2 3.5-3.5'></path></svg>`,
	spinner: html`<svg viewBox='0 0 24 24' aria-hidden=true class='stroke spinner'><path d='M12 3a9 9 0 1 0 9 9'></path></svg>`,
	chevron: html`<svg viewBox='0 0 24 24' aria-hidden=true class='stroke chevron'><path d='M6 9l6 6 6-6'></path></svg>`
}

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

const ago = (at : number) => {
	const minutes = Math.floor((Date.now() - at) / 60_000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes} min ago`
	return new Date(at).toDateString() === new Date().toDateString() ? `at ${timeFormat.format(at)}` : 'a while ago'
}

// The Google Drive backup line at the top of All recordings: its state, one action, and a menu once it is on.
@customElement('sync-bar')
export class SyncBar extends SignalWatcher(LitElement) {
	#open = false
	#clock = 0

	createRenderRoot () {
		return this
	}

	connectedCallback () {
		super.connectedCallback()
		void drive.prepare().catch(() => {})
		// Keeps "5 min ago" current.
		this.#clock = window.setInterval(() => this.requestUpdate(), 30_000)
	}

	disconnectedCallback () {
		clearInterval(this.#clock)
		super.disconnectedCallback()
	}

	render () {
		const phase = drive.phase.get()
		const problem = drive.problem.get()
		const { done, total } = drive.progress.get()
		const waiting = recordings.list.get().filter(item => !item.sync).length
		const off = phase === 'off'
		const on = !off && phase !== 'signing'
		const busy = phase === 'signing' || phase === 'syncing'

		const text = off ? 'Only on this device'
			: phase === 'signing' ? 'Connecting to Google…'
			: phase === 'syncing' ? total ? `Syncing ${Math.min(done + 1, total)} of ${total}…` : 'Checking Google Drive…'
			: problem === 'signin' ? 'Sign in to keep syncing'
			: problem === 'offline' ? 'Can’t reach Google Drive'
			: problem === 'wifi' && waiting ? `${waiting} waiting for Wi‑Fi`
			: waiting ? `${waiting} waiting to sync`
			: drive.syncedAt.get() ? `Synced with Google Drive · ${ago(drive.syncedAt.get())}` : 'Synced with Google Drive'
		const icon = busy ? icons.spinner : off || waiting || problem ? icons.upload : icons.synced
		const action = off
			? { label: 'Back up to Drive', run: () => void drive.connect() }
			: phase === 'signing' ? { label: 'Cancel', run: () => drive.cancel() }
			: phase === 'syncing' ? { label: 'Stop', run: () => drive.stop() }
			: { label: 'Sync now', run: () => void drive.sync(true) }

		return html`
			<div class=${`sync-bar ${off ? 'off' : 'on'}`}>
				<button class=status popovertarget=sync-menu ?disabled=${!on} aria-expanded=${on ? String(this.#open) : 'false'}>
					<span class=icon>${icon}</span>
					<span class=text aria-live=polite>${text}</span>
					${on ? icons.chevron : ''}
				</button>
				<button class=${off ? 'button small solid' : 'button small'} @click=${action.run}>${action.label}</button>
				<div id=sync-menu class=sync-menu popover @toggle=${this.#toggle}>
					<p class=account>
						<span>Backing up to Google Drive as</span>
						<strong>${drive.account.get()}</strong>
						<span>Private app folder · not visible in your Drive</span>
					</p>
					<button role=switch aria-checked=${drive.wifiOnly} @click=${() => drive.wifiOnly = !drive.wifiOnly}>
						Sync on Wi‑Fi only <span class=switch aria-hidden=true></span>
					</button>
					<button class=danger @click=${this.#turnOff}>Turn off sync</button>
				</div>
			</div>
		`
	}

	#toggle (event : ToggleEvent) {
		this.#open = event.newState === 'open'
		this.requestUpdate()
	}

	#turnOff () {
		this.querySelector<HTMLElement>('#sync-menu')?.hidePopover()
		void drive.disconnect()
	}
}

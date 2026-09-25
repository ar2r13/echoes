import { LitElement, html } from 'lit'
import { customElement } from 'lit/decorators.js'

@customElement('mirror-app')
class App extends LitElement {
	createRenderRoot () {
		return this
	}

	connectedCallback () {
		super.connectedCallback()
		void import('./pages/mirror/index.ts')
	}

	render () {
		return html`<mirror-page></mirror-page>`
	}
}

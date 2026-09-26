declare const __VERSION__ : string

// The part of Google Identity Services the Drive backup uses.
declare namespace google.accounts.oauth2 {
	interface TokenResponse { access_token? : string, expires_in : string, error? : string }
	interface TokenClient { requestAccessToken(options? : { prompt? : string, login_hint? : string }) : void }
	function initTokenClient(config : {
		client_id : string
		scope : string
		callback : (response : TokenResponse) => void
		error_callback? : (error : { type : string }) => void
	}) : TokenClient
	function revoke(token : string, done : () => void) : void
}

interface Window {
	google? : { accounts : { oauth2 : typeof google.accounts.oauth2 } }
}

// Network Information API: only Chromium on Android reports the connection type.
interface Navigator {
	connection? : EventTarget & { type? : string }
}

interface Document {
	modelContext?: {
		registerTool(tool : {
			name : string
			title? : string
			description : string
			inputSchema : object
			annotations? : { readOnlyHint? : boolean, untrustedContentHint? : boolean }
			execute(input : unknown) : unknown | Promise<unknown>
		}, options? : { signal? : AbortSignal }) : void | Promise<void>
	}
}

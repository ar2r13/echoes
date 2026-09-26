declare const __VERSION__ : string

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

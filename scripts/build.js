import { build, context } from 'esbuild'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const serving = process.argv.includes('--serve')
const { version } = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))

await rm(`${root}/www`, { recursive: true, force: true })
await mkdir(`${root}/www`, { recursive: true })

await Promise.all([
	cp(`${root}/src/index.html`, `${root}/www/index.html`),
	cp(`${root}/src/manifest.json`, `${root}/www/manifest.json`),
	cp(`${root}/src/favicon.svg`, `${root}/www/favicon.svg`),
	cp(`${root}/src/icon-192.png`, `${root}/www/icon-192.png`),
	cp(`${root}/src/icon-512.png`, `${root}/www/icon-512.png`),
	cp(`${root}/src/icon-maskable-512.png`, `${root}/www/icon-maskable-512.png`),
	cp(`${root}/src/apple-touch-icon.png`, `${root}/www/apple-touch-icon.png`),
	cp(`${root}/src/hat.wav`, `${root}/www/hat.wav`)
])

const options = {
	entryPoints: {
		index: `${root}/src/index.ts`,
		sw: `${root}/src/sw.ts`
	},
	bundle: true,
	format: 'esm',
	splitting: true,
	outdir: `${root}/www`,
	target: 'es2022',
	define: { __VERSION__: JSON.stringify(version) },
	minify: !serving,
	sourcemap: serving
}

if (serving) {
	const builder = await context(options)
	await builder.watch()
	const server = await builder.serve({ servedir: `${root}/www`, host: '127.0.0.1', port: 8000 })

	console.log(`Local: http://127.0.0.1:${server.port}`)
} else {
	await build(options)
}

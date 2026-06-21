import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import process from "node:process"
import * as console from "node:console"

import { copyPaths, copyWasms, copyLocales, setupLocaleWatcher } from "@roo-code/build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function removeDirWithRetries(dirPath, retries = 5, retryDelayMs = 200) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await fs.promises.rm(dirPath, { recursive: true, force: true })
			return
		} catch (error) {
			const isRetryable = error?.code === "ENOTEMPTY" || error?.code === "EBUSY" || error?.code === "EPERM"
			const isLastAttempt = attempt === retries

			if (!isRetryable || isLastAttempt) {
				throw error
			}

			await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelayMs * (attempt + 1)))
		}
	}
}

async function main() {
	const name = "extension"
	const production = process.argv.includes("--production")
	const watch = process.argv.includes("--watch")
	const minify = production
	const sourcemap = true // Always generate source maps for error handling.

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const buildOptions = {
		bundle: true,
		minify,
		sourcemap,
		logLevel: "silent",
		format: "cjs",
		sourcesContent: false,
		platform: "node",
		define: {
			"process.env.PKG_RELEASE_CHANNEL": JSON.stringify(process.env.PKG_RELEASE_CHANNEL || "stable"),
			"process.env.POSTHOG_API_KEY": JSON.stringify(process.env.POSTHOG_API_KEY || ""),
		},
	}

	const srcDir = __dirname
	const buildDir = __dirname
	const distDir = path.join(buildDir, "dist")

	if (fs.existsSync(distDir)) {
		console.log(`[${name}] Cleaning dist directory: ${distDir}`)
		await removeDirWithRetries(distDir)
	}

	/**
	 * @type {import('esbuild').Plugin[]}
	 */
	const plugins = [
		{
			name: "copyFiles",
			setup(build) {
				build.onEnd(() => {
					copyPaths(
						[
							["../README.md", "README.md"],
							["../CHANGELOG.md", "CHANGELOG.md"],
							["../LICENSE", "LICENSE"],
							["../.env", ".env", { optional: true }],
							["node_modules/vscode-material-icons/generated", "assets/vscode-material-icons"],
							["../webview-ui/audio", "webview-ui/audio"],
							["assets/marketplace", "dist/assets/marketplace"],
						],
						srcDir,
						buildDir,
					)
				})
			},
		},
		{
			name: "copyWasms",
			setup(build) {
				build.onEnd(() => copyWasms(srcDir, distDir))
			},
		},
		{
			name: "copyLocales",
			setup(build) {
				build.onEnd(() => copyLocales(srcDir, distDir))
			},
		},
		{
			name: "esbuild-problem-matcher",
			setup(build) {
				build.onStart(() => console.log("[esbuild-problem-matcher#onStart]"))
				build.onEnd((result) => {
					result.errors.forEach(({ text, location }) => {
						console.error(`✘ [ERROR] ${text}`)
						if (location && location.file) {
							console.error(`    ${location.file}:${location.line}:${location.column}:`)
						}
					})

					console.log("[esbuild-problem-matcher#onEnd]")
				})
			},
		},
	]

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const extensionConfig = {
		...buildOptions,
		plugins,
		entryPoints: ["extension.ts"],
		outfile: "dist/extension.js",
		// global-agent must be external because it dynamically patches Node.js http/https modules
		// which breaks when bundled. It needs access to the actual Node.js module instances.
		// undici must be bundled because our VSIX is packaged with `--no-dependencies`.
		external: ["vscode", "esbuild", "global-agent", "@vscode/ripgrep"],
	}

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const workerConfig = {
		...buildOptions,
		entryPoints: ["workers/countTokens.ts"],
		outdir: "dist/workers",
	}

	// The remote bridge is a standalone forked Node process (see issue #650).
	// It is bundled separately so the extension can `child_process.fork` it
	// from `dist/remote-bridge/main.js` when `zoo-code.remoteControl.enabled`
	// is on. node-ipc and the @roo-code/* workspace deps are bundled in.
	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const bridgeConfig = {
		...buildOptions,
		entryPoints: ["../packages/remote-bridge/src/main.ts"],
		outdir: "dist/remote-bridge",
		// The bridge runs as its own process, not in the extension host, so it
		// must not be treated as part of the extension bundle.
		external: [...(buildOptions.external ?? []), "vscode"],
	}

	const [extensionCtx, workerCtx, bridgeCtx] = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(workerConfig),
		esbuild.context(bridgeConfig),
	])

	if (watch) {
		await Promise.all([extensionCtx.watch(), workerCtx.watch(), bridgeCtx.watch()])
		copyLocales(srcDir, distDir)
		setupLocaleWatcher(srcDir, distDir)
	} else {
		// Run sequentially on rebuild to avoid Windows EBUSY races when both
		// onEnd hooks copy the same asset directories concurrently.
		await extensionCtx.rebuild()
		await workerCtx.rebuild()
		await bridgeCtx.rebuild()
		await Promise.all([extensionCtx.dispose(), workerCtx.dispose(), bridgeCtx.dispose()])
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})

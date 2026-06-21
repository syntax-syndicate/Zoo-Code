/**
 * Live end-to-end demo for the bridge --serve mode (the mode the extension
 * forks when `zoo-code.remoteControl.enabled` is on).
 *
 * Stands up a mock IPC server, forks the bundled bridge
 * (`src/dist/remote-bridge/main.js --serve`) as a real child process against
 * that socket, broadcasts a TaskEvent, and prints the ndjson line the bridge
 * streams to stdout. This proves the extension's fork path works end-to-end.
 *
 * Run from repo root:
 *   pnpm --filter @roo-code/remote-bridge exec tsx scripts/serve-demo.ts
 */
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { IpcServer } from "@roo-code/ipc"
import { IpcMessageType, IpcOrigin, RooCodeEventName, type TaskEvent } from "@roo-code/types"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function uniqueSocketPath(): string {
	return path.join(os.tmpdir(), `zoo-code-serve-demo-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
}

async function main() {
	const socketPath = uniqueSocketPath()
	try {
		fs.unlinkSync(socketPath)
	} catch {
		// ignore
	}

	const server = new IpcServer(socketPath, (...args) => process.stderr.write(`[mock-server] ${args.join(" ")}\n`))

	// Acknowledge connects; the bridge will log "connected".
	server.listen()
	process.stderr.write(`[serve-demo] mock IPC server listening on ${socketPath}\n`)

	// Fork the BUNDLED bridge (the same artifact the extension forks).
	const bundledMain = path.join(__dirname, "..", "..", "..", "src", "dist", "remote-bridge", "main.js")

	if (!fs.existsSync(bundledMain)) {
		process.stderr.write(
			`[serve-demo] bundled bridge not found at ${bundledMain}\n` +
				"  Run `pnpm --filter zoo-code bundle` (or `node src/esbuild.mjs`) first.\n",
		)
		process.exit(1)
	}

	const child = spawn("node", [bundledMain, "--socket", socketPath, "--serve"], {
		stdio: ["ignore", "pipe", "pipe"],
	})

	let gotEvent = false

	child.stdout.on("data", (chunk: Buffer) => {
		const line = chunk.toString().trim()

		// The bridge streams TaskEvents as ndjson; pretty-print each line.
		if (line.startsWith("{")) {
			process.stdout.write(`[serve-demo] bridge streamed: ${line}\n`)
			gotEvent = true
		}
	})

	child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[bridge] ${chunk.toString()}`))

	// Give the bridge a moment to connect, then broadcast a TaskEvent.
	await new Promise((resolve) => setTimeout(resolve, 500))

	process.stderr.write("[serve-demo] broadcasting taskStarted event\n")

	server.broadcast({
		type: IpcMessageType.TaskEvent,
		origin: IpcOrigin.Server,
		data: {
			eventName: RooCodeEventName.TaskStarted,
			payload: ["task-serve-demo-123"],
		} as TaskEvent,
	})

	// Wait for the bridge to stream it back.
	await new Promise((resolve) => setTimeout(resolve, 500))

	child.kill("SIGTERM")

	await new Promise<void>((resolve) => {
		child.on("close", (code) => {
			process.stderr.write(`\n[serve-demo] bridge exited with code ${code}\n`)
			resolve()
		})
	})

	try {
		fs.unlinkSync(socketPath)
	} catch {
		// ignore
	}

	process.exit(gotEvent ? 0 : 1)
}

void main()

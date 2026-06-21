#!/usr/bin/env node
/**
 * Remote Bridge — Phase 1 entry point.
 *
 * This is the forked Node process. It connects to the Zoo Code extension's IPC
 * server (the "API surface") over a Unix socket. It has two modes:
 *
 *  - one-shot (default): run a single API call, print the response, exit.
 *    Usage: tsx src/main.ts [--socket <path>] [--command get-modes|get-commands|get-models]
 *
 *  - long-running (--serve): stay connected, log every TaskEvent to stdout as
 *    newline-delimited JSON, and keep the process alive. This is the mode the
 *    extension forks when `zoo-code.remoteControl.enabled` is on. Later phases
 *    will replace the stdout log line with a WebRTC data channel forward.
 *    Usage: tsx src/main.ts --serve [--socket <path>]
 *
 * The socket path defaults to the `ROO_CODE_IPC_SOCKET_PATH` env var, matching
 * the variable the extension reads to start its IPC server.
 */
import os from "node:os"
import path from "node:path"

import { type TaskEvent, RooCodeEventName } from "@roo-code/types"

import { Bridge } from "./bridge.js"

type CommandName = "get-modes" | "get-commands" | "get-models"

interface CliArgs {
	socketPath: string
	serve: boolean
	command: CommandName
}

function defaultSocketPath(): string {
	// Mirror the extension's convention. The extension only starts its IPC
	// server when ROO_CODE_IPC_SOCKET_PATH is set (or when the remoteControl
	// setting is enabled), so we fall back to a sensible per-user default for
	// local dev/demo purposes.
	return process.env.ROO_CODE_IPC_SOCKET_PATH ?? path.join(os.tmpdir(), `zoo-code-${os.userInfo().uid}.sock`)
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		socketPath: defaultSocketPath(),
		serve: false,
		command: "get-modes",
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]

		if (arg === "--socket" || arg === "-s") {
			args.socketPath = argv[++i] ?? args.socketPath
		} else if (arg === "--serve") {
			args.serve = true
		} else if (arg === "--command" || arg === "-c") {
			const value = argv[++i] as CommandName | undefined
			if (!value) continue

			if (["get-modes", "get-commands", "get-models"].includes(value)) {
				args.command = value
			}
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				[
					"Usage: remote-bridge [--socket <path>] [--serve] [--command get-modes|get-commands|get-models]",
					"",
					"Connects to the Zoo Code IPC API surface.",
					"",
					"Modes:",
					"  (default)        Run a single API call, print the response, and exit.",
					"  --serve          Stay connected and stream TaskEvents as newline-delimited JSON.",
					"",
					"Options:",
					"  --socket, -s   Unix socket path (default: $ROO_CODE_IPC_SOCKET_PATH or /tmp/zoo-code-<uid>.sock)",
					"  --command, -c  API call to run in one-shot mode (default: get-modes)",
					"  --help, -h     Show this help",
				].join("\n") + "\n",
			)
			process.exit(0)
		}
	}

	return args
}

async function runCommand(bridge: Bridge, command: CommandName): Promise<TaskEvent> {
	switch (command) {
		case "get-modes":
			return bridge.getModes()
		case "get-commands":
			return bridge.getCommands()
		case "get-models":
			return bridge.getModels()
	}
}

/** Emit a TaskEvent to stdout as a single JSON line (the --serve wire format). */
function emitEvent(event: TaskEvent): void {
	process.stdout.write(JSON.stringify(event) + "\n")
}

async function runOneShot(bridge: Bridge, log: (...data: unknown[]) => void, command: CommandName): Promise<void> {
	log(`running command: ${command}`)

	try {
		const event = await runCommand(bridge, command)

		// Pretty-print the API response to stdout so it's easy to pipe/inspect.
		process.stdout.write(JSON.stringify(event, null, 2) + "\n")

		log(`received ${event.eventName} response`)
	} catch (error) {
		log(`command failed: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 1
	} finally {
		bridge.disconnect()
		// node-ipc keeps the event loop alive; the one-shot CLI must exit
		// explicitly once the API call has completed.
		process.exit(process.exitCode ?? 0)
	}
}

async function runServe(bridge: Bridge, log: (...data: unknown[]) => void): Promise<void> {
	// Forward every TaskEvent to stdout as newline-delimited JSON. Phase 2 will
	// replace this with a WebRTC data channel write.
	bridge.onEvent(RooCodeEventName.Message, emitEvent)
	bridge.onEvent(RooCodeEventName.TaskStarted, emitEvent)
	bridge.onEvent(RooCodeEventName.TaskCompleted, emitEvent)
	bridge.onEvent(RooCodeEventName.TaskAborted, emitEvent)
	bridge.onEvent(RooCodeEventName.TaskInteractive, emitEvent)
	bridge.onEvent(RooCodeEventName.TaskIdle, emitEvent)
	bridge.onEvent(RooCodeEventName.TaskAskResponded, emitEvent)
	bridge.onEvent(RooCodeEventName.TaskUserMessage, emitEvent)

	log("serving: streaming TaskEvents to stdout (ndjson). Ctrl-C to stop.")

	// Intentionally do not exit — the extension owns this process's lifetime.
}

async function main() {
	const args = parseArgs(process.argv.slice(2))

	const log = (...data: unknown[]) => process.stderr.write(`[remote-bridge] ${data.join(" ")}\n`)

	log(`connecting to IPC socket: ${args.socketPath}`)

	const bridge = new Bridge(args.socketPath, log)

	// Clean up on Ctrl-C / termination so we don't leak the socket client.
	const shutdown = (signal: string) => {
		log(`received ${signal}, disconnecting`)
		bridge.disconnect()
		process.exit(0)
	}

	process.on("SIGINT", () => shutdown("SIGINT"))
	process.on("SIGTERM", () => shutdown("SIGTERM"))

	try {
		await bridge.connect()
	} catch (error) {
		log(`failed to connect: ${error instanceof Error ? error.message : String(error)}`)
		log("hint: ensure the extension is running with the IPC server enabled on the same socket path")
		process.exit(1)
	}

	log(`connected (clientId ready=${bridge.isReady})`)

	if (args.serve) {
		await runServe(bridge, log)
	} else {
		await runOneShot(bridge, log, args.command)
	}
}

void main()

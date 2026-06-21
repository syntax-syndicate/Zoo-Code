import * as childProcess from "child_process"
import * as path from "path"

import type { LogFunction } from "../../utils/outputChannelLogger"

/**
 * RemoteBridgeHost owns the lifecycle of the forked remote-bridge Node process
 * (issue #650, Phase 1).
 *
 * When `zoo-code.remoteControl.enabled` is on, the extension forks the bundled
 * bridge (`dist/remote-bridge/main.js`) in `--serve` mode pointed at the IPC
 * socket. The bridge connects to the extension's `IpcServer` and streams
 * `TaskEvent`s. This host starts/stops/restarts that child process and pipes
 * its output to the Zoo Code output channel.
 *
 * The fork implementation is injectable so the lifecycle logic can be unit
 * tested without spawning real processes.
 */

export type ForkFn = (
	modulePath: string,
	args: string[],
	options: childProcess.ForkOptions,
) => childProcess.ChildProcess

export interface RemoteBridgeHostOptions {
	/** Absolute path to the bundled bridge entry (dist/remote-bridge/main.js). */
	bridgeModulePath: string
	/** Logger (typically the Zoo Code output channel). */
	log?: LogFunction
	/** Inject a fork implementation (defaults to child_process.fork). */
	fork?: ForkFn
	/** Max restart attempts after a crash before giving up. */
	maxRestarts?: number
	/** Base delay (ms) for restart backoff. */
	restartDelayMs?: number
}

export class RemoteBridgeHost {
	private readonly _bridgeModulePath: string
	private readonly _log: LogFunction
	private readonly _fork: ForkFn
	private readonly _maxRestarts: number
	private readonly _restartDelayMs: number

	private _child: childProcess.ChildProcess | undefined
	private _socketPath: string | undefined
	private _restartTimer: NodeJS.Timeout | undefined
	private _restartCount = 0
	private _stopped = false

	constructor(options: RemoteBridgeHostOptions) {
		this._bridgeModulePath = options.bridgeModulePath
		this._log = options.log ?? (() => {})
		this._fork = options.fork ?? childProcess.fork
		this._maxRestarts = options.maxRestarts ?? 5
		this._restartDelayMs = options.restartDelayMs ?? 2_000
	}

	public get isRunning(): boolean {
		return this._child !== undefined && !this._child.killed
	}

	public get socketPath(): string | undefined {
		return this._socketPath
	}

	/** Fork the bridge in --serve mode against the given socket path. */
	public start(socketPath: string): void {
		if (this.isRunning) {
			this._log(`[remote-bridge] start requested but already running on ${this._socketPath}`)
			return
		}

		this._stopped = false
		this._socketPath = socketPath
		this._restartCount = 0
		this.spawn()
	}

	/** Stop the bridge and cancel any pending restart. */
	public stop(): void {
		this._stopped = true

		if (this._restartTimer) {
			clearTimeout(this._restartTimer)
			this._restartTimer = undefined
		}

		const child = this._child

		if (child && !child.killed) {
			this._log(`[remote-bridge] stopping bridge process (pid=${child.pid})`)
			child.removeAllListeners()
			child.kill("SIGTERM")
		}

		this._child = undefined
	}

	/** Restart the bridge against the same socket path. */
	public restart(): void {
		if (!this._socketPath) {
			return
		}

		const socketPath = this._socketPath
		this.stop()
		this._stopped = false
		this._restartCount = 0
		this.start(socketPath)
	}

	public dispose(): void {
		this.stop()
	}

	private spawn(): void {
		const socketPath = this._socketPath

		if (!socketPath) {
			return
		}

		this._log(`[remote-bridge] forking bridge: ${this._bridgeModulePath} --socket ${socketPath} --serve`)

		let child: childProcess.ChildProcess

		try {
			child = this._fork(this._bridgeModulePath, ["--socket", socketPath, "--serve"], {
				stdio: ["ignore", "pipe", "pipe"],
			})
		} catch (error) {
			this._log(
				`[remote-bridge] failed to fork bridge: ${error instanceof Error ? error.message : String(error)}`,
			)
			this.scheduleRestart()
			return
		}

		this._child = child

		child.on("exit", (code, signal) => {
			this._log(`[remote-bridge] bridge process exited (code=${code}, signal=${signal})`)

			// Only the unexpected exits trigger restart; a deliberate stop()
			// sets _stopped and clears _child before the exit handler runs.
			if (this._child === child) {
				this._child = undefined

				if (!this._stopped) {
					this.scheduleRestart()
				}
			}
		})

		if (child.stdout) {
			child.stdout.on("data", (chunk: Buffer) => {
				this._log(`[remote-bridge:out] ${chunk.toString().trimEnd()}`)
			})
		}

		if (child.stderr) {
			child.stderr.on("data", (chunk: Buffer) => {
				this._log(`[remote-bridge:err] ${chunk.toString().trimEnd()}`)
			})
		}
	}

	private scheduleRestart(): void {
		if (this._stopped) {
			return
		}

		if (this._restartCount >= this._maxRestarts) {
			this._log(
				`[remote-bridge] giving up after ${this._restartCount} restart attempts. Re-enable Remote Control to retry.`,
			)
			return
		}

		const delay = this._restartDelayMs * Math.pow(2, this._restartCount)
		this._restartCount += 1

		this._log(`[remote-bridge] scheduling restart #${this._restartCount} in ${delay}ms`)

		this._restartTimer = setTimeout(() => {
			this._restartTimer = undefined
			this.spawn()
		}, delay)
	}
}

/**
 * Resolve the bundled bridge entry path relative to the extension's dist dir.
 * The extension is bundled to `dist/extension.js`, so `__dirname` is the dist
 * directory and the bridge lives at `dist/remote-bridge/main.js`.
 */
export function resolveBridgeModulePath(extensionDistDir: string): string {
	return path.join(extensionDistDir, "remote-bridge", "main.js")
}

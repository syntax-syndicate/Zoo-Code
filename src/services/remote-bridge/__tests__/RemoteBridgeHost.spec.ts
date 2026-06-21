import { EventEmitter } from "events"

import { RemoteBridgeHost, type ForkFn } from "../RemoteBridgeHost"

/**
 * A minimal ChildProcess stand-in for unit testing the host lifecycle without
 * spawning real processes. It implements the surface area the host touches:
 * pid, killed, kill(), removeAllListeners(), and stdout/stderr EventEmitters.
 */
function createFakeChild(): any {
	const child = new EventEmitter() as any
	child.pid = 12345
	child.killed = false
	child.stdout = new EventEmitter()
	child.stderr = new EventEmitter()
	child.kill = (signal?: string) => {
		child.killed = true
		// Defer the exit so listeners (registered after fork) receive it.
		setImmediate(() => child.emit("exit", 0, signal ?? null))
		return true
	}
	return child
}

describe("RemoteBridgeHost", () => {
	it("forks the bridge in --serve mode with the socket path", () => {
		const fork = vi.fn<ForkFn>(() => createFakeChild())
		const log = vi.fn()
		const host = new RemoteBridgeHost({
			bridgeModulePath: "/fake/dist/remote-bridge/main.js",
			log,
			fork,
		})

		host.start("/tmp/zoo-code.sock")

		expect(fork).toHaveBeenCalledTimes(1)
		expect(fork).toHaveBeenCalledWith(
			"/fake/dist/remote-bridge/main.js",
			["--socket", "/tmp/zoo-code.sock", "--serve"],
			expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
		)
		expect(host.isRunning).toBe(true)
		expect(host.socketPath).toBe("/tmp/zoo-code.sock")

		host.stop()
	})

	it("does not fork twice when already running", () => {
		const fork = vi.fn<ForkFn>(() => createFakeChild())
		const host = new RemoteBridgeHost({ bridgeModulePath: "/fake/main.js", fork })

		host.start("/tmp/sock")
		host.start("/tmp/sock")

		expect(fork).toHaveBeenCalledTimes(1)
		host.stop()
	})

	it("stop() kills the child and cancels restarts", () => {
		const child = createFakeChild()
		const fork = vi.fn<ForkFn>(() => child)
		const host = new RemoteBridgeHost({ bridgeModulePath: "/fake/main.js", fork })

		host.start("/tmp/sock")
		expect(host.isRunning).toBe(true)

		host.stop()

		expect(child.killed).toBe(true)
		expect(host.isRunning).toBe(false)
	})

	it("restarts with backoff after an unexpected exit", async () => {
		vi.useFakeTimers()
		const children: any[] = []
		const fork = vi.fn<ForkFn>(() => {
			const child = createFakeChild()
			children.push(child)
			return child
		})
		const log = vi.fn()
		const host = new RemoteBridgeHost({
			bridgeModulePath: "/fake/main.js",
			fork,
			log,
			maxRestarts: 3,
			restartDelayMs: 100,
		})

		host.start("/tmp/sock")
		expect(fork).toHaveBeenCalledTimes(1)

		// Simulate an unexpected crash (not via stop()).
		children[0]!.emit("exit", 1, null)

		// A restart should be scheduled with backoff.
		expect(log).toHaveBeenCalledWith(expect.stringContaining("scheduling restart #1"))

		// Advance past the first backoff delay (100 * 2^0 = 100ms).
		await vi.advanceTimersByTimeAsync(100)
		expect(fork).toHaveBeenCalledTimes(2)

		host.stop()
		vi.useRealTimers()
	})

	it("gives up after maxRestarts attempts", async () => {
		vi.useFakeTimers()
		const fork = vi.fn<ForkFn>(() => createFakeChild())
		const log = vi.fn()
		const host = new RemoteBridgeHost({
			bridgeModulePath: "/fake/main.js",
			fork,
			log,
			maxRestarts: 2,
			restartDelayMs: 50,
		})

		host.start("/tmp/sock")

		// Crash the first child.
		const first = fork.mock.results[0]!.value as any
		first.emit("exit", 1, null)
		await vi.advanceTimersByTimeAsync(50) // restart #1

		// Crash the second child.
		const second = fork.mock.results[1]!.value as any
		second.emit("exit", 1, null)
		await vi.advanceTimersByTimeAsync(100) // restart #2

		// Crash the third child — should give up, not schedule a 4th fork.
		const third = fork.mock.results[2]!.value as any
		third.emit("exit", 1, null)
		await vi.advanceTimersByTimeAsync(200)

		expect(fork).toHaveBeenCalledTimes(3)
		expect(log).toHaveBeenCalledWith(expect.stringContaining("giving up"))

		host.stop()
		vi.useRealTimers()
	})

	it("restart() stops and re-forks against the same socket", () => {
		const fork = vi.fn<ForkFn>(() => createFakeChild())
		const host = new RemoteBridgeHost({ bridgeModulePath: "/fake/main.js", fork })

		host.start("/tmp/sock")
		const firstChild = fork.mock.results[0]!.value as any

		host.restart()

		expect(firstChild.killed).toBe(true)
		expect(fork).toHaveBeenCalledTimes(2)
		expect(host.socketPath).toBe("/tmp/sock")

		host.stop()
	})

	it("pipes stdout/stderr to the logger", () => {
		const child = createFakeChild()
		const fork = vi.fn<ForkFn>(() => child)
		const log = vi.fn()
		const host = new RemoteBridgeHost({ bridgeModulePath: "/fake/main.js", fork, log })

		host.start("/tmp/sock")

		child.stdout.emit("data", Buffer.from("hello stdout\n"))
		child.stderr.emit("data", Buffer.from("hello stderr\n"))

		expect(log).toHaveBeenCalledWith(expect.stringContaining("hello stdout"))
		expect(log).toHaveBeenCalledWith(expect.stringContaining("hello stderr"))

		host.stop()
	})
})

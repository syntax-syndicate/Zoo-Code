# Remote Bridge

A forked Node.js process that connects to the Zoo Code extension's IPC **API surface** over a Unix socket. This is **Phase 1** of the Remote Control & Approval feature ([issue #650](https://github.com/Zoo-Code-Org/Zoo-Code/issues/650)).

## What Phase 1 does

- Spawns as a standalone Node process, **forked from the extension** when `zoo-code.remoteControl.enabled` is on.
- Connects to the extension's [`IpcServer`](../ipc/src/ipc-server.ts) using the same [`IpcClient`](../ipc/src/ipc-client.ts) the CLI uses.
- Can issue any [`TaskCommand`](../../packages/types/src/ipc.ts) (e.g. `GetModes`, `GetCommands`, `SendMessage`) and receive the resulting [`TaskEvent`](../../packages/types/src/events.ts) responses.
- In `--serve` mode (the mode the extension forks), stays connected and streams every `TaskEvent` to stdout as newline-delimited JSON. Phase 2 will replace this stdout line with a WebRTC data channel write.
- Proves the round-trip works via an integration test that stands up a real `IpcServer` and runs an API call through the `Bridge`.

What it does **not** do yet (later phases): WebRTC data channel, signaling, remote UI, push notifications.

## Architecture

```
┌──────────────────────┐   Unix socket    ┌──────────────────────┐
│  Zoo Code Extension  │ ◄──────────────► │  Bridge Process      │
│  (IpcServer)         │   /tmp/...sock    │  (IpcClient + Bridge)│
│  - Task engine       │                   │  - send commands     │
│  - Approval flow     │                   │  - receive events    │
└──────────────────────┘                   └──────────────────────┘
```

The socket path is the same one the extension already reads: the `ROO_CODE_IPC_SOCKET_PATH` environment variable. The extension starts its IPC server when either `zoo-code.remoteControl.enabled` is on **or** `ROO_CODE_IPC_SOCKET_PATH` is set, so the bridge is opt-in. The bridge process itself is only auto-forked when the setting is on (the env var alone is for headless/CLI use and does not auto-fork).

## Usage

### As a library

```typescript
import { Bridge } from "@roo-code/remote-bridge"

const bridge = new Bridge("/tmp/zoo-code.sock")
await bridge.connect()

// Issue an API call and await the response event.
const modes = await bridge.getModes()
console.log(modes.payload[0])

// Subscribe to live task events.
bridge.onEvent("taskStarted", (event) => console.log("started", event.payload[0]))

// Send a message to the active task.
bridge.sendMessage("hello from the bridge")

bridge.disconnect()
```

### As a CLI (demo / smoke test)

```bash
# 1. Start the extension with the IPC server enabled.
ROO_CODE_IPC_SOCKET_PATH=/tmp/zoo-code.sock code .

# 2. From the repo, run the bridge against that socket.
pnpm --filter @roo-code/remote-bridge start -- --socket /tmp/zoo-code.sock --command get-modes
```

The response event is pretty-printed to stdout; diagnostic logs go to stderr.

## Enabling from Zoo Code preferences

Toggle **Settings → Zoo Code → Remote Control: Enabled** (`zoo-code.remoteControl.enabled`). When on, the extension:

1. Starts its `IpcServer` on the configured socket (`zoo-code.remoteControl.socketPath`, or a per-user default under the system temp dir; `ROO_CODE_IPC_SOCKET_PATH` overrides if set).
2. Forks this bridge in `--serve` mode against that socket via [`RemoteBridgeHost`](../../src/services/remote-bridge/RemoteBridgeHost.ts), with crash-restart backoff.
3. Hot-toggles without a restart via a config-change listener in [`src/extension.ts`](../../src/extension.ts).

The bridge is bundled into the extension VSIX at `dist/remote-bridge/main.js` by [`src/esbuild.mjs`](../../src/esbuild.mjs).

## Scripts

| Script             | Description                                                                          |
| ------------------ | ------------------------------------------------------------------------------------ |
| `pnpm test`        | Run the vitest integration tests (stands up a real `IpcServer`).                     |
| `pnpm check-types` | `tsc --noEmit`.                                                                      |
| `pnpm lint`        | ESLint.                                                                              |
| `pnpm start`       | Run the one-shot CLI entry point via `tsx`.                                          |
| `pnpm demo`        | Fork the one-shot bridge against a mock server (live API call).                      |
| `pnpm demo:serve`  | Fork the bundled bridge in `--serve` mode against a mock server and stream an event. |

## Tests

The integration test in [`src/__tests__/bridge.test.ts`](src/__tests__/bridge.test.ts) creates a real `IpcServer` on a temporary socket, wires a command handler that mimics the extension's API (see [`src/extension/api.ts`](../../src/extension/api.ts)), and verifies that a `Bridge` can:

1. Connect and receive its `Ack`.
2. Issue `GetModes` and receive the `ModesResponse` event.
3. Forward broadcast `TaskEvent`s to `onEvent` subscribers (and unsubscribe correctly).
4. Reject `request()` on timeout when no response arrives.

This is the proof that the forked process can talk to the API surface.

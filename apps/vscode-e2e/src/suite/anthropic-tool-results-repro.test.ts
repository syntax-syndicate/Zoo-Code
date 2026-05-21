import * as assert from "assert"
import * as fs from "fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor } from "./utils"

type CapturedAnthropicRequest = {
	messages: Array<{
		role?: string
		content?: unknown
	}>
}

const ANTHROPIC_MESSAGES_PATH = "/v1/messages"
const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com"
// Substring of the real Anthropic API error we want to surface in real-endpoint mode.
// The model returns "messages.N: tool_use ids were found without tool_result blocks
// immediately after:" — we match on the stable part so test output stays deterministic
// across API wording tweaks.
const TOOL_RESULT_CONTRACT_ERROR = "tool_use ids were found without tool_result blocks"

// IDs the matching fixture (apps/vscode-e2e/fixtures/anthropic-tool-results-repro.json)
// emits for the four parallel read_file tool calls on turn 1. Kept in sync with that file.
const FIXTURE_TOOL_USE_IDS = [
	"toolu_repro_190_read_1",
	"toolu_repro_190_read_2",
	"toolu_repro_190_read_3",
	"toolu_repro_190_read_4",
]

const ALLOWED_PROXY_HOSTS = new Set(["127.0.0.1", "localhost", "api.anthropic.com"])

function isMessagesUrl(rawUrl: string): boolean {
	try {
		return new URL(rawUrl).pathname.endsWith(ANTHROPIC_MESSAGES_PATH)
	} catch {
		return false
	}
}

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})
}

function writeResponseHeaders(target: ServerResponse, source: Response) {
	const headers: Record<string, string> = {}
	source.headers.forEach((value, key) => {
		if (key.toLowerCase() !== "content-length") {
			headers[key] = value
		}
	})
	target.writeHead(source.status, headers)
}

async function pipeFetchResponse(target: ServerResponse, source: Response) {
	writeResponseHeaders(target, source)

	if (!source.body) {
		target.end()
		return
	}

	const reader = source.body.getReader()
	while (true) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		target.write(value)
	}

	target.end()
}

function resolveAllowedUpstreamUrl(baseUrl: string): URL {
	const upstreamBase = new URL(baseUrl)
	const isLocalProxy = upstreamBase.hostname === "127.0.0.1" || upstreamBase.hostname === "localhost"

	if (
		!ALLOWED_PROXY_HOSTS.has(upstreamBase.hostname) ||
		(isLocalProxy ? upstreamBase.protocol !== "http:" : baseUrl !== ANTHROPIC_API_ORIGIN)
	) {
		throw new Error(`Unexpected Anthropic proxy target: ${upstreamBase.origin}`)
	}

	return new URL(ANTHROPIC_MESSAGES_PATH, upstreamBase)
}

async function withAnthropicProxy<T>(
	baseUrl: string,
	run: (args: { proxyUrl: string; requests: CapturedAnthropicRequest[] }) => Promise<T>,
): Promise<T> {
	const requests: CapturedAnthropicRequest[] = []
	let proxyError: Error | undefined

	const server = createServer(async (req, res) => {
		try {
			const requestUrl = req.url ?? "/"

			if (!isMessagesUrl(`http://127.0.0.1${requestUrl}`)) {
				res.writeHead(404)
				res.end("Not found")
				return
			}

			const bodyText = await readRequestBody(req)
			const body = JSON.parse(bodyText) as CapturedAnthropicRequest
			requests.push({ messages: body.messages ?? [] })

			const forwardHeaders: Record<string, string> = {}
			for (const [key, value] of Object.entries(req.headers)) {
				if (
					key.toLowerCase() !== "host" &&
					key.toLowerCase() !== "content-length" &&
					typeof value === "string"
				) {
					forwardHeaders[key] = value
				}
			}

			const upstreamUrl = resolveAllowedUpstreamUrl(baseUrl)
			const upstream = await fetch(upstreamUrl, {
				method: req.method,
				headers: forwardHeaders,
				body: bodyText,
			})

			await pipeFetchResponse(res, upstream)
		} catch (error) {
			proxyError = error instanceof Error ? error : new Error(String(error))
			console.error("Anthropic repro proxy request failed:", proxyError)
			if (!res.headersSent) {
				res.writeHead(500)
			}
			res.end("Anthropic proxy request failed")
		}
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
	const address = server.address()
	if (!address || typeof address === "string") {
		server.close()
		throw new Error("Failed to start Anthropic repro proxy server")
	}

	const proxyUrl = `http://127.0.0.1:${address.port}`

	try {
		const result = await run({ proxyUrl, requests })
		if (proxyError) {
			throw proxyError
		}
		return result
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	}
}

function getLastUserMessage(messages: CapturedAnthropicRequest["messages"]) {
	return [...messages].reverse().find((message) => message.role === "user")
}

function extractToolResultIds(content: unknown): string[] {
	if (!Array.isArray(content)) {
		return []
	}

	return content
		.filter(
			(block): block is { type: "tool_result"; tool_use_id: string } =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				(block as { type?: string }).type === "tool_result",
		)
		.map((block) => block.tool_use_id)
}

// In real-endpoint mode we forward to api.anthropic.com but only see request bodies,
// not responses. An assistant message's tool_use blocks only become visible to us on
// the *next* request body (when the agent appends them to history). Returns the maximum
// tool_use block count across all captured assistant messages.
function maxAssistantParallelToolUses(requests: CapturedAnthropicRequest[]): number {
	let max = 0
	for (const req of requests) {
		for (const msg of req.messages) {
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
			let count = 0
			for (const block of msg.content) {
				if (
					typeof block === "object" &&
					block !== null &&
					"type" in block &&
					(block as { type?: string }).type === "tool_use"
				) {
					count++
				}
			}
			if (count > max) max = count
		}
	}
	return max
}

suite("Anthropic tool_result repro", function () {
	setDefaultSuiteTimeout(this)
	this.timeout(8 * 60_000)

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

	if (!workspaceRoot) {
		throw new Error("No workspace root found for Anthropic tool_result repro")
	}

	const fixtureDir = path.join(workspaceRoot, "anthropic-tool-results-repro")
	const fixtureFiles = [
		path.join(fixtureDir, "file-1.txt"),
		path.join(fixtureDir, "file-2.txt"),
		path.join(fixtureDir, "file-3.txt"),
		path.join(fixtureDir, "file-4.txt"),
	]

	suiteSetup(async () => {
		await fs.rm(fixtureDir, { recursive: true, force: true })
		await fs.mkdir(fixtureDir, { recursive: true })
		await Promise.all(
			fixtureFiles.map((filePath, index) =>
				fs.writeFile(filePath, `anthropic repro file ${index + 1}\n`, "utf8"),
			),
		)
	})

	suiteTeardown(async () => {
		await fs.rm(fixtureDir, { recursive: true, force: true })

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	test("should send matching tool_result blocks after a four-tool Anthropic response", async function () {
		const api = globalThis.api
		const aimockUrl = process.env.AIMOCK_URL
		const realAnthropicKey = process.env.ANTHROPIC_API_KEY
		const isRecord = process.env.AIMOCK_RECORD === "true"
		const useRealEndpoint = !!realAnthropicKey && !aimockUrl

		// Mock mode requires aimock (which serves the matching fixture). Real mode requires
		// ANTHROPIC_API_KEY and no aimock running (so the proxy forwards to api.anthropic.com).
		if (!aimockUrl && !realAnthropicKey) {
			this.skip()
		}

		const captureBaseUrl = useRealEndpoint ? ANTHROPIC_API_ORIGIN : aimockUrl!
		let taskCompleted = false
		let taskId: string | undefined
		const apiErrors: string[] = []

		const onTaskCompleted = (completedTaskId: string) => {
			if (completedTaskId === taskId) {
				taskCompleted = true
			}
		}

		const onMessage = ({ message }: { message: ClineMessage }) => {
			// API failures on the first chunk surface as ask("api_req_failed", error.message).
			// Mid-stream / other failures surface as say("error", ...). Capture both so the
			// real-endpoint mode can detect Anthropic's tool_use/tool_result contract error.
			if (typeof message.text !== "string") {
				return
			}
			if (message.type === "ask" && message.ask === "api_req_failed") {
				apiErrors.push(message.text)
			} else if (message.type === "say" && message.say === "error") {
				apiErrors.push(message.text)
			}
		}

		api.on(RooCodeEventName.TaskCompleted, onTaskCompleted)
		api.on(RooCodeEventName.Message, onMessage)

		try {
			await withAnthropicProxy(captureBaseUrl, async ({ proxyUrl, requests }) => {
				// In mock mode the API key just has to be non-empty so the SDK constructs a client.
				// In real / record mode the actual ANTHROPIC_API_KEY is forwarded through the proxy
				// (and aimock, when present) so upstream auth succeeds.
				await api.setConfiguration({
					apiProvider: "anthropic" as const,
					apiKey: aimockUrl && !isRecord ? "mock-key" : realAnthropicKey!,
					apiModelId: "claude-opus-4-7",
					anthropicBaseUrl: proxyUrl,
				})

				taskId = await api.startNewTask({
					configuration: {
						mode: "code",
						autoApprovalEnabled: true,
						alwaysAllowReadOnly: true,
						alwaysAllowReadOnlyOutsideWorkspace: true,
						disabledTools: ["execute_command", "read_command_output"],
					},
					text:
						"anthropic-tool-results-repro: use only read_file to read the four files in anthropic-tool-results-repro " +
						"(file-1.txt, file-2.txt, file-3.txt, file-4.txt) in parallel, then report that you finished. " +
						"Do not run shell commands.",
				})

				if (useRealEndpoint) {
					// Real mode: wait for either task completion or an Anthropic contract violation
					// surfaced via api_req_failed. Don't pin specific tool ids (Claude is free to
					// pick its own), but after the run we DO require evidence that the agent
					// actually exercised the parallel-tool path the bug report described — a
					// sequential read of all four files would never hit the failure mode and would
					// give us a false-negative pass.
					await waitFor(
						() => taskCompleted || apiErrors.some((text) => text.includes(TOOL_RESULT_CONTRACT_ERROR)),
						{ timeout: 6 * 60_000, interval: 500 },
					)

					const contractViolation = apiErrors.find((text) => text.includes(TOOL_RESULT_CONTRACT_ERROR))
					assert.strictEqual(
						contractViolation,
						undefined,
						`Anthropic rejected a request with a tool_use/tool_result contract violation.\n` +
							`error=${contractViolation}\n` +
							`requestsCaptured=${requests.length}`,
					)

					assert.ok(taskCompleted, "Task should complete against the real Anthropic endpoint")

					const maxParallel = maxAssistantParallelToolUses(requests)
					if (maxParallel < 2) {
						// Inconclusive: the model picked a non-parallel path so this run never
						// stressed the codepath the issue describes. Mark the test pending instead
						// of green so a passing CI signal doesn't imply we proved the fix end-to-end.
						console.warn(
							`Anthropic repro: model used at most ${maxParallel} parallel tool_use block(s) per turn ` +
								`(need >=2 to exercise the bug). Skipping rather than reporting a green pass.`,
						)
						this.skip()
					}
					return
				}

				// Mock mode: aimock serves the fixture (4 parallel read_file toolCalls on turn 1,
				// attempt_completion on turn 2). Wait for the second /v1/messages and assert it
				// carries 4 matching tool_result IDs.
				await waitFor(() => taskCompleted || requests.length >= 2, {
					timeout: 120_000,
					interval: 250,
				})
				await waitFor(() => requests.length >= 2, { timeout: 30_000, interval: 250 })

				if (!taskCompleted) {
					await waitFor(() => taskCompleted, { timeout: 30_000, interval: 250 })
				}

				const secondRequest = requests[1]
				assert.ok(secondRequest, "Expected Anthropic repro to issue a second /v1/messages request")

				const lastUserMessage = getLastUserMessage(secondRequest.messages)
				const presentToolResultIds = extractToolResultIds(lastUserMessage?.content)

				assert.deepStrictEqual(
					presentToolResultIds,
					FIXTURE_TOOL_USE_IDS,
					`Expected matching tool_result IDs in the second Anthropic request.\nexpected=${JSON.stringify(FIXTURE_TOOL_USE_IDS)}\nactual=${JSON.stringify(presentToolResultIds)}\nlastUser=${JSON.stringify(lastUserMessage?.content)}`,
				)
			})
		} finally {
			api.off(RooCodeEventName.TaskCompleted, onTaskCompleted)
			api.off(RooCodeEventName.Message, onMessage)

			if (taskId && !taskCompleted) {
				try {
					await api.cancelCurrentTask()
				} catch {
					// Best effort cleanup only.
				}
				await sleep(500)
			}
		}
	})
})

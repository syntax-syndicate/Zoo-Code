// npx vitest run core/condense/__tests__/getEffectiveApiHistory-orphan-toolUse.spec.ts

import { describe, expect, it, vi } from "vitest"

import { TelemetryService } from "@roo-code/telemetry"

import { ApiMessage } from "../../task-persistence/apiMessages"
import { MissingToolResultError } from "../../task/validateToolResultIds"
import { SYNTHETIC_TOOL_RESULT_REASONS, getEffectiveApiHistory, injectSyntheticToolResults } from "../index"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn(() => true),
		instance: {
			captureContextCondensed: vi.fn(),
			captureException: vi.fn(),
		},
	},
}))

// Regression guard for issue #190. The send path in Task.ts runs
//
//   injectSyntheticToolResults(getEffectiveApiHistory(history), "historyShaping")
//
// to ensure that even after truncation/condensation filtering, every assistant tool_use
// has a paired user-side tool_result. This spec exercises that exact composition: it
// fails on the raw output of getEffectiveApiHistory (which by itself can strand a
// tool_use whose result was truncated), and passes once injectSyntheticToolResults runs.
// The fix is intentionally applied at the send path rather than inside
// getEffectiveApiHistory — its other two callers (Task.ts:945 and
// apiConversationHistory.ts:110) peek at lastEffective.role for insert-time validation
// and would be confused by a synthetic trailing user message.
function effectiveApiHistoryForSend(messages: ApiMessage[]): ApiMessage[] {
	return injectSyntheticToolResults(getEffectiveApiHistory(messages), SYNTHETIC_TOOL_RESULT_REASONS.historyShaping)
}

// Anthropic's contract: every assistant message containing tool_use blocks must be
// immediately followed by a user message whose content carries tool_result blocks for
// each one of those tool_use ids. A "some tool_result with this id exists somewhere
// later" assertion is too loose — it accepts a trailing-append fix that still violates
// the protocol when other messages sit between the orphan and the synthetic pad.
function assertContractPaired(result: ApiMessage[]): void {
	for (let i = 0; i < result.length; i++) {
		const msg = result[i]
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
		const toolUseIds: string[] = []
		for (const block of msg.content) {
			if (block.type === "tool_use") {
				toolUseIds.push(block.id)
			}
		}
		if (toolUseIds.length === 0) continue

		const next = result[i + 1]
		expect(next, `assistant message at index ${i} has tool_use blocks but no following message`).toBeDefined()
		expect(
			next.role,
			`message at index ${i + 1} must be a user message paired to the assistant tool_use at ${i}`,
		).toBe("user")
		expect(
			Array.isArray(next.content),
			`message at index ${i + 1} must have block content carrying tool_results`,
		).toBe(true)

		const nextResultIds = (next.content as Array<{ type: string; tool_use_id?: string }>)
			.filter((b) => b.type === "tool_result")
			.map((b) => b.tool_use_id as string)
		for (const id of toolUseIds) {
			expect(
				nextResultIds,
				`tool_use ${id} at index ${i} must be paired in the immediately-following user message`,
			).toContain(id)
		}
	}
}

describe("getEffectiveApiHistory tool_use / tool_result pairing across truncation", () => {
	it("does not leave an assistant tool_use unpaired when the user tool_result message is truncated", () => {
		const truncationId = "trunc-pairing-1"
		const toolUseId = "toolu_repro_190_pair_1"

		const messages: ApiMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Please read the file." }],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: toolUseId,
						name: "read_file",
						input: { path: "foo.txt" },
					},
				],
			},
			// User message carrying only the tool_result, tagged for truncation.
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUseId,
						content: "file contents",
					},
				],
				truncationParent: truncationId,
			},
			// Truncation marker that activates the truncationParent filter above.
			{
				role: "user",
				content: [{ type: "text", text: "[history truncated]" }],
				isTruncationMarker: true,
				truncationId,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Here is the next step." }],
			},
		]

		const result = effectiveApiHistoryForSend(messages)
		assertContractPaired(result)
	})

	it("does not leave an assistant tool_use unpaired when the truncated user message also carried text content", () => {
		// Same shape, but the user message has a text block alongside the tool_result.
		// This proves we're not only protected by full-message removal: block-level filtering
		// must not silently drop a tool_result while keeping the rest of the message.
		const truncationId = "trunc-pairing-2"
		const toolUseId = "toolu_repro_190_pair_2"

		const messages: ApiMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Please read the file." }],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: toolUseId,
						name: "read_file",
						input: { path: "foo.txt" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUseId,
						content: "file contents",
					},
					{ type: "text", text: "Continue with the next step." },
				],
				truncationParent: truncationId,
			},
			{
				role: "user",
				content: [{ type: "text", text: "[history truncated]" }],
				isTruncationMarker: true,
				truncationId,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Here is the next step." }],
			},
		]

		const result = effectiveApiHistoryForSend(messages)
		assertContractPaired(result)
	})

	it("does not leave an assistant tool_use unpaired in the summary (fresh-start) branch", () => {
		// Summary-branch path of getEffectiveApiHistory: only messages from the most recent
		// summary onwards are kept, and orphan tool_result blocks referencing pre-summary
		// tool_use IDs are filtered. This case constructs the inverse: an assistant tool_use
		// lands inside the summary range, but its tool_result was on a pre-summary user
		// message (condensed away). Without pairing, the surviving tool_use is stranded.
		const condenseId = "cond-pairing-1"
		const toolUseId = "toolu_repro_190_summary_1"

		const messages: ApiMessage[] = [
			// Pre-summary: user message that carried the tool_result. Tagged so the summary
			// branch filters it out via the "messages.slice(summaryIndex)" cut.
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUseId,
						content: "file contents",
					},
				],
				condenseParent: condenseId,
			},
			// Summary marker.
			{
				role: "user",
				content: [{ type: "text", text: "Summary of prior work." }],
				isSummary: true,
				condenseId,
			},
			// Post-summary assistant message with a tool_use whose matching tool_result is now
			// gone. This is an artificial but representative shape — any history-shaping path
			// that leaves a tool_use without a paired result downstream produces this.
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: toolUseId,
						name: "read_file",
						input: { path: "foo.txt" },
					},
				],
			},
		]

		const result = effectiveApiHistoryForSend(messages)
		assertContractPaired(result)
	})

	it("inserts the synthetic tool_result whose tool_use_id exactly matches each orphan immediately after the assistant message, and reports telemetry", () => {
		// Tightening assertion: the previous cases just check that *some* tool_result with the
		// orphan id exists in the surviving history. That would pass even if the synthetic block
		// targeted the wrong id (e.g. off-by-one). Here we pin the appended message to be a fresh
		// user message containing exactly the expected synthetic results, and we verify the
		// MissingToolResultError telemetry the send-path uses to confirm this guard fired.
		const captureException = TelemetryService.instance.captureException as ReturnType<typeof vi.fn>
		captureException.mockClear()

		const truncationId = "trunc-pairing-exact"
		const orphanedToolUseId = "toolu_repro_190_exact_1"

		const messages: ApiMessage[] = [
			{ role: "user", content: [{ type: "text", text: "Please read the file." }] },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: orphanedToolUseId,
						name: "read_file",
						input: { path: "foo.txt" },
					},
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: orphanedToolUseId, content: "file contents" }],
				truncationParent: truncationId,
			},
			{
				role: "user",
				content: [{ type: "text", text: "[history truncated]" }],
				isTruncationMarker: true,
				truncationId,
			},
		]

		const result = effectiveApiHistoryForSend(messages)
		assertContractPaired(result)

		// Find the assistant message holding the orphan tool_use, then assert the message
		// immediately after it is a fresh synthetic user message whose only block is a
		// tool_result targeting the exact orphan id with the expected reason text.
		const orphanAssistantIndex = result.findIndex(
			(m) =>
				m.role === "assistant" &&
				Array.isArray(m.content) &&
				m.content.some((b) => b.type === "tool_use" && b.id === orphanedToolUseId),
		)
		expect(orphanAssistantIndex).toBeGreaterThanOrEqual(0)

		const synthetic = result[orphanAssistantIndex + 1]
		expect(synthetic.role).toBe("user")
		expect(Array.isArray(synthetic.content)).toBe(true)
		const syntheticBlocks = synthetic.content as Array<{
			type: string
			tool_use_id?: string
			content?: unknown
		}>
		expect(syntheticBlocks).toHaveLength(1)
		expect(syntheticBlocks[0].type).toBe("tool_result")
		expect(syntheticBlocks[0].tool_use_id).toBe(orphanedToolUseId)
		expect(syntheticBlocks[0].content).toBe(SYNTHETIC_TOOL_RESULT_REASONS.historyShaping)

		// Telemetry: one capture, with the orphan id and reason in the payload so dashboards
		// can correlate this guard's activation across sources.
		expect(captureException).toHaveBeenCalledTimes(1)
		const [errorArg, metaArg] = captureException.mock.calls[0]
		expect(errorArg).toBeInstanceOf(MissingToolResultError)
		expect((errorArg as MissingToolResultError).missingToolUseIds).toEqual([orphanedToolUseId])
		expect(metaArg).toMatchObject({
			reason: SYNTHETIC_TOOL_RESULT_REASONS.historyShaping,
			missingToolUseIds: [orphanedToolUseId],
			source: "injectSyntheticToolResults",
		})
	})

	it("pairs a mid-history orphan tool_use when another assistant message follows it", () => {
		// Direct reproduction of the reviewer-flagged shape: after history shaping, the
		// surviving order is [user, assistant(tool_use), user(text-only), assistant(text)].
		// A trailing-append fix would put the synthetic tool_result at position 4, two
		// messages after the orphan tool_use, violating Anthropic's "immediately following
		// user message must carry tool_result" contract.
		const truncationId = "trunc-mid-history"
		const toolUseId = "toolu_repro_190_mid_history_1"

		const messages: ApiMessage[] = [
			{ role: "user", content: [{ type: "text", text: "Please read the file." }] },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: toolUseId,
						name: "read_file",
						input: { path: "foo.txt" },
					},
				],
			},
			// This was the user message that carried the tool_result; truncation tags it.
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: toolUseId, content: "file contents" }],
				truncationParent: truncationId,
			},
			// Truncation marker (text-only user message) — survives the filter.
			{
				role: "user",
				content: [{ type: "text", text: "[history truncated]" }],
				isTruncationMarker: true,
				truncationId,
			},
			// Assistant follow-up text — survives the filter. This is what lands at the tail
			// in the previous (incorrect) fix's output, making a trailing append insufficient.
			{
				role: "assistant",
				content: [{ type: "text", text: "Here is the next step." }],
			},
		]

		const result = effectiveApiHistoryForSend(messages)

		assertContractPaired(result)

		// Spot-check the exact splice: the message right after the orphan assistant is the
		// synthetic, and the trailing assistant text message is preserved further down.
		const orphanAssistantIndex = result.findIndex(
			(m) =>
				m.role === "assistant" &&
				Array.isArray(m.content) &&
				m.content.some((b) => b.type === "tool_use" && b.id === toolUseId),
		)
		expect(orphanAssistantIndex).toBeGreaterThanOrEqual(0)
		const splice = result[orphanAssistantIndex + 1]
		expect(splice.role).toBe("user")
		expect(Array.isArray(splice.content)).toBe(true)
		const spliceBlocks = splice.content as Array<{ type: string; tool_use_id?: string }>
		expect(spliceBlocks.some((b) => b.type === "tool_result" && b.tool_use_id === toolUseId)).toBe(true)
		// And the originally-surviving assistant follow-up text is still present somewhere later.
		const tailHasText = result
			.slice(orphanAssistantIndex + 2)
			.some(
				(m) =>
					m.role === "assistant" &&
					Array.isArray(m.content) &&
					m.content.some((b) => b.type === "text" && b.text === "Here is the next step."),
			)
		expect(tailHasText).toBe(true)
	})
})

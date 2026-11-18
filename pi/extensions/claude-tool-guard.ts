/**
 * Claude tool guard: Claude Code rejects a history where a tool call has no result, and
 * turns that errored or were aborted can leave such calls behind. This guard rewrites the
 * transcript before a claude-code request: it drops failed assistant turns, removes stray
 * tool results, and pairs every remaining tool call with a result.
 */
import type { ContextWithSystemEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextWithSystemEvent["messages"][number];

type PendingToolCall = { id: string; name: string };

/** Roles that `convertToLlm` turns into a user message. */
function isUserProducing(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "bashExecution":
			return !message.excludeFromContext;
		default:
			return false;
	}
}

/**
 * Drops failed assistant turns and stray tool results, and fills a synthetic error result
 * for every tool call left without one, so the history is valid for Claude Code.
 */
export function sanitizeClaudeMessages(messages: readonly AgentMessage[]): {
	messages: AgentMessage[];
	changed: boolean;
} {
	const output: AgentMessage[] = [];
	let pendingToolCalls: PendingToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	let pendingTimestamp = 0;
	let changed = false;

	function closePendingToolCalls() {
		for (const toolCall of pendingToolCalls) {
			if (existingToolResultIds.has(toolCall.id)) continue;
			output.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: pendingTimestamp,
			});
			changed = true;
		}
		pendingToolCalls = [];
		existingToolResultIds = new Set();
	}

	for (const message of messages) {
		if (message.role === "assistant") {
			closePendingToolCalls();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				changed = true;
				continue;
			}
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block?.type !== "toolCall") continue;
					if (typeof block.id !== "string" || typeof block.name !== "string") continue;
					pendingToolCalls.push({ id: block.id, name: block.name });
				}
			}
			pendingTimestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
			output.push(message);
			continue;
		}

		if (message.role === "toolResult") {
			const matchesPending = pendingToolCalls.some((toolCall) => toolCall.id === message.toolCallId);
			if (matchesPending && !existingToolResultIds.has(message.toolCallId)) {
				existingToolResultIds.add(message.toolCallId);
				output.push(message);
			} else {
				changed = true;
			}
			continue;
		}

		// System messages stay where they are: the leading one carries the prompt and tools.
		if (message.role === "system") {
			output.push(message);
			continue;
		}

		if (isUserProducing(message)) closePendingToolCalls();
		output.push(message);
	}

	closePendingToolCalls();
	return { messages: output, changed };
}

export default function claudeToolGuard(pi: ExtensionAPI) {
	// `context_with_system` keeps system messages intact; `context` would collapse them.
	pi.on("context_with_system", (event, ctx) => {
		if (ctx.model?.provider !== "claude-code") return;
		const result = sanitizeClaudeMessages(event.messages);
		if (!result.changed) return;
		return { messages: result.messages };
	});
}

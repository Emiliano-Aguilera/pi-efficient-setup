/**
 * delegate_task is async-only.
 *
 * A `mode:"wait"` call holds the MCP request open for up to `timeoutMs`. T3's MCP
 * bridge runs inside pi, so pi's HTTP idle timeout (default 5 min) kills the
 * request first: the tool reports "fetch failed" while the child keeps running,
 * and a retry starts a duplicate. Keeping every call async avoids the wait.
 *
 * The prompt section tells the model the convention; the tool_call handler
 * enforces it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionRole } from "./role-guard.ts";

const DELEGATE_TOOL = "delegate_task";
const SECTION = "delegate_task";

const RULE =
	'`delegate_task` is async-only here: use `mode:"async"`, never `mode:"wait"`. After it returns a running task, end your turn; its completion wakes this thread.';

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const prompt = event.messageType === "user" ? event.prompt : "";
		if (sessionRole(ctx, prompt) !== undefined) {
			delete event.systemPromptOptions.sections[SECTION];
			return;
		}
		event.systemPromptOptions.sections[SECTION] = RULE;
	});

	pi.on("tool_call", (event) => {
		if (!event.toolName.endsWith(DELEGATE_TOOL)) return;
		const input = event.input as Record<string, unknown>;
		if (input.mode !== "wait") return;
		input.mode = "async";
		delete input.timeoutMs;
	});
}

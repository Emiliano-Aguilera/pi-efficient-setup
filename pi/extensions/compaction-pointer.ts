/**
 * After a compaction, tells the agent where the full record of the conversation
 * is and how to get a detail back without reading it into its own context.
 *
 * Compaction replaces old messages with a summary but leaves them in the
 * session file. The agent has no way to know that unless it is told.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = "compacted_history";

export default function compactionPointer(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		const compacted = ctx.sessionManager.getBranch().some((entry) => entry.type === "compaction");
		if (!file || !compacted) {
			delete event.systemPromptOptions.sections[SECTION];
			return;
		}
		event.systemPromptOptions.sections[SECTION] = [
			"Earlier parts of this conversation were replaced by a summary. The full record is the file below. It is JSON lines with whole tool outputs on single lines, so never open it and never grep it directly: the result is unreadable and misses things.",
			`File: ${file}`,
			"Use exactly this file. The other files in its folder are other conversations.",
			"To get a detail the summary lacks (an exact string, the reason for a decision, something the user said):",
			"1. If you have a `delegate_task` tool, send a child agent, so the record stays out of your context. Its task starts with `Role: bash-runner`, names the file, asks one specific question, and tells it to search with the command in step 2 and to answer in a few lines with the exact quote.",
			`2. Otherwise search it yourself with this command and read only the matching lines: \`transcript-text '${file}' | grep -n -i -C2 '<term>'\``,
		].join("\n");
	});
}

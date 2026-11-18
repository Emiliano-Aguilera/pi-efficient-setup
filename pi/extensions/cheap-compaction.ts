/**
 * Cheap compaction: summarizes conversations on a cheaper Pi model instead of
 * the main coordinator model (e.g. Opus/Sonnet).
 *
 * Note: Pi cannot call T3's `antigravity` (`agy`) instance directly, so every
 * candidate here must be a provider registered in Pi.
 */
import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS, type RetryPolicy } from "@earendil-works/pi-ai";
import { compact, getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

const MODEL_CHAIN = [
	// Add cheaper Pi-configured models above Haiku if you have them, e.g.:
	// { provider: "mistral", id: "deepseek-v4-1-flash-1017", thinking: "high" },
	{ provider: "claude-code", id: "claude-haiku-5-5", thinking: "medium" },
] as const;

const quotaExhausted = new Set<string>();

function buildRetryPolicy(pi: ExtensionAPI): RetryPolicy {
	const retry = pi.getSettings().retry;
	return {
		enabled: retry?.enabled ?? true,
		maxRetries: retry?.maxRetries ?? 3,
		baseDelayMs: retry?.baseDelayMs ?? 2000,
		maxAgentDelayMs: retry?.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	};
}

function withPreviousHookFiles(
	preparation: SessionBeforeCompactEvent["preparation"],
	branchEntries: SessionEntry[],
): SessionBeforeCompactEvent["preparation"] {
	const prev = getLatestCompactionEntry(branchEntries);
	if (!prev?.fromHook || !prev.details || typeof prev.details !== "object") {
		return preparation;
	}
	const details = prev.details as { readFiles?: unknown; modifiedFiles?: unknown };
	const read = new Set(preparation.fileOps.read);
	const written = new Set(preparation.fileOps.written);
	const edited = new Set(preparation.fileOps.edited);
	if (Array.isArray(details.readFiles)) {
		for (const file of details.readFiles) {
			if (typeof file === "string") read.add(file);
		}
	}
	if (Array.isArray(details.modifiedFiles)) {
		for (const file of details.modifiedFiles) {
			if (typeof file === "string") edited.add(file);
		}
	}
	return {
		...preparation,
		fileOps: { read, written, edited },
	};
}

function hasSummaryContent(summary: string): boolean {
	const stripped = summary
		.replace(/<read-files>[\s\S]*?<\/read-files>/g, "")
		.replace(/<modified-files>[\s\S]*?<\/modified-files>/g, "")
		.trim();
	return stripped.length > 0;
}

export default function cheapCompaction(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		if (event.signal.aborted) return { cancel: true };

		const preparation = withPreviousHookFiles(event.preparation, event.branchEntries);
		const retry = buildRetryPolicy(pi);
		const streamFn: Parameters<typeof compact>[7] = (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o);

		for (const candidate of MODEL_CHAIN) {
			if (event.signal.aborted) return { cancel: true };

			const key = `${candidate.provider}/${candidate.id}`;
			if (quotaExhausted.has(key)) continue;

			const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
			if (!model) continue;

			if (event.preparation.tokensBefore > model.contextWindow) continue;

			try {
				const result = await compact(
					preparation,
					model,
					undefined,
					undefined,
					event.customInstructions,
					event.signal,
					candidate.thinking,
					streamFn,
					undefined,
					retry,
				);
				if (event.signal.aborted) return { cancel: true };
				if (!hasSummaryContent(result.summary)) {
					throw new Error("Compaction produced an empty summary");
				}
				ctx.ui.notify(`Compacted with ${key}`, "info");
				return { compaction: result };
			} catch (error) {
				if (event.signal.aborted) return { cancel: true };
				const message = error instanceof Error ? error.message : String(error);
				if (/quota reached/i.test(message)) {
					quotaExhausted.add(key);
				}
				ctx.ui.notify(`Compaction with ${key} failed: ${message}`, "warning");
			}
		}

		ctx.ui.notify(
			"All cheap compaction models failed or were skipped; Pi's default compaction on the session model will be used.",
			"warning",
		);
		return undefined;
	});
}

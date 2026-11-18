/**
 * Cache guard: tracks Claude's 1-hour prompt cache in the status bar and asks
 * before sending a large context to a cold cache so you can compact first.
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface CacheState {
	warm: boolean;
	expiresAt?: number;
}

const STATUS_KEY = "cache";
// pi-claude-code uses a 1-hour prompt cache; adjust if you switch to 5-minute caching.
const CACHE_TTL_MS = 60 * 60_000;
const COMPACT_THRESHOLD = 60_000;

/** Computes whether Claude's 1-hour prompt cache is warm for `modelId` on this branch. */
export function cacheState(entries: readonly SessionEntry[], modelId: string, now = Date.now()): CacheState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction") return { warm: false };
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			provider?: string;
			model?: string;
			timestamp?: number;
		};
		if (message.role !== "assistant" || message.provider !== "claude-code") continue;
		if (message.model !== modelId || typeof message.timestamp !== "number") return { warm: false };
		const expiresAt = message.timestamp + CACHE_TTL_MS;
		return now < expiresAt ? { warm: true, expiresAt } : { warm: false };
	}
	return { warm: false };
}

function formatHHMM(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

function tokensK(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

export default function cacheGuard(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let refreshSeq = 0;
	// Lazy-load role-guard so importing `cacheState` under plain Node 22 doesn't pull in package runtime imports.
	let roleGuardPromise: Promise<{ isSubagentSession: (ctx: ExtensionContext, prompt?: string) => boolean }> | undefined;

	function loadRoleGuard() {
		return (roleGuardPromise ??= import("./role-guard.ts"));
	}

	function clearTimer() {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	async function refresh(ctx: ExtensionContext, model = ctx.model) {
		const seq = ++refreshSeq;
		clearTimer();
		if (!ctx.hasUI) return;
		const { isSubagentSession } = await loadRoleGuard();
		if (seq !== refreshSeq) return;
		clearTimer();

		if (model?.provider !== "claude-code" || isSubagentSession(ctx)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const now = Date.now();
		const state = cacheState(ctx.sessionManager.getBranch(), model.id, now);
		if (state.warm && state.expiresAt !== undefined) {
			ctx.ui.setStatus(STATUS_KEY, `cache warm until ${formatHHMM(state.expiresAt)}`);
			timer = setTimeout(() => {
				timer = undefined;
				void refresh(ctx);
			}, Math.max(0, state.expiresAt - now));
			timer.unref();
			return;
		}
		const tokens = ctx.getContextUsage()?.tokens;
		ctx.ui.setStatus(
			STATUS_KEY,
			tokens == null ? "⚠ CACHE COLD" : `⚠ CACHE COLD: next message re-writes ~${tokensK(tokens)} tokens`,
		);
	}

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("agent_settled", (_event, ctx) => refresh(ctx));
	pi.on("session_compact", (_event, ctx) => refresh(ctx));
	pi.on("model_select", (event, ctx) => refresh(ctx, event.model));
	pi.on("session_shutdown", () => {
		refreshSeq++;
		clearTimer();
	});

	pi.on("input", async (event, ctx) => {
		if (!ctx.hasUI) return { action: "continue" };
		const { isSubagentSession } = await loadRoleGuard();
		if (ctx.model?.provider !== "claude-code" || isSubagentSession(ctx, event.text)) {
			refreshSeq++;
			clearTimer();
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return { action: "continue" };
		}
		if (event.source === "extension" || event.streamingBehavior !== undefined) {
			return { action: "continue" };
		}
		const state = cacheState(ctx.sessionManager.getBranch(), ctx.model.id, Date.now());
		if (state.warm) return { action: "continue" };
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens == null || tokens <= COMPACT_THRESHOLD) return { action: "continue" };

		const choice = await ctx.ui.select(
			`⚠ CACHE COLD: ${tokensK(tokens)} context. Compact first?`,
			["Compact, then send", "Send anyway"],
		);
		if (choice === "Send anyway") return { action: "continue" };
		if (choice === "Compact, then send") {
			ctx.compact({
				onComplete: () => {
					const content = event.images?.length
						? [{ type: "text" as const, text: event.text }, ...event.images]
						: event.text;
					pi.sendUserMessage(content, { expandPromptTemplates: true });
				},
				onError: (err) => {
					ctx.ui.setStatus(STATUS_KEY, `⚠ compaction failed: ${err.message}. Resend your message.`);
				},
			});
		}
		return { action: "handled" };
	});
}

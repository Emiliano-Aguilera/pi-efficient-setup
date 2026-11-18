/**
 * Model-specific system prompt guidance.
 *
 * Reads Markdown files from ~/.pi/agent/model-prompts/ and adds the best match
 * for the active model ID as a `model_guidance` section. Matching is exact model
 * ID first, then longest case-insensitive prefix. An empty file disables the
 * section for that model. A file named `<provider>--<prefix>.md` matches only
 * that provider, so `antigravity--claude.md` overrides `claude.md` there.
 *
 * The section approach lets Pi patch only this part of the prompt instead of
 * replacing the whole system prompt.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ROLE_LINE = /^Role:[ \t]*([\w-]+)[ \t]*$/m;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : "")).join("\n");
}

function isRoleSession(ctx: ExtensionContext, prompt: string): boolean {
	let first: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role === "user") {
			first = textOf(message.content);
			break;
		}
	}
	const name = ROLE_LINE.exec(first ?? prompt)?.[1];
	return name !== undefined && existsSync(join(getAgentDir(), "roles", `${name}.md`));
}

function promptsDir(): string {
	return join(getAgentDir(), "model-prompts");
}

function promptFileFor(dir: string, provider: string, modelId: string): string | undefined {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}

	const id = modelId.toLowerCase();
	const qualified = `${provider}--${modelId}`.toLowerCase();
	let bestStem: string | undefined;
	let bestName: string | undefined;

	for (const name of names) {
		if (!name.toLowerCase().endsWith(".md")) continue;
		const stem = name.slice(0, -3);
		if (!stem || (!id.startsWith(stem.toLowerCase()) && !qualified.startsWith(stem.toLowerCase()))) continue;
		if (bestStem === undefined || stem.length > bestStem.length) {
			bestStem = stem;
			bestName = name;
		}
	}

	return bestName === undefined ? undefined : join(dir, bestName);
}

export default function modelPrompts(pi: ExtensionAPI) {
	let cachedModelId: string | undefined;
	let cachedFile: string | undefined;

	function fileFor(provider: string, modelId: string): string | undefined {
		const key = `${provider}/${modelId}`;
		if (key !== cachedModelId) {
			cachedModelId = key;
			cachedFile = promptFileFor(promptsDir(), provider, modelId);
		}
		return cachedFile;
	}

	// /dsh toggles the model guidance for this pi process (use it before the first prompt).
	let dshOff = false;
	pi.registerCommand("dsh", {
		description: "Toggle the model-specific prompt (DSH) on/off for this session",
		handler: async (_args, ctx) => {
			dshOff = !dshOff;
			if (ctx.hasUI) ctx.ui.notify(`Model prompt (DSH) ${dshOff ? "OFF: plain pi prompt" : "ON"}`, "info");
		},
	});

	pi.on("session_start", () => {
		cachedModelId = undefined;
		cachedFile = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Role: child sessions never get model guidance.
		if (isRoleSession(ctx, event.prompt ?? "")) {
			delete event.systemPromptOptions.sections.model_guidance;
			return;
		}
		// PI_MODEL_PROMPTS=off or /dsh off drops the section (A/B tests against plain pi).
		if (process.env.PI_MODEL_PROMPTS === "off" || dshOff) {
			delete event.systemPromptOptions.sections.model_guidance;
			return;
		}
		const modelId = ctx.model?.id;
		if (!modelId) return;

		const file = fileFor(ctx.model?.provider ?? "", modelId);
		if (!file) {
			delete event.systemPromptOptions.sections.model_guidance;
			return;
		}

		let text: string;
		try {
			text = readFileSync(file, "utf8").trim();
		} catch {
			delete event.systemPromptOptions.sections.model_guidance;
			return;
		}

		if (text) {
			event.systemPromptOptions.sections.model_guidance = text;
		} else {
			delete event.systemPromptOptions.sections.model_guidance;
		}
	});
}

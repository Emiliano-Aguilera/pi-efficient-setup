/**
 * Role guard: injects role system prompts and blocks dangerous actions in
 * Pi sessions started by another agent (`Role: <name>`).
 *
 * A session is a role session when its first user message has a line
 * `Role: <name>` and ~/.pi/agent/roles/<name>.md exists. The line need not be
 * first: T3 puts its own sentence before the task text. Every other session is
 * left alone.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DENY_COMMANDS = [
	/\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b/,
	/\bpip3?\s+install\b/, /\bpython3?\s+-m\s+pip\s+install\b/, /\buv\s+(add|pip\s+install|sync)\b/,
	/\bconda\s+install\b/, /\bgo\s+(get|install)\b/, /\bcargo\s+(add|install)\b/, /\bbrew\b/,
	/\bgit\s+(commit|push|reset|checkout|switch|rebase|merge|stash|clean|restore)\b/,
	/(^|[\s;&|(])(\/usr)?\/bin\/rm\b/, /\bfind\b.*\s-delete\b/, /\bsudo\b/, /\bssh\b/, /\bscp\b/,
	/\bnpm\s+publish\b/, /\bchmod\s+-R\b/,
	/(^|[\s/])\.env(?!\.example|\.sample)/,
	/(^|[\n;&|(]\s*)printenv\b/, /(^|[\n;&|(]\s*)env\s*($|[\n;&|)])/,
];

/** Blocked for every role except web-researcher, whose job is fetching pages. */
const NETWORK_COMMANDS = [/\bcurl\b/, /\bwget\b/];

/** Roles that only investigate: their edit and write tools work under /tmp only. */
const READ_ONLY_ROLES = new Set(["auditor", "bash-runner", "plan-auditor", "web-researcher"]);

/** Non-repo roles that do not need project AGENTS.md / CLAUDE.md files. */
const NO_PROJECT_CONTEXT_ROLES = new Set(["web-researcher"]);

const LOCKFILES = new Set([
	"package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
	"Cargo.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock", "go.sum",
]);

const BLOCKED = "Blocked by the role guard. If the task needs this, stop and report BLOCKED.";

function isEnvFile(name: string): boolean {
	const base = name.split("/").pop() ?? "";
	return base.startsWith(".env") && base !== ".env.example" && base !== ".env.sample";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : "")).join("\n");
}

function rolePromptPath(role: string): string {
	return join(getAgentDir(), "roles", `${role}.md`);
}

function firstUserMessage(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role === "user") return textOf(message.content);
	}
	return undefined;
}

/** The role named by the session's first user message (or prompt on turn 1); undefined for normal user chats. */
export function sessionRole(ctx: ExtensionContext, prompt = ""): string | undefined {
	const name = /^Role:[ \t]*([\w-]+)[ \t]*$/m.exec(firstUserMessage(ctx) ?? prompt)?.[1];
	return name && existsSync(rolePromptPath(name)) ? name : undefined;
}

/** Whether the session was started for a subagent (by Role header or sub-agent preamble). */
export function isSubagentSession(ctx: ExtensionContext, prompt = ""): boolean {
	const text = firstUserMessage(ctx) ?? prompt;
	return /^Role:[ \t]*[\w-]+[ \t]*$/m.test(text) || /^Act as the .+ sub-agent for this task\./m.test(text);
}

function namedPaths(tool: string, input: Record<string, unknown>): string[] {
	const keys = tool === "find" ? ["pattern"] : tool === "grep" ? ["path", "glob"] : ["path"];
	return keys.map((k) => input[k]).filter((v): v is string => typeof v === "string");
}

function denyReason(tool: string, input: Record<string, unknown>, role: string): string | undefined {
	if (tool === "bash") {
		const command = String(input.command ?? "");
		const denied = role === "web-researcher" ? DENY_COMMANDS : [...DENY_COMMANDS, ...NETWORK_COMMANDS];
		const hit = denied.find((re) => re.test(command));
		return hit && `${BLOCKED} The command matches \`${hit.source}\`.`;
	}
	if (namedPaths(tool, input).some(isEnvFile)) return `${BLOCKED} .env files are off limits.`;
	if (tool === "edit" || tool === "write") {
		const path = String(input.path ?? "");
		const base = path.split("/").pop() ?? "";
		if (READ_ONLY_ROLES.has(role) && !path.startsWith("/tmp/")) {
			return `${BLOCKED} The ${role} role does not change project files; write under /tmp instead.`;
		}
		if (path.split("/").includes(".git") || LOCKFILES.has(base)) {
			return `${BLOCKED} No edits to git internals or lockfiles.`;
		}
	}
	return undefined;
}

export default function roleGuard(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		try {
			const prompt = event.messageType === "user" ? event.prompt : "";
			const role = sessionRole(ctx, prompt);
			if (role === undefined) return;
			const rolePrompt = readFileSync(rolePromptPath(role), "utf8").trim();
			if (!rolePrompt) return;

			const options = event.systemPromptOptions;
			options.customPrompt = rolePrompt;
			if (NO_PROJECT_CONTEXT_ROLES.has(role)) {
				options.contextFiles = [];
			} else {
				const agentAgentsMd = resolve(join(getAgentDir(), "AGENTS.md"));
				options.contextFiles = options.contextFiles.filter((f) => resolve(f.path) !== agentAgentsMd);
			}
			options.skills = [];
			options.appendSystemPrompt = "";
			delete options.sections.model_guidance;
			delete options.sections.delegate_task;
		} catch {
			// A bug here must never break Pi sessions.
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const role = sessionRole(ctx);
		if (role === undefined) return;
		const reason = denyReason(event.toolName, event.input as Record<string, unknown>, role);
		if (reason) return { block: true, reason };
	});
}

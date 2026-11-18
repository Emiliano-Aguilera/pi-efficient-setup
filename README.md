# pi-efficient-setup

A self-contained configuration kit for **T3 Code + Pi + Claude + Antigravity (`agy`)** built around two goals:

1. **Save Claude subscription quota** — keep expensive Opus/Sonnet tokens for planning and orchestration, summarize context on Haiku, track Claude's 1-hour prompt cache across idle pauses, and keep raw logs/search results out of Claude's context window.
2. **Delegate reliably across models** — route code exploration, web research, implementation, plan verification, and diff auditing to a cheaper worker (`antigravity/gemini-4-hydrogen` via `agy` by default) using explicit `Role:` presets.

---

## How it works

```text
User ──▶ T3 Code ──▶ Pi (claude-code / Opus or Sonnet)   [Coordinator]
                      │
                      ├─ Extensions inside Pi:
                      │   ├─ model-prompts.ts      (gives Claude delegation rules; /dsh toggles off)
                      │   ├─ delegate-async.ts     (forces mode:"async" to avoid 5m HTTP timeouts)
                      │   ├─ cache-guard.ts        (1h cache banner + prompt before >60k cold re-write)
                      │   ├─ cheap-compaction.ts   (compacts via Haiku 5.5, never Opus/Sonnet)
                      │   ├─ claude-tool-guard.ts  (repairs orphaned tool_use blocks in memory)
                      │   ├─ compaction-pointer.ts (points to transcript-text + bash-runner)
                      │   └─ role-guard.ts         (enforces Role: prompts & sandboxes Pi children)
                      │
                      └──▶ delegate_task (mode: "async")
                             │
                             ▼
                     T3 Code ──▶ Antigravity (`agy` CLI / Gemini 4 Hydrogen)  [Worker]
                                  ├─ reads ~/.gemini/GEMINI.md  (symlink → ~/.pi/agent/AGENTS.md)
                                  └─ loads ~/.gemini/config/skills/<role>/SKILL.md
```

**Why run Claude through Pi instead of T3's `claudeAgent` driver?**
All seven usage-saving and delegation extensions above run inside **Pi** (`pi-claude-code` talks to your Claude subscription through the official `claude` CLI while letting Pi own history, compaction, prompt sections, and tool guards). If you use `claudeAgent` directly in T3, none of these extensions run.

---

## Prerequisites

1. **[T3 Code](https://t3.codes)** (desktop or server).
2. **[Pi](https://github.com/earendil-works/pi)** (`pi`) + **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** (`npm install -g @anthropic-ai/claude-code`), logged in via `claude auth login`.
   * Pi uses [`pi-claude-code`](https://github.com/earendil-works/pi-claude-code), which routes Pi requests through `claude -p` using your Claude Pro/Max login.
3. **[Antigravity CLI (`agy`)](https://antigravity.google)** installed and logged in (`agy acp --login`), if using the default Antigravity worker setup.
4. `python3` (for `bin/transcript-text`; uses stdlib only) and optionally `jq` (for JSON validation in `verify.sh`).

---

## Where everything goes (and why)

| Repo path | Installed path | Purpose |
| :--- | :--- | :--- |
| `pi/extensions/*.ts` | `~/.pi/agent/extensions/*.ts` | Pi extensions (cache guard, cheap compaction, role guard, async delegation, etc.). |
| `pi/model-prompts/*.md` | `~/.pi/agent/model-prompts/*.md` | `claude.md` (delegation instructions for Claude) and `claude-haiku.md` (empty override so Haiku doesn't orchestrate). |
| `pi/roles/*.md` | `~/.gemini/config/skills/<name>/SKILL.md`<br>symlinked from `~/.pi/agent/roles/<name>.md` | Role definitions (`cheap-worker`, `bash-runner`, `auditor`, `plan-auditor`, `web-researcher`). |
| `pi/AGENTS.md` | `~/.pi/agent/AGENTS.md`<br>symlinked from `~/.gemini/GEMINI.md` | Global agent rules + `## Roles` instruction telling `agy` how to load `SKILL.md` for `Role:` tasks. |
| `pi/settings.template.json` | `~/.pi/agent/settings.json` | Default provider (`claude-code`), `cacheWarming: "off"`, and `pi-claude-code` package. |
| `bin/transcript-text` | `~/.local/bin/transcript-text` | Extracts readable lines from Pi/Claude `.jsonl` session logs for post-compaction search. |

### Why roles live in `~/.gemini/config/skills/` and symlink back to `~/.pi/agent/roles/`

* T3 runs `agy` with an isolated `$GEMINI_HOME` and symlinks its `config/skills` folder to `~/.gemini/config/skills`.
* `agy` refuses to read skill symlinks that point *outside* its `skills/` directory, so each `<name>/SKILL.md` must be a **real file** inside `~/.gemini/config/skills/`.
* Meanwhile, Pi's `role-guard.ts` and `model-prompts.ts` look for `~/.pi/agent/roles/<name>.md`. Symlinking `~/.pi/agent/roles/<name>.md` → `~/.gemini/config/skills/<name>/SKILL.md` keeps one single source of truth for both `agy` children and Pi children.

If you do **not** use `agy` (see [Adapting to other setups](#adapting-to-other-setups)), pass `--no-agy` to `install.sh` and `verify.sh`; roles will be copied directly into `~/.pi/agent/roles/` with no `~/.gemini/` files created.

---

## Quick start

```bash
git clone https://github.com/Emiliano-Aguilera/pi-efficient-setup.git
cd pi-efficient-setup

# Preview without changing files
./install.sh --dry-run

# Install for Claude (via Pi) + Antigravity (agy)
./install.sh

# Verify links, JSON, extensions, and roles
./verify.sh
```

Installer flags:
* `--no-agy`: Skip `~/.gemini/` wiring; install roles directly as files in `~/.pi/agent/roles/`.
* `--force`: Back up and replace an existing `~/.pi/agent/AGENTS.md` or non-symlink `~/.gemini/GEMINI.md`. (`~/.pi/agent/settings.json` is never overwritten if it already exists.)
* `--dry-run`: Show actions without writing files.

Make sure `~/.local/bin` is on your `PATH` so `transcript-text` is callable from agent shells.

---

## Configuring T3 Code

T3's own `settings.json` holds machine-specific IDs and preferences, so it is intentionally left out of this repo. Apply these four settings in T3's UI or `~/.t3/userdata/settings.json`:

1. **Use the `pi` provider for your Claude coordinator threads** (not `claudeAgent`).
2. **Set Pi launch args to `--approve`** (`providerInstances.pi.config.launchArgs = "--approve"`) so T3 doesn't stall waiting on Pi tool-approval prompts.
3. **Turn T3 idle compaction off** (`"idleCompaction": "off"`) so Pi's `cheap-compaction.ts` + `cache-guard.ts` control when and how compaction runs.
4. **Point Antigravity to the `agy` CLI** (`providerInstances.antigravity.config.binaryPath = "agy"` or `~/.local/bin/agy`) instead of T3's bundled Antigravity server:
   * **Important:** T3's bundled server ignores `~/.gemini/GEMINI.md` and project `AGENTS.md`, which breaks `Role:` loading. Using the standalone `agy` CLI loads both `~/.gemini/GEMINI.md` and `~/.gemini/config/skills/`.

---

## What each piece does

### Pi extensions (`pi/extensions/`)

* **`role-guard.ts`** — When a Pi session's first user message contains `Role: <name>` (matching `~/.pi/agent/roles/<name>.md`), replaces the system prompt with that role's `.md`, strips coordinator prompt sections (`model_guidance`, `delegate_task`, personal `AGENTS.md`), restricts `edit`/`write` in read-only roles (`auditor`, `bash-runner`, `plan-auditor`, `web-researcher`) to `/tmp/`, and blocks destructive/mutating bash commands (`git commit/push/reset/...`, package installs, `.env`, `printenv`, `/bin/rm`, `find -delete`, and `curl`/`wget` outside `web-researcher`).
* **`delegate-async.ts`** — Instructs the coordinator to use `mode: "async"` on `delegate_task` and rewrites any `mode: "wait"` calls to `"async"`. Prevents Pi's 5-minute HTTP idle timeout from failing long child runs and triggering duplicate retries.
* **`model-prompts.ts`** — Injects `model-prompts/<prefix>.md` (or `<provider>--<prefix>.md`) into `systemPromptOptions.sections.model_guidance` on coordinator sessions (skipped on `Role:` children). Use `/dsh` in a session or `PI_MODEL_PROMPTS=off` to temporarily toggle it off.
* **`cache-guard.ts`** — Tracks `claude-code`'s 1-hour prompt cache in T3's composer status bar (`cache warm until HH:MM` or `⚠ CACHE COLD: next message re-writes ~Nk tokens`). If the cache is cold and context exceeds `60_000` tokens, prompts **`Compact, then send`** vs **`Send anyway`**.
  * *Why this matters with T3:* T3 stops idle Pi processes after 30 minutes and clears composer banners, while Claude's prompt cache lives 60 minutes. `cache-guard.ts` reads the session branch on disk, so it still knows the cache state after T3 restarts Pi.
* **`cheap-compaction.ts`** — Hooks `session_before_compact` to summarize with `claude-code/claude-haiku-5-5` (`medium`) by default instead of Opus/Sonnet.
* **`claude-tool-guard.ts`** — Hooks `context_with_system` for `claude-code` to drop errored/aborted assistant turns and synthesize error `toolResult`s in memory for orphaned `toolCall`s. Prevents Anthropic HTTP 400 (`tool_use ids were found without tool_result blocks`) from permanently wedging a thread while preserving prompt-cache reuse.
* **`compaction-pointer.ts` + `bin/transcript-text`** — After compaction, adds a system section pointing the agent to the session `.jsonl` file and telling it to query pre-compaction details via `Role: bash-runner` + `transcript-text <file> | grep -n -i -C2 '<term>'` instead of reading raw JSONL into Claude's context.

### Roles (`pi/roles/`)

* **`cheap-worker`** — Implements a scoped plan with exact file paths and a `done-when: <cmd>` verification command. Does not redesign, weaken tests, commit, or install packages.
* **`bash-runner`** — Runs commands and read-only repo investigations, logging full output under `/tmp/bash-runner/` and returning only the distilled evidence and `file:line` matches.
* **`auditor`** — Checks a finished `cheap-worker` diff given only the working directory and the original brief (never the worker's report). Re-runs `done-when:` and reports evidence-backed bugs only.
* **`plan-auditor`** — Verifies a proposed plan against actual files, symbols, and commands before coding starts.
* **`web-researcher`** — Searches public docs, Reddit (via Arctic Shift), and Hacker News (`google_search` / `read_url_content`, or `web_enable` if `pi-web-access` is installed in Pi), saving raw fetches under `/tmp/web-researcher/`.

> **Trust boundary note:** `role-guard.ts` hard-enforces command/file restrictions on **Pi** subagents (`haiku`, `mistral`, etc.). When a child runs on **Antigravity (`agy`)**, Pi is not in the loop—`agy` follows `GEMINI.md` + `SKILL.md` by instruction, gated by T3's runtime mode (`approval-required` vs `full-access`).

---

## Adapting to other setups

### 1. Switching the cheap worker model/provider

Open `~/.pi/agent/model-prompts/claude.md` (or `pi/model-prompts/claude.md` before running `./install.sh`) and edit the 3-line target block at the top:

* **Default (Antigravity / Gemini 4 Hydrogen):**
  ```text
  - `providerInstanceId`: `"antigravity"`
  - `model`: `"gemini-4-hydrogen"`
  - options: `thought_level: "high"`
  ```
* **Claude Haiku via Pi (only one subscription needed):**
  ```text
  - `providerInstanceId`: `"pi"`
  - `model`: `"claude-code/claude-haiku-5-5"`
  - options: `thinking: "high"`
  ```
  *(Uses Claude quota, though much less than Opus/Sonnet; gets hard `role-guard.ts` enforcement.)*
* **Mistral subscription (e.g. DeepSeek in Pi):**
  Install [`pi-mistral-subscription`](https://github.com/5omeOtherGuy/pi-mistral-subscription), log in via `/login`, and set:
  ```text
  - `providerInstanceId`: `"pi"`
  - `model`: `"mistral/deepseek-v4-1-flash-1017"`
  - options: `thinking: "high"`
  ```
* **Codex or any other T3 provider:**
  Ask T3 (`orchestrator_capabilities`) which `providerInstanceId`, `model`, and option names (`effort`, `thinking`, `thought_level`) are available, update `claude.md`, and run `./install.sh --no-agy` if you aren't using `agy`. Make sure the target provider can read project/user rules or read `~/.pi/agent/roles/<name>.md`.

### 2. Changing compaction models (`cheap-compaction.ts`)

Pi cannot invoke T3's `antigravity` (`agy`) server directly, so `MODEL_CHAIN` in `~/.pi/agent/extensions/cheap-compaction.ts` must list **Pi-registered** providers (`pi --list-models` or `/model`).

By default it uses `claude-code/claude-haiku-5-5` (`medium`). If you also configure Mistral, OpenRouter, or a direct API key in Pi, add that model *above* Haiku in `MODEL_CHAIN` (note that transcript text goes to whichever provider performs compaction).

### 3. Tuning cache, compaction, and delegation thresholds

* **Cold-cache prompt threshold:** Edit `COMPACT_THRESHOLD` (default `60_000`) or `CACHE_TTL_MS` (default `60 * 60_000`) at the top of `pi/extensions/cache-guard.ts`.
* **Direct Anthropic API (`anthropic` provider instead of `pi-claude-code`):** Direct API uses 5-minute prompt caching by default and `pi-ai`'s built-in tool cleanup. Update the provider check and `CACHE_TTL_MS` in `cache-guard.ts` (and you can remove `claude-tool-guard.ts`).
* **Auto-compaction threshold (`reserveTokens`):** `settings.template.json` intentionally omits `reserveTokens` so Pi uses its safe default. Only set a large `reserveTokens` (e.g. `700000` to compact around ~300k) if you know your model has a 1M context window (`pi-claude-code` gives 200k on models without `1M context` in their description—a 700k reserve on a 200k model makes the threshold negative).
* **Delegation strictness:** Edit `pi/model-prompts/claude.md` to drop the confirmation gate before coding, change the `>5 tool calls` threshold, or relax `auditor` triggers.
* **Personal rules (`AGENTS.md`):** Edit everything above `## Roles` freely; keep `AGENTS.md` concise since `agy` loads `~/.gemini/GEMINI.md` on every turn.
* **Optional web fallback in Pi:** To give Pi sessions `web_enable` / `web_search` / `fetch_content`, add `"npm:pi-web-access@0.46.0"` to `packages` in `~/.pi/agent/settings.json` and create `~/.pi/agent/web-search.json` with `{"toolActivation": "auto"}`.

---

## Troubleshooting

* **`agy` ignores `Role:` tasks:** Check that T3's Antigravity `binaryPath` points to the `agy` CLI (not T3's bundled server), `~/.gemini/GEMINI.md` points to `~/.pi/agent/AGENTS.md`, and `~/.gemini/config/skills/<name>/SKILL.md` are **real files** (run `./verify.sh`).
* **`cache-guard.ts` dialog dismissed without picking an option:** If you close the `Compact, then send` / `Send anyway` card instead of choosing, T3 may leave the turn spinning until you click Stop (a T3+Pi RPC quirk).
* **Headless Linux / locked keyring (`agy` says `No browser is available` on boot):** If GNOME's login keyring stays locked after reboot, `agy` falls back to `~/.t3/userdata/providers/antigravity/<hash>/antigravity-oauth-token`. Unlocking the desktop session or copying your keyring's `service=gemini, username=antigravity` JSON entry to that file (mode `600`) resolves it.
* **`html_render` pages missing from `agy` in T3 0.1.9:** `agy` 1.5 prefixes MCP tool titles with `Run mcp_...`, which T3 0.1.9 doesn't recognize when rendering inline HTML pages. The five engineering/research roles here don't use `html_render`, so this only affects custom visualization tools.

# Claude only: delegation

Claude plan limits are scarce; offload exploration, execution, and reviews to a cheaper worker via `delegate_task`.

Default child target (edit this block to switch workers):
- `providerInstanceId`: `"antigravity"`
- `model`: `"gemini-4-hydrogen"`
- options: `thought_level: "high"`

## When to delegate
- **Read-only exploration & long command runs:** Start immediately without asking. Beyond ~5 tool calls, send to `Role: bash-runner` (repo search, tests, logs) or `Role: web-researcher` (web docs, community threads).
- **Code changes:** Edit directly only for small fixes (a few lines) or when asked. For anything larger, state the stages (which go to children and whether `plan-auditor` or `auditor` runs) and wait for confirmation before coding, then delegate to `Role: cheap-worker`.
- **Plan review (complex tasks):** Send the working directory and plan text to `Role: plan-auditor` before coding.

## How to brief and verify
- Start the `task` text with `Role: <name>` (`cheap-worker`, `bash-runner`, `web-researcher`, `plan-auditor`, or `auditor`).
- Children see none of this conversation: name exact file paths, the change or question, and for `cheap-worker` include ``done-when: `<shell command>` `` that succeeds when the work is right.
- Always run the `done-when:` command yourself after `cheap-worker` finishes.
- Run `Role: auditor` (with only the working directory and the original brief word-for-word, never the worker's report) when agreed, or when the diff is large (~150+ lines or 5+ files), `done-when:` doesn't test the new behavior, or mistakes are costly (auth, billing, deletions, migrations). Send real findings to a new `cheap-worker` child.
- If a child fails or returns incomplete, tighten the brief with the failure output and retry once with a new child; if the retry still fails, do the task yourself.

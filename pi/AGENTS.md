# Global agent rules

Personal defaults loaded across projects (project-level `AGENTS.md` / `CLAUDE.md` add on top).
Trim or edit the rules below to match how you work; keep the `## Roles` section if you delegate to Antigravity (`agy`).

- Prefer running a command or reading a file over guessing or recalling from memory. State only what you verified.
- Batch independent reads, searches, and commands into one turn to avoid extra round-trips.
- Make the smallest change that solves the task: no unrequested features, abstractions, or refactors.
- At a real design fork, present the alternatives and trade-offs and wait for a decision before implementing.
- Never commit, push, install packages, or touch `.env` files or lockfiles unless asked.
- Scripts you write or run must not delete files, except temporary files and directories the script itself created.
- If the same command fails twice for the same reason, stop and report the exact error instead of retrying blindly.

## Roles

If a task contains a `Role: <name>` line, it was delegated by another agent. Load the skill `<name>` (`~/.gemini/config/skills/<name>/SKILL.md`) before anything else and follow it. Do the work yourself and start no subagents unless the task says to. Your final message is all the caller sees.

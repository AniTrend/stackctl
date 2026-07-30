---
name: stackctl-cli
description: Use this skill when a task involves the stackctl CLI, including managing Docker Swarm stacks, choosing source-valid commands, running operational workflows, answering usage questions, or avoiding stale documented examples.
---

# stackctl CLI

Use this skill when a task involves the `stackctl` command line interface, its install context,
command behavior, flags, examples, or agent-facing guidance.

## Ground rules

- Treat `src/cli/mod.ts` as authoritative for commands, arguments, flags, and behavior.
- If a command, flag, install mode, workflow, or Homebrew behavior is not verified in source or
  accepted research, say it is unknown or check the source.
- Do not invent aliases, planned commands, positional arguments, deployment workflows, or Homebrew
  post-install behavior.
- This is a Deno 2.x project published as `@anitrend/stackctl`. Do not treat it as a Node or npm
  project.

## Hard CLI facts

- `sync` is drift validation only. Do not describe it as deploy.
- Do not show bare `stackctl plan`. Use an operation such as `stackctl plan all` or
  `stackctl plan up`.
- `up` and `down` select stacks with `--stacks`, not positional stack names.
- `secrets deploy` accepts positional stack names.
- `logs` accepts positional service names and also supports `--stacks`.
- `doctor --fix-volumes` currently reports a stub check, not an implemented repair.
- Homebrew post-install messaging is not implemented in this repository.

## Quick command map

- Setup and generation: `init`, `generate`, `render`, `plan <operation>`.
- Stack lifecycle: `up`, `down`, `reload`, `status`, `logs`, `sync`, `doctor`.
- Secrets: `secrets encrypt`, `decrypt`, `deploy`, `clean`, `check`.
- Env files: `env list`, `create`, `diff`, `materialize`, `audit`.
- Shell integration: `completions`.

## Operational model

stackctl manages Docker Swarm stacks through a four-stage pipeline: discover Compose files, generate
canonical stack YAML, render `${VAR}` placeholders, and deploy via `docker stack deploy`. Different
commands run different stages:

- `up` runs all four stages in memory and deploys from a temp file.
- `reload` runs all four stages, writes to disk, and deploys without teardown.
- `generate` and `render` run early stages without deploying.
- `sync` validates drift by comparing in-memory generation to committed files.
- `plan <operation>` previews any operation without executing.

## Task playbooks

For task-oriented workflows (deploy, update, drift check, teardown, secrets, env scaffolding,
diagnostics, previewing), read `references/playbooks.md`. It provides command chains, prerequisites,
output interpretation, exit code guidance, and a decision tree mapping agent intents to commands.

## References

- `references/commands.md`: Full command, subcommand, option, argument, and caveat reference tables.
- `references/playbooks.md`: Task-oriented operational workflows, decision tree, and exit code
  interpretation.
- `references/truth-model.md`: Source hierarchy, runtime facts, config resolution, exit codes, and
  anti-hallucination controls.

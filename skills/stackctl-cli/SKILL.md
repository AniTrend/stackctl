---
name: stackctl-cli
description: Use this skill when helping agents answer stackctl CLI usage questions, choose source-valid stackctl commands, or avoid stale documented examples.
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

For full command facts, read `references/commands.md`. For source hierarchy, runtime facts, and
known stale docs, read `references/truth-model.md`.

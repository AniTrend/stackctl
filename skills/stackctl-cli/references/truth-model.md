# stackctl truth model

Use this file to avoid hallucinating command facts or install behavior.

## Source hierarchy

1. `src/cli/mod.ts` is authoritative for CLI commands, subcommands, flags, arguments, and command
   behavior.
2. `src/config/types.ts`, `src/config/load.ts`, and `src/config/defaults.ts` are authoritative for
   config shape, profile handling, defaults, and exit-code meaning.
3. `deno.json`, `src/main.ts`, and `src/version.ts` are authoritative for package metadata, runtime,
   tasks, entrypoint, version, and Deno permissions.
4. `README.md` is public guidance. It can be stale and does not override source files.
5. `docs/migration.md` is draft migration documentation. Treat examples there as potentially stale
   unless confirmed in source.
6. Homebrew formula behavior must be checked in `AniTrend/homebrew-tap`. This repository does not
   implement Homebrew post-install messaging.

If a command, flag, argument, install mode, workflow, or Homebrew behavior is not verified in the
source hierarchy or accepted research, say it is unknown or check the source.

## Runtime facts

| Fact                | Verified value                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Runtime             | Deno 2.x                                                                                                |
| Package             | `@anitrend/stackctl`                                                                                    |
| Entrypoint          | `src/main.ts`                                                                                           |
| Source of CLI truth | `src/cli/mod.ts`                                                                                        |
| Node project files  | Not part of this project. Do not add `package.json`, `node_modules`, npm config, or Node project files. |
| Dependency source   | JSR imports in `deno.json`                                                                              |

The `npx skills add` commands install only the AI agent skill. They do not install stackctl, do not
add runtime dependencies to stackctl, and do not make this repository a Node or npm project.

## Config and profiles

Config resolution order, where later layers win:

1. Built-in defaults.
2. `.stackctl`.
3. `.stackctl.<profile>`.
4. `.stackctl.local`.
5. `.stackctl.local.<profile>`.
6. Explicit `--override` files where a command supports them, applied after config layers but before
   rendering.

Profile selection precedence is `--profile` over `STACKCTL_PROFILE`.

## Exit codes

| Code | Meaning                       |
| ---- | ----------------------------- |
| 0    | Success.                      |
| 1    | Drift or validation failure.  |
| 2    | User config error.            |
| 3    | Missing dependency.           |
| 4    | Unexpected or internal error. |

## Hard anti-hallucination controls

- `sync` is drift validation only. It is not deploy.
- Bare `stackctl plan` is invalid because `plan` requires an operation argument.
- `up` and `down` use `--stacks` for stack selection.
- `secrets deploy` accepts positional stack names.
- `logs` accepts positional service names and supports `--stacks`.
- `doctor --fix-volumes` is a stub that reports external volumes as not yet implemented.
- Homebrew post-install messaging is not implemented in this repository.
- `init` has no verified `--project` flag.

## Known stale or sensitive areas

- README command examples must be checked against `src/cli/mod.ts` before reuse.
- Migration documentation can contain draft or stale syntax.
- Install permission examples can differ between docs and `src/main.ts`. Prefer current source for
  executable behavior.
- Homebrew availability and formula output are outside this repository. Check the tap before making
  claims.

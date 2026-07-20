# AGENTS.md — stackctl

## Runtime

This is a **Deno 2.x** project. There is no Node.js, no npm, no `package.json`. All dependencies come from JSR. Do not use `npm install`, `node`, or Node-ecosystem tools. Do not add `node_modules` or a `package.json`.

Entrypoint: `src/main.ts`
Package name on JSR: `@anitrend/stackctl`

## Dev commands

| Task | Command |
|------|---------|
| Cache deps | `deno task cache` |
| Type-check | `deno task check` |
| Format | `deno task fmt` |
| Check format (CI) | `deno task fmt:check` |
| Lint | `deno task lint` |
| Run all tests | `deno task test` |
| Coverage report | `deno task coverage` (run after test with `--coverage=.coverage`) |
| Build binary | `deno task build` |
| Cross-compile | `deno task build:linux:x64`, `:linux:arm64`, `:darwin:x64`, `:darwin:arm64` |

**CI-mandated order**: `deno task cache` -> `fmt:check` -> `lint` -> `check` (type-check) -> `test` -> `coverage`

Tests require permissions. The `test` task bakes them in, but if calling `deno test` directly you need:
```
deno test --allow-read --allow-write --allow-env --allow-run --allow-sys
```

## Formatting and linting (do not guess)

- **Line width**: 100 chars
- **Indent**: 2 spaces, no tabs
- **Quotes**: double quotes, not single
- **Prose wrap**: always
- **Lint rules**: `recommended` tag, with `no-unused-vars` **excluded**
- **Compiler**: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`

These are enforced by CI. Match the repo style; the formatter is the authority.

## Source layout

```
src/
  cli/mod.ts         — All CLI commands (one large file, ~1600 lines). Uses @cliffy/command.
  config/            — Config loading, merging, validation, init. Exports from mod.ts.
  compose/           — Docker Compose discovery, generation, merging, transform, reload, sync, plan.
  render/            — ${VAR} interpolation in compose YAML.
  docker/            — Docker / Swarm CLI wrappers (stack deploy, rm, ps, services, swarm status, etc.).
  secrets/           — SOPS + age integration for encrypting .env files.
  env/               — .env file scaffolding (list, create, diff, materialize from profile presets, audit).
  process/           — ProcessRunner interface + RealProcessRunner. All external tool calls go through this.
  testing/           — FakeProcessRunner for unit tests, plus helper factories.
  main.ts            — Bootstraps CLI.
  version.ts         — VERSION constant. Updated by CI on release.
```

## Config resolution order (later wins)

1. Built-in defaults (`src/config/defaults.ts`)
2. `.stackctl` (base)
3. `.stackctl.<profile>` (profile overlay)
4. `.stackctl.local` (local overrides, gitignored)
5. `.stackctl.local.<profile>` (local profile overlay)

Explicit `--override` files are applied after all config layers but before rendering.
Config merges use: scalars replaced, maps deep-merged, sequences appended.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Drift or validation failure |
| 2 | User config error |
| 3 | Missing dependency (Docker, sops, age) |
| 4 | Unexpected / internal error |

## Testing conventions

- Test files are co-located: `foo_test.ts` next to `foo.ts`.
- Use `FakeProcessRunner` from `src/testing/fakes.ts` instead of calling real tools. Pre-program responses with `FakeProcessRunnerBuilder`. The fake throws on unknown commands — every test must configure all commands its code path will invoke.
- Use `@std/assert` and `@std/testing` (from JSR) for assertions.
- Coverage threshold: **minimum 80% line coverage** for `src/`. Check with `deno task coverage`.
- The CI workflow (`ci.yml`) runs on pushes/PRs to `main` and `dev` branches.

## Build and release

- Binary compiled via `deno compile` with permissions baked in: `--allow-read --allow-write --allow-env --allow-sys --allow-run=git,docker,sops,age,age-keygen,shred,rm`
- Release workflow triggers on `v*` tags. Cross-compiles for 4 targets (linux/macOS, x64/arm64), packages tarballs, generates SHA256 checksums.
- **Version bump**: after a release, `version-bump.yml` updates both `deno.json` (`"version"` field) and `src/version.ts` (`VERSION` constant). If changing version manually, update both.
- `release-drafter-config.yml` auto-labels PRs by branch prefix.

## Branch, commit, and PR conventions

See `CONTRIBUTING.md` for full details. Quick reference:

- **Branch**: `<type>/<issue-number>-<short-description>` (e.g., `feat/1208-implement-override-merging`)
- **Commit**: `<type>(<scope>): <summary>` (e.g., `feat(config): add profile overlay discovery`)
- **PR title**: same format as commits, linked to the relevant issue
- **Valid types**: `feat`, `fix`, `dependencies`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `revert`
- **Valid scopes**: `config`, `generate`, `render`, `cli`, `docker`, `secrets`, `project`, `env`, `compose`, `process`

### Branch prefix selection for agents

When creating a branch automatically, select the prefix based on the change intent.
The release drafter autolabeler maps each branch prefix to a changelog label:

| What you are doing | Branch prefix | Auto-label applied |
|---|---|---|
| Adding a new feature or capability | `feat` | `:star2: feature` |
| Fixing a bug | `fix` | `:adhesive_bandage: bug fix` |
| Updating dependencies (Renovate, manual) | `dependencies` | `:dagger: dependencies` |
| Changing build system or tooling | `build` | `:dagger: dependencies` |
| Routine maintenance, chores | `chore` | `:wrench: enhancement` |
| Documentation only | `docs` | `:books: docs` |
| Refactoring without behavior change | `refactor` | `:hammer_and_wrench: refactor` |
| Adding or fixing tests | `test` | `:test_tube: testing` |
| CI/CD configuration | `ci` | `:construction_worker: ci` |
| Reverting a previous change | `revert` | `:rewind: revert` |

If no issue number exists, use `<type>/<short-description>` and link to an issue once created.

## Documentation requirements

- `AGENTS.md` (this file) and `docs/` must be kept up to date with code changes. If you add, remove, or change behavior, update them in the same PR.
- `docs/migration.md` documents the migration path from the legacy `stackctl.sh` script to the standalone `stackctl` binary. Keep it in sync with CLI changes that affect documented commands or config fields.

## General constraints

- This project is in **early development**. All commands are listed as "Planned" in `README.md`; check actual implementation status in `src/cli/mod.ts` before assuming a command exists.
- Permissions for the compiled binary are defined in `src/main.ts` shebang and the CI build step. Do not change permissions without updating both.
- Git-ignored files: `.stackctl.local`, `.stackctl.local.*`, `*.env` (except `.env.example`), `*.env.enc`, `age-key.txt`, `age.key`, `dist/`, `.rendered/`, `.coverage/`, `cov/`.

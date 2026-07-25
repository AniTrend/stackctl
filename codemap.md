# Repository Atlas: stackctl

## Project Responsibility

`stackctl` is a Deno 2.x command line application for managing Docker Compose based stacks across
multi-service repositories. It resolves layered `.stackctl` configuration, discovers service compose
files, generates canonical Docker Swarm stack YAML, renders environment substitutions, manages SOPS
and age encrypted dotenv files, and delegates Docker operations through a typed process execution
boundary.

The package is published as `@anitrend/stackctl` and exports `src/main.ts` as the executable entry
point.

## System Entry Points

- `src/main.ts`: Deno executable bootstrap. It passes `Deno.args` to the CLI module and exits with
  the returned status code.
- `src/cli/mod.ts`: Cliffy command tree, option parsing, command orchestration, output formatting,
  and exit-code mapping.
- `deno.json`: Package metadata, JSR export path, task definitions, formatter settings, lint rules,
  compiler options, and JSR dependency map.
- `renovate.json`: Renovate dependency automation configuration, using `dependencies/` branches and
  `main` as the base branch.
- `AGENTS.md`: Agent-facing repository instructions, runtime constraints, branch and commit
  conventions, and the required codemap entry point.

## Root Asset Map

| Path                 | Responsibility                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `deno.json`          | Defines Deno tasks, JSR imports, lint, format, strict compiler options, package name, version, and export target.      |
| `deno.lock`          | Locks JSR and standard library dependency versions for deterministic Deno resolution.                                  |
| `README.md`          | User-facing overview, install path, command status table, feature list, and development commands.                      |
| `CONTRIBUTING.md`    | Contribution workflow, branch naming, commit format, and PR expectations.                                              |
| `AGENTS.md`          | Agent operating guide, source layout, runtime rules, and codemap discovery instructions.                               |
| `renovate.json`      | Automated dependency update policy and branch prefix configuration.                                                    |
| `.github/`           | CI, release, version bump, stale issue handling, release drafter, auto approval, and composite setup action workflows. |
| `.slim/codemap.json` | Codemap state file containing selected source hashes and folder hashes for change detection.                           |

## Repository Directory Map

| Directory      | Responsibility Summary                                                                                                                     | Detailed Map                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `src/`         | Deno executable entry point and version module. It bootstraps the CLI and centralizes the release version constant.                        | [View Map](src/codemap.md)         |
| `src/cli/`     | Command registration, option parsing, runner injection, domain delegation, output formatting, and semantic exit-code adaptation.           | [View Map](src/cli/codemap.md)     |
| `src/config/`  | Configuration shape, defaults, discovery, YAML loading, layered merging, validation, initialization, and public config exports.            | [View Map](src/config/codemap.md)  |
| `src/compose/` | Compose discovery, loading, generation, merging, overrides, Swarm transforms, named volumes, reload, sync, and operation planning.         | [View Map](src/compose/codemap.md) |
| `src/render/`  | Docker Compose interpolation, service environment scope construction, recursive substitution, path absolutization, and warning collection. | [View Map](src/render/codemap.md)  |
| `src/docker/`  | Typed Docker, Docker Compose, and Docker Swarm command wrappers built around the injected `ProcessRunner` boundary.                        | [View Map](src/docker/codemap.md)  |
| `src/secrets/` | SOPS and age dotenv encryption, decryption materialization, secure cleanup, tooling checks, and deploy pipeline integration.               | [View Map](src/secrets/codemap.md) |
| `src/env/`     | Env example discovery, `.env` scaffolding, profile materialization, key diffing, status listing, and plaintext audit findings.             | [View Map](src/env/codemap.md)     |
| `src/process/` | External command execution abstraction, real Deno process adapter, dry-run behavior, output capture, streaming, and availability checks.   | [View Map](src/process/codemap.md) |
| `src/testing/` | In-memory `ProcessRunner` test harness with configured responses, command recording, dry-run propagation, and assertion helpers.           | [View Map](src/testing/codemap.md) |

## High-Level Data & Control Flow

1. Runtime starts at `src/main.ts`, which calls `main(Deno.args)` from `src/cli/mod.ts`.
2. The CLI builds a Cliffy command tree, parses user input, and selects a command action.
3. Config-aware commands call `resolveConfig` to merge defaults, base config, profile overlays,
   local overlays, and explicit override files into a validated `ResolvedConfig`.
4. Compose workflows discover source compose files with `x-stack` metadata, load stack fragments,
   merge compose data, apply override files, transform service definitions for Swarm compatibility,
   collect named volumes, and serialize stack YAML.
5. Render workflows parse generated stack YAML, build service-specific interpolation scopes from the
   shell environment, `env_file` values, and inline service environment values, then substitute
   `${VAR}` and `$VAR` references.
6. Docker workflows pass generated or rendered compose files into Docker wrapper functions. Those
   wrappers build explicit argument vectors and execute them through `ProcessRunner`.
7. Secrets workflows use the same process boundary to call SOPS, age, shred, rm, and Docker during
   encryption, decryption, cleanup, and deploy operations.
8. Env workflows create or inspect plaintext `.env` artifacts that compose, render, and secrets
   workflows consume by convention.

## Architectural Patterns

- Command adapter layer: `src/cli/` translates user input into typed calls across the domain
  modules.
- Port and adapter boundary: `src/process/` defines `ProcessRunner`, while production uses
  `RealProcessRunner` and tests use fakes from `src/testing/`.
- Functional transformation pipeline: compose and render modules prefer pure merge, transform, and
  interpolation helpers that return new data structures.
- Layered configuration: config resolution applies deterministic file ordering and validates the
  merged result before downstream modules consume it.
- Structured result envelopes: domain operations return warnings, errors, drift state, generated
  content, and operation status as data so the CLI can decide presentation and exit codes.

## Verification Entry Points

- `deno task fmt:check`: Check formatting using the repository formatter settings.
- `deno task lint`: Run lint rules for `src/`.
- `deno task check`: Type-check `src/main.ts` with strict compiler options.
- `deno task test`: Run the unit test suite with required Deno permissions.
- `deno task coverage`: Generate a detailed coverage report after running coverage-enabled tests.

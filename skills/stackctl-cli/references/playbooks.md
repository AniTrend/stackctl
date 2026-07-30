# stackctl operational playbooks

Task-oriented workflows for agentic systems using stackctl. Each playbook shows the command chain,
prerequisites, output interpretation, and safety patterns. All workflows are verified against
`src/cli/mod.ts` and the compose, secrets, and env modules.

## Agent operating model

stackctl manages Docker Swarm stacks through a four-stage pipeline:

1. **Discover**: Find per-service Docker Compose files in the repository.
2. **Generate**: Produce canonical stack YAML from those Compose sources.
3. **Render**: Resolve `${VAR}` placeholders using service-local env values.
4. **Deploy**: Deploy rendered YAML via `docker stack deploy`.

| Command     | Pipeline stages                        | Writes to disk               | Deploys |
| ----------- | -------------------------------------- | ---------------------------- | ------- |
| `generate`  | Discover, Generate                     | Yes, to stack directory      | No      |
| `render`    | Discover, Generate, Render             | Yes, to render directory     | No      |
| `up`        | All four                               | Temp file only (cleaned up)  | Yes     |
| `reload`    | All four (no teardown)                 | Stack and render directories | Yes     |
| `sync`      | Discover, Generate, Render (in memory) | No                           | No      |
| `plan <op>` | Preview of any operation               | No                           | No      |

Key distinction: `up` generates in memory and deploys from a temp file. `reload` writes generated
and rendered files to disk first, then deploys from the rendered file. `reload` never schedules
`docker stack rm`, network removal, or volume removal.

## Prerequisites

Before any stackctl operation, verify the environment:

1. Docker is installed and running.
2. Docker Swarm mode is active. If not, run `docker swarm init`.
3. A `.stackctl` config file exists in the project root.

Run `stackctl doctor` to check all three at once. If doctor reports issues, fix them before
proceeding. Doctor checks Docker, Swarm mode, config validity, compose file validity, and render
directory writability.

For secrets operations, also verify sops and age are installed. Run `stackctl secrets check` or
`stackctl doctor --check-secrets`.

## Safety patterns

- **Always preview first**: Run `stackctl plan <operation>` before executing any deploy, reload, or
  teardown command.
- **Always dry-run first**: Add `--dry-run` to destructive or deploy commands before running them
  for real.
- **Never run `down` without `--dry-run` first** unless you intend to remove running services
  immediately.
- **Use `--json`** with `status` and `plan` when parsing results programmatically.
- **Use `--non-interactive`** with `sync` in agent contexts to avoid hanging on a confirmation
  prompt.
- **Use `--yes`** with `down` in non-interactive contexts to skip the confirmation prompt.

## Playbook: Set up a new project

Goal: Initialize stackctl in a repository that has per-service Docker Compose files but no stackctl
configuration.

```bash
stackctl doctor
stackctl init --detect --write-gitignore
stackctl generate --dry-run
stackctl generate
stackctl render --strict --dry-run
stackctl plan up
stackctl up --dry-run
```

Steps:

1. `stackctl doctor` confirms Docker, Swarm, and config are healthy. If no `.stackctl` exists yet,
   doctor reports a config error, which is expected at this stage.
2. `stackctl init --detect --write-gitignore` generates a `.stackctl` config from the repository
   layout and appends stackctl entries to `.gitignore`.
3. `stackctl generate --dry-run` previews canonical stack file generation without writing.
4. `stackctl generate` writes canonical stack files to the configured stack directory.
5. `stackctl render --strict --dry-run` previews env variable resolution in strict mode.
6. `stackctl plan up` previews the full deploy pipeline.
7. `stackctl up --dry-run` previews deployment without executing.

After setup, commit the `.stackctl` config and generated stack files. The `.env` files are
gitignored by the `--write-gitignore` step.

## Playbook: Deploy stacks

Goal: Generate, render, and deploy stacks to Docker Swarm.

`stackctl up` runs the full pipeline: discover stacks, generate in memory, render each stack, write
to a temp file, and deploy via `docker stack deploy`.

```bash
stackctl plan up
stackctl up --dry-run
stackctl up
```

Variations:

- `stackctl up --stacks api,web` deploys specific stacks only.
- `stackctl up --detach` deploys without waiting for services to converge.
- `stackctl up --prune` prunes obsolete services during deploy.
- `stackctl up --follow-logs` deploys and streams logs afterward.
- `stackctl up --profile staging` deploys using a specific profile.
- `stackctl up --override extra.yml` applies override files before rendering.

Exit code 0 means all stacks deployed successfully. Exit code 1 means at least one stack failed to
deploy. Check stderr for per-stack error messages.

## Playbook: Update running stacks without downtime

Goal: Re-render and redeploy stacks without tearing them down first.

`stackctl reload` re-renders and redeploys without `docker stack rm`. It writes generated and
rendered files to disk, then deploys from the rendered file.

```bash
stackctl reload --dry-run
stackctl reload
```

Variations:

- `stackctl reload --stacks api` reloads a specific stack.
- `stackctl reload --skip-generate` skips regeneration, only re-renders and redeploys from existing
  stack files.
- `stackctl reload --skip-unchanged` only redeploys stacks whose rendered output changed. Uses
  SHA-256 checksum comparison against the previous rendered file.
- `stackctl reload --force-service-update` runs `docker service update --force` on every service
  after deploy.
- `stackctl reload --follow-logs` streams logs for deployed stacks after reload.

Output icons in the result list:

- `deployed` shown as a checkmark: stack was re-rendered and deployed.
- `unchanged` shown as a dot: rendered output matched previous, skipped (only with
  `--skip-unchanged`).
- `error` shown as a cross: deploy or render failed. Check the error message.

If any result has action `error`, the exit code is 1.

## Playbook: Check for configuration drift

Goal: Verify that generated stack files match the committed stack files.

`stackctl sync` is drift validation only. It generates stacks in memory and compares the output to
the committed canonical stack files. It does not deploy.

```bash
stackctl sync --non-interactive
```

Exit codes:

- 0: No drift. Generated output matches committed files.
- 1: Drift detected. Generated output differs from committed files.

Variations:

- `stackctl sync` runs in interactive mode, shows diffs, and asks to proceed.
- `stackctl sync --quiet` suppresses diff output, only reports pass or fail.
- `stackctl sync --stacks api,web` checks specific stacks only.

If drift is detected (exit code 1), run `stackctl generate` to regenerate canonical stack files,
then commit them.

## Playbook: Tear down stacks

Goal: Remove Docker Swarm stacks from the cluster.

`stackctl down` is destructive. It runs `docker stack rm` for each target stack.

```bash
stackctl down --dry-run
stackctl down --yes
```

Variations:

- `stackctl down --stacks api` removes a specific stack.
- `stackctl down --yes` skips the confirmation prompt.
- `stackctl down --dry-run` previews which stacks would be removed.

Without `--yes` or `--dry-run`, stackctl prompts "Proceed? [y/N]" and waits for input. In
non-interactive agent contexts, always use `--yes` or `--dry-run` to avoid hanging.

## Playbook: Deploy with encrypted secrets

Goal: Decrypt `.env.enc` files and deploy affected stacks.

`stackctl secrets deploy` runs the full secrets pipeline: find `.env.enc` files, decrypt them with
SOPS and age, determine affected stacks from file locations, generate in memory, render, and deploy.

Prerequisites: sops and age must be installed. Run `stackctl secrets check` first.

```bash
stackctl secrets check
stackctl secrets deploy --dry-run
stackctl secrets deploy
stackctl secrets clean
```

Variations:

- `stackctl secrets deploy api web` deploys specific stacks. Stack names are positional arguments
  here, unlike `up` which uses `--stacks`.
- `stackctl secrets deploy --profile staging` deploys using a specific profile.

The deploy pipeline automatically cleans up decrypted `.env` files if any step fails. Run
`stackctl secrets clean` after successful deployment to remove any remaining decrypted files from
disk.

If no `.env.enc` files are found, the pipeline reports a warning and does nothing. If affected
stacks cannot be determined from file locations, the pipeline reports a warning and cleans up.

## Playbook: Encrypt and decrypt env files

Goal: Manage `.env` file encryption with SOPS and age.

```bash
stackctl secrets encrypt --dry-run
stackctl secrets encrypt
stackctl secrets decrypt --dry-run
stackctl secrets decrypt
```

Variations:

- `stackctl secrets encrypt services/web/.env` encrypts specific files. If files are omitted,
  stackctl discovers `.env` files that lack `.env.enc` counterparts.
- `stackctl secrets decrypt services/web/.env.enc` decrypts specific files. If files are omitted,
  stackctl discovers all `.env.enc` files.

## Playbook: Scaffold and manage env files

Goal: Create, populate, and audit `.env` files from templates.

```bash
stackctl env list
stackctl env list --json
stackctl env create
stackctl env diff
stackctl env materialize --from-profile staging
stackctl env audit
stackctl env audit --json
```

Steps:

1. `stackctl env list` discovers `.env.example` files and reports their status (whether a
   corresponding `.env` exists).
2. `stackctl env create` creates `.env` files from `.env.example` templates. Use `--force` to
   overwrite existing `.env` files.
3. `stackctl env diff` shows differences between `.env.example` and `.env` files, useful for
   detecting missing or extra variables.
4. `stackctl env materialize --from-profile <name>` populates `.env` files with values from a
   profile preset. The `--from-profile` option is required.
5. `stackctl env audit` checks `.env` files for sensitive plaintext issues. Use `--json` for
   machine-readable results.

Variations:

- `stackctl env create web` creates env for a specific service name.
- `stackctl env list --paths services/web,services/api` limits discovery to specific paths.

## Playbook: Diagnose stack issues

Goal: Investigate why a stack is failing or unhealthy.

```bash
stackctl doctor
stackctl doctor --check-secrets
stackctl status
stackctl status --json
stackctl status --stacks api
stackctl logs
stackctl logs api_web
stackctl logs --stacks api
```

Steps:

1. `stackctl doctor` checks Docker, Swarm mode, config validity, compose file validity, and render
   directory writability. Reports issues with exit code 3 if dependencies are missing.
2. `stackctl doctor --check-secrets` additionally checks for sops and age on PATH.
3. `stackctl status` shows service status for all discovered stacks. Use `--json` for
   machine-readable output that includes services and tasks per stack.
4. `stackctl logs` follows logs for all discovered services. Use positional service names or
   `--stacks` to narrow the scope.

Doctor checks performed:

- Docker installed and running.
- Docker Swarm mode active.
- Config file exists and resolves.
- Override files referenced in config exist.
- Render directory exists or is creatable.
- Each stack compose file passes `docker compose config` validation.
- sops and age on PATH (only with `--check-secrets`).

## Playbook: Preview any operation

Goal: Understand what a command will do before executing it.

`stackctl plan <operation>` produces a deterministic preview without executing. The operation
argument is required.

```bash
stackctl plan up
stackctl plan down
stackctl plan sync
stackctl plan generate
stackctl plan render
stackctl plan reload
stackctl plan env
stackctl plan secrets
stackctl plan all
stackctl plan all --json
```

Plan output includes sections with items, warnings, and errors. If errors are present, the exit code
is 1. Use `--json` for machine-readable output.

Variations:

- `stackctl plan up --stacks api,web` previews deployment of specific stacks.
- `stackctl plan up --profile staging` previews with a specific profile.
- `stackctl plan all --json` previews everything in JSON format.

## Decision tree: which command for which intent

| Agent intent                  | First command                                    | Then                                                    |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| Set up stackctl in a new repo | `stackctl doctor`                                | `stackctl init --detect --write-gitignore`              |
| Deploy all stacks             | `stackctl plan up`                               | `stackctl up`                                           |
| Deploy specific stacks        | `stackctl plan up --stacks api,web`              | `stackctl up --stacks api,web`                          |
| Update running stacks         | `stackctl reload --dry-run`                      | `stackctl reload`                                       |
| Update only changed stacks    | `stackctl reload --skip-unchanged --dry-run`     | `stackctl reload --skip-unchanged`                      |
| Check if config drifted       | `stackctl sync --non-interactive`                | Fix with `stackctl generate` if exit 1                  |
| Remove stacks                 | `stackctl down --dry-run`                        | `stackctl down --yes`                                   |
| Deploy with secrets           | `stackctl secrets check`                         | `stackctl secrets deploy` then `stackctl secrets clean` |
| Encrypt env files             | `stackctl secrets encrypt --dry-run`             | `stackctl secrets encrypt`                              |
| Scaffold env files            | `stackctl env list`                              | `stackctl env create`                                   |
| Populate env from profile     | `stackctl env materialize --from-profile <name>` | `stackctl env audit`                                    |
| Diagnose issues               | `stackctl doctor`                                | `stackctl status` then `stackctl logs`                  |
| Preview any operation         | `stackctl plan <operation>`                      | Execute the actual command                              |

## Exit code interpretation

| Code | Meaning                      | Agent action                                    |
| ---- | ---------------------------- | ----------------------------------------------- |
| 0    | Success                      | Proceed with next step                          |
| 1    | Drift or validation failure  | Check stderr, fix config or regenerate stacks   |
| 2    | User config error            | Check `.stackctl` config file syntax and values |
| 3    | Missing dependency           | Install Docker, sops, or age as indicated       |
| 4    | Unexpected or internal error | Check stderr for error message, report as bug   |

## Config and profile selection

Config is resolved from layers, where later layers win:

1. Built-in defaults.
2. `.stackctl` (base config).
3. `.stackctl.<profile>` (profile overlay).
4. `.stackctl.local` (local overrides, gitignored).
5. `.stackctl.local.<profile>` (local profile overlay).
6. Explicit `--override` files, applied after config layers but before rendering.

Profile selection precedence: `--profile` flag over `STACKCTL_PROFILE` environment variable. Use
`--profile staging` to target a specific environment.

Config merges use: scalars replaced, maps deep-merged, sequences appended.

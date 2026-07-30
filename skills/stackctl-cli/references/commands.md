# stackctl command reference

This reference is based on `src/cli/mod.ts`. When this file conflicts with source, use source and
update the skill.

## Global command

| Command    | Description                            | Options                      |
| ---------- | -------------------------------------- | ---------------------------- |
| `stackctl` | Shows help when no subcommand matches. | `--debug`, `--config <path>` |

## Top-level commands

| Command                | Arguments                               | Description                                                                            | Options and caveats                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stackctl init`        | None                                    | Generate a commented `.stackctl` configuration file.                                   | `--detect`, `--preset <name>`, `--profile <name>`, `--write-gitignore`, `--force`, `--dry-run`. There is no verified `--project` flag.                                                                                                                                                    |
| `stackctl generate`    | None                                    | Generate canonical stack files from per-service Compose sources.                       | `--dry-run`, `--stacks <names>`, `--output-dir <path>`, `--profile <name>`, `--override <files>`. Stack and override values are comma-separated.                                                                                                                                          |
| `stackctl render`      | None                                    | Resolve `${VAR}` placeholders in generated stack files using service-local env values. | `--stacks <names>`, `--profile <name>`, `--strict`, `--output-dir <path>`, `--override <files>`, `--dry-run`. Stack and override values are comma-separated.                                                                                                                              |
| `stackctl up`          | None                                    | Generate, render, and deploy stacks to Docker Swarm.                                   | `--follow-logs`, `--dry-run`, `--detach`, `--prune`, `--stacks <names>`, `--profile <name>`, `--override <files>`. Stack names are selected with `--stacks`; do not document positional stack args.                                                                                       |
| `stackctl down`        | None                                    | Remove Docker Swarm stacks from the cluster.                                           | `--yes`, `--dry-run`, `--stacks <names>`, `--profile <name>`. Stack names are selected with `--stacks`; do not document positional stack args. This is destructive unless `--dry-run` is used.                                                                                            |
| `stackctl status`      | None                                    | Show stack service status.                                                             | `--json`, `--stacks <names>`, `--profile <name>`.                                                                                                                                                                                                                                         |
| `stackctl logs`        | `[services...]`                         | Follow service logs.                                                                   | `--stacks <names>`, `--profile <name>`, `--follow`, `--tail <n>`. Positional arguments are service names. Without service names, discovered stack services are used, optionally filtered by `--stacks`.                                                                                   |
| `stackctl sync`        | None                                    | Validate that generated stacks match committed stack files.                            | `--quiet`, `--non-interactive`, `--profile <name>`, `--stacks <names>`. This is drift validation only, not deploy.                                                                                                                                                                        |
| `stackctl doctor`      | None                                    | Check system and project health.                                                       | `--fix-volumes`, `--check-secrets`, `--profile <name>`. `--fix-volumes` currently reports `External volumes: not yet implemented`; it is not an implemented repair.                                                                                                                       |
| `stackctl reload`      | None                                    | Re-render and redeploy stacks without tearing down.                                    | `--skip-generate`, `--skip-unchanged`, `--force-service-update`, `--no-force-service-update`, `--follow-logs`, `--stacks <names>`, `--profile <name>`, `--config <path>`, `--override <files>`, `--dry-run`. Reload never schedules stack, network, or volume removal in source comments. |
| `stackctl plan`        | `<operation>`                           | Produce a deterministic plan of what an operation would do.                            | `--profile <name>`, `--stacks <names>`, `--override <files>`, `--json`. The operation argument is required. Do not show bare `stackctl plan`.                                                                                                                                             |
| `stackctl completions` | Provided by Cliffy completions command. | Generate shell completions.                                                            | Source wires `new CompletionsCommand()`. Check generated help for shell-specific usage.                                                                                                                                                                                                   |

## `plan` operations

Use `stackctl plan <operation>`. Do not use bare `stackctl plan`.

| Operation  | Notes                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `up`       | Preview stack deployment.                                                                                                         |
| `down`     | Preview stack removal.                                                                                                            |
| `sync`     | Preview the operation registered as `sync`. Do not describe live `stackctl sync` as deploy; live `sync` is drift validation only. |
| `generate` | Preview stack generation only.                                                                                                    |
| `render`   | Preview rendering only.                                                                                                           |
| `reload`   | Preview config-first reload.                                                                                                      |
| `env`      | Preview env file scaffolding.                                                                                                     |
| `secrets`  | Preview secrets workflow.                                                                                                         |
| `all`      | Preview everything.                                                                                                               |

Source examples include:

```bash
stackctl plan sync
stackctl plan up --profile staging
stackctl plan generate --stacks api,web
stackctl plan all --json
```

## Secrets commands

| Command                    | Arguments     | Description                                               | Options and caveats                                                                              |
| -------------------------- | ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `stackctl secrets encrypt` | `[files...]`  | Encrypt `.env` files to `.env.enc` using SOPS and age.    | `--dry-run`. If files are omitted, source discovers `.env` files without encrypted counterparts. |
| `stackctl secrets decrypt` | `[files...]`  | Decrypt `.env.enc` files to `.env` using SOPS and age.    | `--dry-run`. If files are omitted, source discovers encrypted env files.                         |
| `stackctl secrets deploy`  | `[stacks...]` | Decrypt env files and deploy stacks.                      | `--profile <name>`, `--dry-run`. Stack names are positional arguments here.                      |
| `stackctl secrets clean`   | None          | Remove decrypted `.env` files securely with shred and rm. | `--dry-run`.                                                                                     |
| `stackctl secrets check`   | None          | Check secrets tooling availability.                       | No subcommand options are registered in source.                                                  |

## Env commands

| Command                    | Arguments | Description                                               | Options and caveats                                                                                                            |
| -------------------------- | --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `stackctl env list`        | None      | List discovered `.env.example` files and their status.    | `--profile <name>`, `--paths <paths>`, `--json`, `--list`. Paths are comma-separated.                                          |
| `stackctl env create`      | `[name]`  | Create `.env` files from `.env.example` templates.        | `--profile <name>`, `--paths <paths>`, `--force`, `--dry-run`, `--json`.                                                       |
| `stackctl env diff`        | `[name]`  | Show differences between `.env.example` and `.env` files. | `--profile <name>`, `--paths <paths>`, `--json`.                                                                               |
| `stackctl env materialize` | None      | Materialize profile preset env values into `.env` files.  | `--from-profile <name>` is required. Also supports `--paths <paths>`, `--force`, `--dry-run`, `--json`.                        |
| `stackctl env audit`       | None      | Check `.env` files for sensitive plaintext issues.        | `--paths <paths>`, `--dry-run`, `--json`, `--suggest`. Suggestions are enabled unless disabled by the boolean option handling. |

## Stack argument rules

| Workflow                   | Valid stack selection               |
| -------------------------- | ----------------------------------- |
| Deploy with `up`           | `stackctl up --stacks api,web`      |
| Remove with `down`         | `stackctl down --stacks api,web`    |
| Deploy with secrets        | `stackctl secrets deploy api web`   |
| Logs for explicit services | `stackctl logs api_web worker`      |
| Logs for stacks            | `stackctl logs --stacks api,web`    |
| Plan for stacks            | `stackctl plan up --stacks api,web` |

## Safe examples

```bash
stackctl init
stackctl generate --stacks api,web
stackctl render --strict --stacks api
stackctl up --stacks api,web --dry-run
stackctl down --stacks api --dry-run
stackctl sync --non-interactive
stackctl reload --stacks api --skip-unchanged
stackctl secrets deploy api web --dry-run
stackctl env materialize --from-profile staging --dry-run
stackctl plan all
```

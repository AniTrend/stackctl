# stackctl

[![CI](https://github.com/AniTrend/stackctl/actions/workflows/ci.yml/badge.svg)](https://github.com/AniTrend/stackctl/actions/workflows/ci.yml)

A Deno-powered CLI for managing local Docker Compose stacks across multi-service repositories, with
config-driven profiles, overrides, secrets, and render pipelines.

Status: **Active development** -- 16 top-level commands implemented (see table below).

---

## Commands

| Command                | Status      | Description                                                          |
| ---------------------- | ----------- | -------------------------------------------------------------------- |
| `stackctl init`        | Implemented | Generate commented `.stackctl` config                                |
| `stackctl generate`    | Implemented | Generate `stacks/*.yml` from per-service sources                     |
| `stackctl render`      | Implemented | Resolve `${VAR}` placeholders in stack files                         |
| `stackctl up`          | Implemented | Deploy stacks to Docker Swarm                                        |
| `stackctl down`        | Implemented | Tear down stacks                                                     |
| `stackctl service`     | Implemented | Manage individual Swarm services (`shutdown` scales one to zero)     |
| `stackctl status`      | Implemented | Show service status                                                  |
| `stackctl health`      | Implemented | Evaluate deployed stack health from replica and task state           |
| `stackctl logs`        | Implemented | Follow service logs                                                  |
| `stackctl sync`        | Implemented | Validate generated stacks match committed files (CI drift detection) |
| `stackctl doctor`      | Implemented | Check system and project health                                      |
| `stackctl reload`      | Implemented | Re-render and reconcile without teardown                             |
| `stackctl secrets`     | Implemented | Encrypt/decrypt/deploy/clean/check with SOPS+age                     |
| `stackctl env`         | Implemented | Scaffold `.env` files from examples                                  |
| `stackctl plan`        | Implemented | Dry-run summary of all operations                                    |
| `stackctl completions` | Implemented | Generate shell completions (bash/zsh/fish)                           |

Override merging is integrated into `generate`, `render`, `up`, `reload`, and `plan` via the
`--override` flag.

---

## Quick Start

```bash
# Install
deno install -f --allow-run --allow-env --allow-read --allow-write \
  -n stackctl jsr:@anitrend/stackctl

# Initialize a config
stackctl init

# Generate stacks from service sources
stackctl generate

# See what would happen
stackctl plan all
```

---

## Features

- Config-driven profiles with layered overlays (`.stackctl`, `.stackctl.<profile>`,
  `.stackctl.local`, `.stackctl.local.<profile>`)
- SOPS + age encrypted secrets management
- `${VAR}` render pipeline with service-local env resolution
- Docker Swarm deploy with dry-run planning
- Read-only stack health evaluation from Swarm replica and task state (`health`)
- Per-service shutdown to zero replicas with dry-run and confirmation (`service shutdown`)
- CI drift detection via `sync` command
- Shell completions (bash/zsh/fish)

### Secrets Subcommands

| Subcommand | Description                                         |
| ---------- | --------------------------------------------------- |
| `encrypt`  | Encrypt `.env` files using SOPS + age               |
| `decrypt`  | Decrypt `.env.enc` files back to plaintext          |
| `deploy`   | Decrypt env files and deploy stacks                 |
| `clean`    | Remove decrypted `.env` files securely (shred + rm) |
| `check`    | Check secrets tooling availability (sops, age)      |

### Env Subcommands

| Subcommand    | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| `list`        | List `.env` files with status (present/missing/outdated)     |
| `create`      | Create `.env` from `.env.example`                            |
| `diff`        | Compare `.env` against `.env.example`                        |
| `materialize` | Copy profile-specific env to `.env`                          |
| `audit`       | Check for plaintext `.env` files with encrypted counterparts |

## Profiles

A profile is a named set of config overlays merged on top of the base `.stackctl` file. Use them
for environment-specific settings (e.g. `production` vs `development`) without editing the
committed base config.

Select a profile per invocation with the `--profile` flag or the `STACKCTL_PROFILE` environment
variable. The flag wins when both are set:

```bash
stackctl up --profile production

STACKCTL_PROFILE=production stackctl up
```

Run `stackctl init --profile production` to scaffold a `.stackctl.production` file.

### Layered config files

A representative profile setup for a project with a `production` profile:

`.stackctl` (base, committed):

```yaml
project: acme

stack:
  directory: "stacks"
  names:
    - "web"
    - "worker"
  network: "traefik-public"
```

`.stackctl.production` (profile overlay, committed):

```yaml
stack:
  names:
    - "web"
    - "worker"
    - "cron"

commands:
  up:
    followLogs: false
```

`.stackctl.local` (machine-specific, gitignored):

```yaml
stack:
  network: "acme-dev-network"
```

`.stackctl.local.production` (machine-specific production tweaks, gitignored):

```yaml
stack:
  network: "acme-prod-network"
```

With `--profile production`, the resolved config is built from all five files above: `names`
becomes `[web, worker, cron]` (the profile's list replaces the base list, so any base-only
entries are dropped) and `network` ends up as `acme-prod-network` (later layers win).

### Precedence

Config layers are merged in this order, later wins:

1. Built-in defaults
2. `.stackctl` (base)
3. `.stackctl.<profile>` (profile overlay)
4. `.stackctl.local` (local overrides, gitignored)
5. `.stackctl.local.<profile>` (local profile overlay, gitignored)

Merging is deep: scalars are replaced, maps are deep-merged, and sequences are replaced by the
overlay (they are not concatenated). Without a profile, only layers 1, 2, and 4 apply.
`stackctl plan` prints the active profile when one is selected and lists the explicit
`--override` files passed to it, which is a quick way to confirm which profile the current
invocation resolves to.

## Project Configuration

### Ignoring directories (stack.skipDirectories)

`stack.skipDirectories` is the supported project ignore mechanism. Compose discovery walks the
repository for `docker-compose.yml`/`docker-compose.yaml` files that declare `x-stack` metadata;
any compose file found under a directory whose name is listed here is filtered out of the
discovery result, so it is never generated or deployed:

```yaml
# .stackctl
stack:
  skipDirectories:
    - "archive"
    - "vendor"
    - "experiments"
```

Names are matched against any path segment, so `vendor` skips both `vendor/` and
`services/vendor/`. Hidden (dot-prefixed) directories are always skipped, and `node_modules`,
`stacks`, `tools`, `environments`, and `__pycache__` are skipped by default. Every command that
performs discovery (`generate`, `render`, `up`, `down`, `status`, `health`, `logs`, `sync`,
`reload`, `plan`, `secrets`) honors the setting; `stackctl plan` prints the configured skip
list when one is set.

### Override files (--override)

The `--override` flag applies Docker Compose override files to the generated stack data after
source composition and before rendering/serialization:

```bash
stackctl up --override ./overrides/production.yml
```

Overrides change discovered stack data, not discovery itself: the set of stacks that exists is
determined solely by the compose-file walk (`x-stack` metadata plus `stack.skipDirectories`). An
override cannot add, rename, or remove a stack from the plan; it only modifies the content of
already discovered ones. Merge semantics follow Docker Compose convention: scalars replaced,
maps deep-merged, sequences appended.

## Operations

### Health checks

`stackctl health` evaluates deployed stack health from Swarm service and task state. It is
read-only: it never mutates Swarm state, never schedules redeploys, and never shuts anything
down.

```bash
# Evaluate every discovered stack
stackctl health

# Evaluate specific stacks
stackctl health --stacks web,worker

# Machine-readable output (exit code still reflects overall health)
stackctl health --json
```

A service is reported unhealthy when:

- its replica counts do not match (`running` != `desired`, including running above desired)
- any of its tasks is in a `Failed` or `Rejected` current state
- its data cannot be parsed (evaluation fails closed rather than skipping)

`--stacks` takes a comma-separated list; without it, all discovered stacks are evaluated. The
exit code is 1 when any evaluated stack is unhealthy (suitable for CI gates) and 0 when all are
healthy. `--json` prints the full per-stack, per-service result, including failed tasks and
their reasons.

Example human output:

```
=== web ===
  ✓ web_api (2/2)
  ✗ web_worker (0/2)
      replicas 0/2: running below desired
```

### Service shutdown

`stackctl service shutdown` scales an exact Swarm service down to zero replicas. The service
definition is kept, so `stackctl up` can bring it back later; only its replicas are scaled to 0
via `docker service scale <name>=0`.

```bash
# Scale down (prompts for confirmation unless --yes)
stackctl service shutdown traefik_web

# Preview the planned scale command without executing it
stackctl service shutdown traefik_web --dry-run

# Skip the confirmation prompt
stackctl service shutdown traefik_web --yes
```

The argument must be the exact, full Docker service identifier, not a bare compose service
name. Swarm service names are typically stack-prefixed (e.g. `traefik_web` for service `web` in
the `traefik` stack), but a stack prefix is not enforced: names must start with an alphanumeric
character and may contain letters, digits, `.`, `_`, and `-`. An invalid service name exits
with code 2; a failed scale, including a missing service, exits with code 1. In `--dry-run`
mode the command prints the intended `docker service scale <name>=0` invocation without running
it.

## AI agent skill

Agents can install the `stackctl-cli` skill for source-valid stackctl CLI guidance:

```bash
npx skills add anitrend/stackctl --skill stackctl-cli
npx skills add anitrend/stackctl --skill stackctl-cli -g -y
```

This installs only the AI agent skill. It does not install the `stackctl` CLI, add runtime
dependencies, or make this repository a Node or npm project. `stackctl` remains a Deno 2.x project
with dependencies resolved from JSR.

Restart or reload OpenCode after installing new skills so the skill is discovered.

## GitHub Actions

A composite action for installing stackctl in GitHub Actions is available at
`.github/actions/setup-stackctl/`. See [docs/migration.md](docs/migration.md) for details.

---

## Development

### Prerequisites

- [Deno 2.x](https://deno.com) (2.8.0+)

### Setup

```bash
git clone git@github.com:AniTrend/stackctl.git
cd stackctl

# Run tests
deno task test

# Run checks
deno task check

# Build a binary
deno task build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, commit conventions, and PR guidelines.

---

## License

```
Copyright 2026 AniTrend

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

# stackctl

[![CI](https://github.com/AniTrend/stackctl/actions/workflows/ci.yml/badge.svg)](https://github.com/AniTrend/stackctl/actions/workflows/ci.yml)

A Deno-powered CLI for managing local Docker Compose stacks across multi-service repositories, with config-driven profiles, overrides, secrets, and render pipelines.

Status: **Active development** -- 14 of 15 commands implemented (see table below).

---

## Commands

| Command | Status | Description |
|---|---|---|
| `stackctl init` | Implemented | Generate commented `.stackctl` config |
| `stackctl generate` | Implemented | Generate `stacks/*.yml` from per-service sources |
| `stackctl render` | Implemented | Resolve `${VAR}` placeholders in stack files |
| `stackctl up` | Implemented | Deploy stacks to Docker Swarm |
| `stackctl down` | Implemented | Tear down stacks |
| `stackctl status` | Implemented | Show service status |
| `stackctl logs` | Implemented | Follow service logs |
| `stackctl sync` | Implemented | Validate generated stacks match committed files (CI drift detection) |
| `stackctl doctor` | Implemented | Check system and project health |
| `stackctl reload` | Implemented | Re-render and reconcile without teardown |
| `stackctl secrets` | Implemented | Encrypt/decrypt/deploy/clean/check with SOPS+age |
| `stackctl env` | Implemented | Scaffold `.env` files from examples |
| `stackctl plan` | Implemented | Dry-run summary of all operations |
| `stackctl completions` | Implemented | Generate shell completions (bash/zsh/fish) |

Override merging is integrated into `generate`, `render`, and `up` via the `--override` flag.

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
stackctl plan
```

---

## Features

- Config-driven profiles with layered overrides (`.stackctl`, `.stackctl.<profile>`, `.stackctl.local`)
- SOPS + age encrypted secrets management
- `${VAR}` render pipeline with service-local env resolution
- Docker Swarm deploy with dry-run planning
- CI drift detection via `sync` command
- Shell completions (bash/zsh/fish)

### Secrets Subcommands

| Subcommand | Description |
|---|---|
| `encrypt` | Encrypt `.env` files using SOPS + age |
| `decrypt` | Decrypt `.env.enc` files back to plaintext |
| `deploy` | Decrypt env files and deploy stacks |
| `clean` | Remove decrypted `.env` files securely (shred + rm) |
| `check` | Check secrets tooling availability (sops, age) |

### Env Subcommands

| Subcommand | Description |
|---|---|
| `list` | List `.env` files with status (present/missing/outdated) |
| `create` | Create `.env` from `.env.example` |
| `diff` | Compare `.env` against `.env.example` |
| `materialize` | Copy profile-specific env to `.env` |
| `audit` | Check for plaintext `.env` files with encrypted counterparts |

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

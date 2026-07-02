# stackctl

[![CI](https://github.com/AniTrend/stackctl/actions/workflows/ci.yml/badge.svg)](https://github.com/AniTrend/stackctl/actions/workflows/ci.yml)

A Deno-powered CLI for managing local Docker Compose stacks across multi-service repositories, with config-driven profiles, overrides, secrets, and render pipelines.

Status: **Early development** -- all 15 feature issues are planned and tracked on the [issue tracker](https://github.com/AniTrend/stackctl/issues).

---

## Commands

| Command | Status | Description |
|---|---|---|
| `stackctl init` | Planned | Generate commented `.stackctl` config |
| `stackctl generate` | Planned | Generate `stacks/*.yml` from per-service sources |
| `stackctl render` | Planned | Resolve `${VAR}` placeholders in stack files |
| `stackctl overrides` | Planned | Profile and explicit override merging |
| `stackctl up` | Planned | Deploy stacks to Docker Swarm |
| `stackctl down` | Planned | Tear down stacks |
| `stackctl status` | Planned | Show service status |
| `stackctl logs` | Planned | Follow container logs |
| `stackctl sync` | Planned | Sync images and volumes |
| `stackctl doctor` | Planned | Validate environment |
| `stackctl reload` | Planned | Re-render and reconcile without teardown |
| `stackctl secrets` | Planned | Encrypt/decrypt/deploy/clean/check with SOPS+age |
| `stackctl env` | Planned | Scaffold `.env` files from examples |
| `stackctl plan` | Planned | Dry-run summary of all operations |
| `stackctl completions` | Planned | Generate shell completions (bash/zsh/fish) |

---

## Quick Start

```bash
# Install (once released)
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

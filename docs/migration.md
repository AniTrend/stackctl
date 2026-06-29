# Migration Guide: `stackctl.sh` to `stackctl`

> **DRAFT -- In Progress**
>
> This document tracks the migration from `stackctl.sh` to the standalone `stackctl`
> binary. The CLI contracts, release workflow, and GitHub Actions integration are
> still evolving. Sections marked with ⚠️ may change before the first stable
> release.

This guide documents the migration from the repository-local `./stackctl.sh` script to the
standalone `stackctl` binary. It covers configuration migration, command mapping, behavior
differences, and rollback instructions.

## Overview

`AniTrend/local-stack` historically shipped a `tools/stackctl.sh` script plus Python-based
generation and rendering tools (`generate_stacks.py`, `render_compose.py`). The `stackctl` binary
replaces this entire toolchain with a single Deno-compiled binary, eliminating the Python and script
dependencies.

| Before                          | After                          |
| ------------------------------- | ------------------------------ |
| `./stackctl.sh up`              | `stackctl up`                  |
| Python 3 + dependencies         | Single binary, no runtime      |
| Per-repo local script           | System-wide install (Homebrew) |
| Shell-based config via env vars | `~/.stackctl` YAML config      |
| Manual profile switching        | Built-in profile overlays      |

## Prerequisites

- **Docker** with Swarm mode enabled (same as before)
- **stackctl binary** — installed via one of:
  - Homebrew: `brew install AniTrend/tap/stackctl`
  - **GitHub Releases**: download the appropriate tarball
    (`stackctl-v<version>-<target-triple>.tar.gz`) from the
    [latest release](https://github.com/AniTrend/stackctl/releases). Supported
    triples: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
    `x86_64-apple-darwin`, `aarch64-apple-darwin`.
  - Manual:
    `deno install -n stackctl --allow-read --allow-write --allow-env --allow-run --allow-sys jsr:@anitrend/stackctl`
- **SOPS + age** (optional) — only needed for `stackctl secrets` commands

## Quick Start

```bash
# Verify installation
stackctl --version

# Initialize config in your project
stackctl init

# Deploy all stacks
stackctl sync

# Check environment
stackctl doctor
```

## Configuration Migration

### Before: Environment Variables

The old `stackctl.sh` used shell environment variables and `.env` files:

```bash
export COMPOSE_DIR="./docker-compose"
export RENDER_DIR="./.rendered"
export STACKS_DIR="./stacks"
export STACK_PREFIX="mystack"
export STACKCTL_PROFILE="dev"
```

### After: YAML Config File

Create a `.stackctl` file (generated via `stackctl init`):

```yaml
project: myproject

stack:
  # Service directories containing compose files with x-stack labels
  directory: ./stack
  # Stack names to manage (empty = all discovered)
  names: []
  # Default Docker network
  network: myproject_default
  # Override files (profile or explicit)
  overrides: []

render:
  # Output directory for rendered YAML
  outputDirectory: ./.rendered
  # Fail on unresolved variables
  strict: false
```

### Converting Environment Variables

| Old Environment Variable | New Config Field                           | Example            |
| ------------------------ | ------------------------------------------ | ------------------ |
| `COMPOSE_DIR`            | `stack.directory`                          | `./docker-compose` |
| `RENDER_DIR`             | `render.outputDirectory`                   | `./.rendered`      |
| `STACKS_DIR`             | No equivalent (generated to `stacks/`)     | —                  |
| `STACK_PREFIX`           | `project`                                  | `mystack`          |
| `STACKCTL_PROFILE`       | `--profile` flag or `STACKCTL_PROFILE` env | `dev`              |

## Command Parity

These commands have reached functional parity with the old `stackctl.sh` script:

| Old (`./stackctl.sh`)  | New (`stackctl`)  | Notes                     |
| ---------------------- | ----------------- | ------------------------- |
| `./stackctl.sh up`     | `stackctl up`     | Replaces shell-based deploy |
| `./stackctl.sh down`   | `stackctl down`   | —                         |
| `./stackctl.sh status` | `stackctl status` | Now with `--json` output  |
| `./stackctl.sh logs`   | `stackctl logs`   | Improved streaming        |
| `./stackctl.sh reload` | `stackctl reload` | Full config-aware pipeline |
| `./stackctl.sh doctor` | `stackctl doctor` | More comprehensive checks |

### New Capabilities (No `stackctl.sh` Equivalent)

The standalone binary adds capabilities that were previously handled by separate
Python scripts or not available at all:

| Command             | Purpose                                    |
| ------------------- | ------------------------------------------ |
| `stackctl generate` | Explicit stack regeneration                |
| `stackctl render`   | Explicit environment interpolation         |
| `stackctl secrets`  | SOPS/age integration                       |
| `stackctl env`      | `.env` scaffolding                         |
| `stackctl plan`     | Inspect operations without executing       |
| `stackctl init`     | Config file generation                     |
| `stackctl sync`     | Full pipeline (generate → render → deploy) |

## Step-by-Step Migration

### Step 1: Export Current Configuration

Record your current `stackctl.sh` environment:

```bash
echo "COMPOSE_DIR=${COMPOSE_DIR:-./docker-compose}"
echo "RENDER_DIR=${RENDER_DIR:-./.rendered}"
echo "STACK_PREFIX=${STACK_PREFIX}"
echo "STACKCTL_PROFILE=${STACKCTL_PROFILE:-dev}"
```

### Step 2: Run `stackctl init`

```bash
# Interactive detection (scans for docker-compose files)
stackctl init

# Or with explicit values
stackctl init --project myproject --preset standard
```

This creates `.stackctl` in your project root. Edit it to match your recorded configuration from
Step 1.

### Step 3: Verify Configuration

```bash
stackctl doctor
```

Fixes any issues reported:

- Missing Docker or Swarm mode
- Invalid or missing `.stackctl` config
- Missing override files
- Missing stack directories

### Step 4: Dry-Run a Deployment

```bash
# See what would happen without making changes
stackctl sync --dry-run
stackctl up --dry-run
```

Review the output carefully. The pipeline is:

```
Config → Discover → Generate → Override → Render → Deploy
```

### Step 5: Deploy

```bash
# Deploy all stacks
stackctl sync

# Or deploy incrementally
stackctl up my-stack-name
```

### Step 6: Verify

```bash
stackctl status
stackctl logs my-service
```

## Profile Handling

### Before

```bash
STACKCTL_PROFILE=prod ./stackctl.sh up
```

### After

Profiles use separate config overlays:

```bash
# Using flag
stackctl up --profile prod

# Using environment variable
STACKCTL_PROFILE=prod stackctl up
```

Profile overlays are loaded in this order (later wins):

1. Built-in defaults
2. `.stackctl` (base)
3. `.stackctl.<profile>` (e.g., `.stackctl.prod`)
4. `.stackctl.local` (local overrides, gitignored)
5. `.stackctl.local.<profile>` (local profile overrides)

## Override File Support

`stackctl` supports explicit override files in addition to profile overlays. Override files use
Docker Compose override semantics:

- **Scalars**: replaced
- **Maps**: deep-merged
- **Sequences**: appended

```bash
stackctl up --override ./overrides/production.yml --override ./overrides/region-eu.yml
```

Override files are applied _after_ profile merging but _before_ render.

## Rollback

### Rollback a Deployment

```bash
# Remove a specific stack
stackctl down my-stack-name

# Re-deploy previous version
docker stack deploy --compose-file .rendered/my-stack-name.rendered.yml my-stack-name
```

### Rollback stackctl Binary

```bash
# Homebrew
brew switch stackctl <previous-version>

# Manual
cp /usr/local/bin/stackctl /usr/local/bin/stackctl.new
# ... download previous version
mv stackctl.previous /usr/local/bin/stackctl
```

### Revert to stackctl.sh

The old `stackctl.sh` remains in your repository and is unaffected by `stackctl` installation. To
revert:

1. Uninstall `stackctl`: `brew uninstall stackctl`
2. Delete `.stackctl` config: `rm .stackctl`
3. Continue using `./stackctl.sh` as before

Generated files (`stacks/*.yml`, `.rendered/*.yml`) are compatible between both tools for the same
configuration.

## Troubleshooting

### Docker Not Running

```
✗ Docker is not running or not accessible
```

Ensure Docker is running and your user has access:

```bash
docker info
```

### Swarm Mode Not Active

```
✗ Docker Swarm mode is not active
```

Initialize Swarm mode:

```bash
docker swarm init
```

### Stack Not Found

```
✗ Stack "myapp" not found in /path/to/project
```

Check that compose files have the `x-stack` label and are in the configured `stack.directory`:

```yaml
# docker-compose.yml
services:
  api:
    image: myapp/api
x-stack:
  name: myapp
```

### Config Validation Errors

`stackctl` validates configuration at startup. Run `stackctl doctor` for a complete diagnostic.
Common issues:

- **Missing `project`**: Set the project name in `.stackctl`
- **Missing `stack.network`**: Set the Docker network name
- **Empty `stack.names`**: Leave as `[]` to discover all stacks, or list specific stack names
- **Invalid `render.outputDirectory`**: Must be a valid path

### Unresolved Environment Variables

In strict mode (`render.strict: true`), unused variables cause failure. Switch to non-strict mode or
provide the variables:

```bash
# Non-strict mode
echo 'render:\n  strict: false' >> .stackctl

# Provide variable
export MY_VAR=value
stackctl up
```

### Permission Issues

`stackctl` requires these permissions:

- `--allow-read` — read compose files, config, env files
- `--allow-write` — write generated/rendered stacks
- `--allow-env` — read environment variables
- `--allow-run` — execute Docker, sops, age
- `--allow-sys` — system info for doctor

When installed via Homebrew, permissions are pre-configured.

## Behavior Differences

### Generated Stack Paths

- **Old**: Relative paths in generated stacks reference the repo root
- **New**: Paths are absolutized to the project root during rendering

This means `.rendered/*.yml` files are self-contained and can be used independently of the working
directory.

> ⚠️ **Generated files are not safe to deploy raw.** Stack files in `stacks/`
> (generated) and `.rendered/` (rendered) contain `${VAR}` placeholders that
> must be resolved through the render pipeline before deployment. Deploying a
> generated stack file directly without running `stackctl render` or
> `stackctl sync` will result in unresolved environment variables in your
> running services.

### Deterministic Output

`stackctl` produces deterministic YAML output:

- Keys are sorted alphabetically
- Stack files are ordered by stack name
- Runs produce identical output for identical input

This enables drift detection in CI.

### Error Reporting

- **Old**: First error stops the pipeline
- **New**: All errors are collected and reported at once
- Exit codes: 0=success, 1=validation/drift failure, 2=config error, 3=missing dependency,
  4=unexpected error

### Signal Handling

- **Old**: Ctrl-C may leave processes running
- **New**: SIGINT is forwarded to child processes; `secrets deploy` runs cleanup on interruption

## Using stackctl in GitHub Actions

> ⚠️ The GitHub Actions integration is under active development and its location
> may change before the first stable release.

Add the `setup-stackctl` composite action to your workflow to install the stackctl binary on any
GitHub Actions runner (Linux x64/arm64, macOS x64/arm64):

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup stackctl
        uses: AniTrend/stackctl/.github/actions/setup-stackctl@v1
        with:
          version: latest # or a specific version like "0.1.0"

      - name: Verify installation
        run: stackctl --version

      - name: Run stackctl sync
        run: stackctl sync
```

The action selects the correct tarball
(`stackctl-v<version>-<target-triple>.tar.gz`) for the runner's OS and
architecture, verifies the SHA256 checksum, and adds the binary to `PATH` for
all subsequent steps.

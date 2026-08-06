# src/cli/

## Responsibility

The CLI command layer exposes the `stackctl` executable interface. It builds the Cliffy command
tree, maps command-line options and positional arguments into typed operation inputs, invokes the
domain modules, formats human-readable or JSON output, and translates validation, dependency, and
unexpected failures into process exit codes.

## Design Patterns

- Command registration is centralized in `buildCli()`, which creates the root `Command`, attaches
  global metadata and options, then registers each top-level command and nested command in one
  command tree.
- Each command action is a thin adapter. It extracts options from `Record<string, unknown>`, casts
  Cliffy parsed values to local types, normalizes comma-separated lists, resolves the active working
  directory with `Deno.cwd()`, and delegates work to a module function.
- Runner injection is explicit at Docker and secrets boundaries. Command actions instantiate
  `RealProcessRunner`, passing `dryRun` where supported, then provide that runner to Docker and
  secrets operations instead of invoking external tools directly.
- Exit handling uses the shared `ExitCode` enum for semantic results. Many command actions set the
  module-level `exitCode` and return, while some deeper asynchronous paths call `Deno.exit()` for
  immediate termination.
- Output handling stays in the CLI layer. Domain results return structured data, warnings, errors,
  and generated content. The CLI decides whether to print tables, diffs, YAML, JSON, warnings, or
  status lines.

## Data & Control Flow

1. `main(args)` calls `buildCli().parse(args)` and returns the accumulated `exitCode`. Parse errors
   or uncaught exceptions are converted to exit code `1`.
2. `buildCli()` registers root options such as `--debug` and `--config`, a default help action, and
   commands for initialization, generation, rendering, stack lifecycle, health checks, reload,
   secrets, environment files, service-level lifecycle, planning, and shell completions.
3. Command actions parse Cliffy options, including boolean flags, required string options,
   positional arguments, and comma-separated lists such as `--stacks`, `--override`, and `--paths`.
4. Most commands resolve configuration with `resolveConfig({ profile, cwd })`, derive `repoRoot`,
   then pass normalized inputs to config, compose, render, docker, env, or secrets functions.
   Config-aware discovery passes `config.base.stack.skipDirectories` as `skipDirs`, so project
   ignores apply consistently to `up`, `down`, `status`, `logs`, `health`, completions, `sync`,
   `plan`, `reload`, generation, and the secrets deploy pipeline.
5. Compose workflows commonly discover stack names, generate stack YAML in memory, parse generated
   YAML, render variables, optionally write files, and then deploy, reload, compare, or report.
6. Docker-backed commands create a `RealProcessRunner` and delegate Docker CLI interaction to docker
   wrapper functions. Dry-run commands use a dry-run runner or skip mutation and print intended
   actions.
7. Result objects drive final control flow. Errors and drift set `ExitCode.DriftOrValidation`, user
   configuration errors set `ExitCode.UserConfigError`, missing external tooling sets
   `ExitCode.MissingDependency`, and uncaught command exceptions set `ExitCode.UnexpectedError`.
8. `service shutdown <name>` scales an exact full Swarm service name to zero replicas via
   `shutdownService` from `src/docker/service.ts`. It confirms by default (prompt), supports `--yes`
   and `--dry-run`, validates the name shape (exit 2), and reports missing or failed targets with
   exit 1. The `service` group is registered as a standalone `Command` instance (like
   `CompletionsCommand`) because Cliffy 1.2.1 does not attach subcommands chained off the command
   returned by `cli.command(name, description)`.
9. `health [--stacks ...] [--json]` evaluates deployed stacks through `checkStackHealth` from
   `src/docker/health.ts` using existing stack service/task JSON. It is read-only and
   command-driven: unhealthy stacks exit with `ExitCode.DriftOrValidation`, and it never schedules
   shutdowns or redeploys.

## Integration Points

- `config`: `initConfig()` creates `.stackctl` files. `resolveConfig()` loads active configuration
  for profile-aware commands. `ExitCode` supplies shared numeric exit semantics.
- `compose`: `generateStacks()` builds canonical stack YAML, `discoverComposeFiles()` discovers
  stack names, `syncValidation()` checks generated output against committed stack files,
  `reloadStacks()` performs config-first reloads, and `planOperation()` produces deterministic
  operation plans.
- `render`: `renderStack()` resolves `${VAR}` placeholders in generated Compose data and reports
  unresolved variables and warnings.
- `docker`: Docker wrapper functions perform Swarm and Compose operations through the injected
  runner, including stack deploy, removal, service listing, task listing, logs, service scaling,
  service shutdown (`src/docker/service.ts`), stack health evaluation (`src/docker/health.ts`),
  Compose config validation, Docker info, and Swarm status checks.
- `env`: Environment commands delegate discovery, creation, diffing, materialization, status
  listing, and audit behavior to `discoverEnvExamples()`, `batchCreateEnvs()`, `diffEnvFiles()`,
  `materializeEnvFromProfile()`, `getEnvStatusList()`, and `envDoctor()`.
- `secrets`: Secrets commands delegate SOPS and age workflows to `ensureTooling()`,
  `checkTooling()`, `findEncryptedEnvFiles()`, `encryptEnvFile()`, `decryptEnvFile()`,
  `cleanDecryptedEnvFiles()`, and `deployPipeline()`.
- `process`: `RealProcessRunner` is the runtime adapter for external process execution and dry-run
  behavior.
- Deno and standard library APIs provide filesystem writes, temporary files, directory creation,
  YAML parsing and serialization, path operations, prompts, and completion command support.

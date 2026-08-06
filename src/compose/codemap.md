# src/compose/

## Responsibility

`src/compose` owns Docker Compose source discovery, source loading, stack file generation,
Compose-specific merging, override application, Swarm compatibility transforms, named volume
declaration, reload orchestration, sync validation, and operation planning for compose-related
workflows. It converts per-service `docker-compose.yml` or `docker-compose.yaml` files tagged with
`x-stack` metadata into canonical stack YAML files under the configured stack directory, then feeds
those files into render and Docker deployment flows where applicable.

Core public entry points are:

- `discoverComposeFiles(options: DiscoverOptions): Promise<DiscoverResult>` in `discover.ts`.
- `loadCompose(path: string): Promise<LoadResult>` and `loadFragment(directory: string)` in
  `load.ts`.
- `generateStacks(options: GenerateOptions): Promise<GenerateResult>` in `generate.ts`.
- `composeDeepMerge(base, override)` in `merge.ts`.
- `composeOverrideMerge(base, override)`, `loadOverrideFile(path, repoRoot)`, and
  `applyOverrides(baseCompose, overrides, repoRoot)` in `override.ts`.
- `stripComposeOnlyKeys`, `applyLoggingDefaults`, `rewriteEnvFile`, and `rewriteBindMountPaths` in
  `transform.ts`.
- `collectAllNamedVolumes` and `collectNamedVolumes` in `volumes.ts`.
- `reloadStacks(options: ReloadOptions): Promise<ReloadResult[]>` in `reload.ts`.
- `sync(opts: SyncOptions): Promise<SyncResult>` in `sync.ts`.
- `planOperation(opts: PlanOptions): Promise<PlanResult>` in `plan.ts`.

## Design Patterns

- Pipeline orchestration: `generateStacks` composes discovery, loading, fragment merging, override
  merging, service transforms, named volume collection, and YAML serialization into one generation
  pipeline. `reloadStacks`, `sync`, and `planOperation` reuse that pipeline instead of duplicating
  low-level compose logic.
- Pure merge and transform helpers: `composeDeepMerge`, `composeOverrideMerge`,
  `stripComposeOnlyKeys`, `applyLoggingDefaults`, `rewriteEnvFile`, `rewriteBindMountPaths`,
  `collectNamedVolumes`, and `collectAllNamedVolumes` return new objects or arrays and avoid
  mutating their inputs.
- Separate merge semantics: `composeDeepMerge` is used for composing source files and
  `swarm.fragment.yml` sidecars, with arrays replaced. `composeOverrideMerge` models Docker Compose
  override semantics, with arrays appended.
- Metadata normalization boundary: `normalizeStackName` accepts legacy scalar `x-stack: name` and
  object form `x-stack: { name: value }`, rejects empty names, unknown object fields, and invalid
  shapes, and removes `x-stack` from loaded compose data via `loadCompose`.
- Safety modes: `GenerateOptions.dryRun`, `ReloadOptions.dryRun`, `ReloadOptions.skipUnchanged`, and
  planning dry runs are used to prevent writes or deployments when callers need previews or
  validation only.
- Typed result envelopes: workflows return structured result objects such as `GenerateResult`,
  `ReloadResult`, `SyncResult`, and `PlanResult`, with warnings and errors collected as data rather
  than thrown across the top-level operation boundary.
- Barrel exports: `mod.ts` re-exports compose types and most submodule APIs, plus `generateStacks`
  and the generation option/result types.

## Data & Control Flow

Discovery and loading:

1. `discoverComposeFiles` walks `DiscoverOptions.repoRoot` with `@std/fs/walk`, includes files only,
   skips hidden directories, and filters names to `docker-compose.yml` or `docker-compose.yaml`.
2. `DEFAULT_SKIP_DIRS` excludes `node_modules`, `stacks`, `tools`, `environments`, and
   `__pycache__`; `DiscoverOptions.skipDirs` extends that set. Config-aware callers pass
   `config.base.stack.skipDirectories` as `skipDirs` so project-level ignores apply to every
   discovery path (CLI `up`/`down`/`status`/`logs`/`health`/completions, `sync`, `plan`, and the
   secrets deploy pipeline). `GenerateOptions.skipDirs` forwards the same list into discovery during
   generation (`generate`/`render`/`up`/`reload`/`sync`/`plan`/`secrets deploy`).
3. Each candidate YAML file is parsed with `@std/yaml.parse`. Files without `x-stack` are ignored.
   Invalid YAML or invalid stack metadata are recorded in `DiscoverResult.errors`.
4. `normalizeStackName` converts the `x-stack` value to the grouping key, producing
   `DiscoverResult.stacks` as `Record<string, string[]>`.
5. `loadCompose` parses a selected compose file, validates `x-stack`, removes it from the returned
   `LoadResult.data`, and returns `LoadResult.stackName`.
6. `loadFragment` resolves `swarm.fragment.yml` in the compose directory, returns `{}` when absent,
   and parses it when present.

Generation, merging, overrides, transforms, and volume handling:

1. `generateStacks` discovers compose files, selects `GenerateOptions.stacks` or all discovered
   stack names, creates the output directory unless `dryRun` is enabled, and calls the internal
   `generateSingleStack` for each target.
2. `generateSingleStack` loads every compose source and its `swarm.fragment.yml` sidecar. For each
   source it merges compose data with the fragment through `composeDeepMerge`, then merges all
   sources together through `composeDeepMerge` again.
3. If `GenerateOptions.overrides` is present, `applyOverrides` resolves each string or
   `OverrideEntry`, loads it through `loadOverrideFile`, and applies entries left to right through
   `composeOverrideMerge`.
4. Service transforms run per service in this order: `stripComposeOnlyKeys` removes Swarm-invalid
   `container_name`, `restart`, and `build`; `applyLoggingDefaults` adds the local logging driver
   defaults when no logging block exists; `rewriteEnvFile` rewrites relative `env_file` entries to
   repo-root-relative paths; `rewriteBindMountPaths` rewrites relative bind mount sources to
   repo-root-relative paths.
5. `rewriteBindMountPaths` handles short-form volume strings by recognizing sources that start with
   `.`, `/`, or `~`, and handles long-form mounts by rewriting `source` when `type` is `bind` or
   absent. Long-form `type: volume` mounts are left unchanged.
6. `collectAllNamedVolumes` scans all transformed services and uses `collectNamedVolumes` to find
   named volumes. Short-form named volumes are sources that do not start with `.`, `/`, or `~`.
   Long-form named volumes require `type === "volume"` and a string `source`. The generated stack
   declares each deduplicated, sorted named volume as `{ external: true }`.
7. The output stack always declares the default network as external `traefik-public`, emits services
   when present, emits external named volumes when found, serializes with `@std/yaml.stringify`, and
   writes `<outputDir>/<stackName>.yml` unless `dryRun` is enabled.

Reload:

1. `reloadStacks` receives a pre-resolved `ResolvedConfig`, a `ProcessRunner`, and optional stack,
   override, dry run, log, checksum, and force-update flags.
2. It computes `repoRoot`, stack directory, render directory, and target stacks from config and
   options, then concatenates config overrides with CLI overrides.
3. Unless `skipGenerate` is true, it calls `generateStacks` with `dryRun: false` so the stack files
   exist for rendering.
4. For each stack it reads `<stacksDir>/<stackName>.yml`, parses YAML to `ComposeData`, calls
   `renderStack` with strict interpolation, serializes rendered YAML, and targets
   `<renderDir>/<stackName>.rendered.yml`.
5. When `skipUnchanged` is true, `computeSha256` and `unchangedCheck` compare the new rendered
   content to the previous rendered file. Matching stacks return `unchanged` or `would-skip`.
6. Non-dry runs write the rendered file and call `dockerStackDeploy` with `prune: false` and
   `resolveImage: "always"`. Dry runs return `would-deploy`.
7. If enabled, `forceServiceUpdate` lists services through `dockerStackServices`, parses JSON lines,
   and calls `dockerServiceUpdate` with `{ force: true }`. `followLogs` uses `dockerServiceLogs` for
   deployed stack services on a best-effort basis.

Sync:

1. `sync` resolves config through `resolveConfig`, discovers compose files, and selects requested
   stacks or discovered stacks.
2. It calls `generateStacks` with `dryRun: true`, then compares each generated YAML string against
   the canonical `<stacksDir>/<stackName>.yml` file.
3. Differences set `SyncResult.match` to false and populate `SyncResult.diffs` with a lightweight
   textual diff from `generateDiff`, built using `lcsFn`. Sync never renders and never deploys.

Planning:

1. `planOperation` resolves config, creates `PlanResult` and stable `PlanJsonOutput`, and always
   reports configuration and compose discovery sections.
2. `planComposeDiscovery` uses `discoverComposeFiles` to show discovered stack files and missing
   requested stacks. `planOverrides` lists explicit override paths.
3. For `up`, `sync`, `generate`, `reload`, and `all`, `planGeneration` calls `generateStacks` with
   `dryRun: true` and lists stack files that would be generated.
4. For `up`, `sync`, `render`, `reload`, and `all`, `planRender` parses generated YAML, calls
   `renderStack`, counts interpolation sources from environment values and `env_file`, and reports
   rendered output paths.
5. `planDockerCommands` produces non-executed Docker command strings for `up`, `sync`, `down`,
   `reload`, and `all`.
6. `planEnv` and `planSecrets` add environment and secrets sections for relevant operations.
   `planSecrets` only discovers encrypted inputs and cleanup actions; it does not decrypt files.

## Integration Points

- Config: `sync` and `planOperation` call `resolveConfig` from `src/config/load.ts`. `reloadStacks`
  accepts a `ResolvedConfig` from the CLI layer. `GenerateOptions.overrides`,
  `ReloadOptions.overrides`, and `PlanOptions.overrides` use `OverrideEntry` from
  `src/config/types.ts`.
- Render: `reloadStacks` and `planRender` call `renderStack` from `src/render/mod.ts` to interpolate
  `${VAR}` placeholders after stack generation.
- Docker: `reloadStacks` calls `dockerStackDeploy`, `dockerStackServices`, `dockerServiceUpdate`,
  and `dockerServiceLogs` from `src/docker/mod.ts` through a `ProcessRunner` abstraction.
- Process: Docker commands run through `ProcessRunner` from `src/process/types.ts`, including
  `runner.withDryRun(true)` for dry-run reload behavior.
- Env: `planEnv` dynamically imports `discoverEnvExamples` from `src/env/mod.ts` when planning `env`
  or `all` operations.
- Secrets: `planSecrets` dynamically imports `findEncryptedEnvFiles` from `src/secrets/mod.ts` and
  intentionally limits itself to discovery and cleanup planning.
- Standard library: modules use `@std/yaml` for parsing and serialization, `@std/path` for path
  resolution and joining, `@std/fs` for walking, existence checks, and output directory creation,
  and Deno file APIs for reading and writing YAML files.

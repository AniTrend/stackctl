# src/env/

## Responsibility

`src/env/` owns environment file lifecycle helpers for stack projects. It discovers `.env.example`
and `.env.example.<profile>` files, scaffolds `.env` files, materializes profile presets into root
`.env` targets, compares env keys, lists env status, and audits plaintext `.env` files that have or
lack encrypted `.env.enc` counterparts.

Public entry points in `mod.ts` are `discoverEnvExamples`, `createEnvFromExample`, `diffEnvFiles`,
`batchCreateEnvs`, `getEnvStatusList`, `materializeEnvFromProfile`, and `envDoctor`. Public data
contracts live in `types.ts`.

## Design Patterns

- File discovery uses `@std/fs` `walk` and narrows results with deterministic filters:
  `DEFAULT_SKIP_DIRS`, `hasSkipAncestor`, `isInHiddenDir`, and `matchesPaths`.
- Env parsing is key focused. `parseEnvKeys` reads `.env` style files, ignores blank lines and
  comments, strips an optional `export` prefix, and returns keys before `=` without exposing values.
- Operations are option driven. `DiscoverOptions`, `CreateOptions`, `MaterializeOptions`, and
  `DoctorOptions` configure profile selection, scoped paths, overwrite behavior, dry runs, and
  remediation suggestions.
- Write operations are conservative. `createEnvFromExample` and `materializeEnvFromProfile` skip
  existing targets unless `force` is set, and `backupEnvBeforeOverwrite` creates timestamped
  `.bak.<timestamp>` files before overwriting.
- Batch functions accumulate structured results instead of failing the whole operation on item
  errors. `BatchCreateResult`, `MaterializeResult`, and `DoctorResult` separate successes, skips,
  errors, findings, and warning state.

## Data & Control Flow

1. Discovery starts with `discoverEnvExamples(projectDir, options)`. It selects the expected example
   suffix from `options.profile`, walks the project tree, excludes skipped and hidden directories,
   applies `paths` filters, derives `serviceName` with `deriveServiceName`, and computes `status` by
   comparing keys from the example file and corresponding env file.
2. Scaffolding uses `batchCreateEnvs(projectDir, options)` for project wide creation. It calls
   `discoverEnvExamples`, optionally filters by `serviceName`, then delegates each item to
   `createEnvFromExample`. The single file helper validates the example, refuses existing env files
   unless forced, supports `dryRun`, backs up overwritten env files, and copies text content.
3. Profile materialization uses `materializeEnvFromProfile(projectDir, options)`. It requires
   `options.profile`, finds `.env.example.<profile>` files, applies the same directory and path
   filters, and writes each matching file to `.env` in the same directory. Existing targets are
   skipped unless `force` is set.
4. Diffing uses `diffEnvFiles(examplePath, envPath, serviceName)`. It parses keys from files that
   exist, wraps parse failures with file specific errors, and returns `EnvDiff` arrays for
   `onlyInExample`, `onlyInEnv`, and `common`.
5. Status listing uses `getEnvStatusList(projectDir, options)`. It includes base examples from
   `discoverEnvExamples`, adds profile variants when no profile filter is set, checks for `.env` and
   `.env.enc`, and returns sorted `EnvStatusEntry` records.
6. Audit uses `envDoctor(projectDir, options)`. It walks plaintext `.env` files, applies scope
   filters, checks for adjacent `.env.enc`, and emits `DoctorFinding` entries. A plaintext file with
   encrypted counterpart is a `warning`; a plaintext file without encrypted counterpart is `info`.
   `hasWarnings` is derived from warning findings.

## Integration Points

- CLI commands import these helpers through `src/env/mod.ts` to implement env list, create,
  materialize, diff, and doctor workflows.
- The secrets subsystem is coupled by convention through adjacent `.env.enc` detection in
  `getEnvStatusList` and `envDoctor`, and by remediation messages that reference
  `stackctl secrets encrypt` and `stackctl secrets clean`.
- The compose and configuration workflows consume the resulting `.env` files indirectly as project
  artifacts. This module does not parse values or render compose content.
- All filesystem side effects use Deno APIs, specifically `Deno.readTextFile` and
  `Deno.writeTextFile`, with standard path helpers from `@std/path`.

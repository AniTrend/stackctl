# src/render/

## Responsibility

`src/render` owns Docker Compose interpolation for stack data after compose generation and override
merging, before deployment output is written or applied. Its main entry point is
`renderStack(options: RenderOptions)`, which accepts parsed `ComposeData`, builds per-service
variable scopes, substitutes environment references inside service definitions, rewrites relative
paths to absolute paths, and returns a `RenderResult` with rendered data plus warnings.

The module handles these rendering responsibilities:

- Parse simple dotenv files through `parseEnvFile(path)`.
- Resolve `env_file` references through `resolveEnvPath(relPath, projectDir, repoRoot)`.
- Normalize `service.environment` through `coerceEnvironmentToDict(env)`.
- Build service-specific interpolation scopes through
  `buildServiceScope(service, baseEnv,
  projectDir, repoRoot)`.
- Substitute `${VAR}`, `${VAR-default}`, `${VAR:-default}`, and `$VAR` forms through
  `substitute(s, vars)`.
- Recursively interpolate nested compose structures through `deepInterpolate(obj, vars)`.
- Convert relative service `env_file` and bind mount sources through
  `absolutizeServicePaths(service,
  projectDir, repoRoot)`.

## Design Patterns

- Functional pipeline: `renderStack` composes smaller pure or mostly pure helpers in a fixed order,
  from scope construction to interpolation to path normalization.
- Non-mutating transforms: `renderStack` shallow-clones `ComposeData`, creates a new `services` map,
  and `absolutizeServicePaths` returns a copied `ServiceDef` instead of mutating the input service.
- Layered configuration scope: `buildServiceScope` applies shell environment first, then service
  `env_file` values in declaration order, then `service.environment` with highest priority.
- Recursive structural traversal: `deepInterpolate` preserves scalar types and only transforms
  string leaves while walking arrays and plain object entries.
- Regex-driven parsing: `INTERP_RE`, `PLAIN_VAR_RE`, `UNRESOLVED_RE`, and `REL_PATH_RE` centralize
  interpolation matching, strict-mode detection, and relative path classification.
- Warning accumulation: `renderStack` records missing `env_file` references and unresolved variables
  in `RenderResult.warnings` rather than throwing for ordinary render issues. Strict mode annotates
  `RenderResult.hasUnresolved` when service values still contain `${VAR}` patterns.

## Data & Control Flow

1. Callers pass `RenderOptions` to `renderStack`, including parsed `ComposeData`, `projectDir`,
   `repoRoot`, and optional `strict`.
2. `renderStack` reads the shell environment with `Deno.env.toObject()` and shallow-clones the input
   compose data.
3. For each service in `data.services`, `renderStack` calls `buildServiceScope`.
4. `buildServiceScope` starts with the shell environment, resolves each service `env_file` with
   `resolveEnvPath`, parses readable files with `parseEnvFile`, and overlays values from
   `coerceEnvironmentToDict(service.environment)`.
5. `renderStack` independently checks declared `env_file` paths with `Deno.stat` and appends
   warnings for missing files.
6. `deepInterpolate` walks the service definition and calls `substitute` for each string value.
7. `substitute` first processes braced expressions with `INTERP_RE`, then plain `$VAR` expressions
   with `PLAIN_VAR_RE`. Unresolved variables remain unchanged unless a default expression provides a
   replacement.
8. `absolutizeServicePaths` normalizes the interpolated service. It delegates env file paths to the
   private `absolutizePath`, short-form volume strings to `absolutizeBindMountString`, long-form
   volume objects to `absolutizeVolumeMount`, and relative path construction to `resolvePath`.
9. After service processing, `renderStack` interpolates non-service top-level compose keys with only
   the shell environment as scope.
10. `renderStack` scans rendered service JSON for unresolved `${VAR}` patterns. In strict mode it
    sets `hasUnresolved` and records strict warnings. In non-strict mode it records warnings while
    leaving values unchanged.
11. The function returns `RenderResult` containing the rendered `ComposeData`, warnings, and
    optional strict-mode unresolved status.

## Integration Points

- `src/compose/types.ts`: Supplies `ComposeData`, `ServiceDef`, and `VolumeMount` type contracts
  used by all render operations.
- CLI render and deploy flows: Call `renderStack` after compose generation and override merging,
  then consume `RenderResult.data` for YAML output, deployment, or downstream validation.
- Environment files: `parseEnvFile`, `resolveEnvPath`, and `buildServiceScope` read service-level
  dotenv files declared by Compose `env_file` fields.
- Host process environment: `renderStack` uses `Deno.env.toObject()` as the base scope for services
  and as the only scope for top-level non-service compose keys.
- Filesystem: `resolveEnvPath`, `parseEnvFile`, and `renderStack` use Deno filesystem APIs to
  resolve, read, and validate env file paths.
- Docker Compose path semantics: `absolutizeServicePaths` preserves named volumes and absolute paths
  while converting relative `env_file` and bind mount sources so rendered YAML remains stable when
  executed from a different output directory.

# src/config/

## Responsibility

The config module owns stackctl configuration shape, default values, file discovery, YAML loading,
layer merging, validation, initial file generation, and the public export surface for configuration
APIs. It converts `.stackctl` files and optional profile or local overlays into a validated
`ResolvedConfig` whose `base` property contains the final `StackctlConfig` consumed by the rest of
the application.

Core files:

- `types.ts`: Defines `StackctlConfig`, nested config interfaces, `ProfileConfig`, `OverrideEntry`,
  `ResolvedConfig`, and shared `ExitCode` constants.
- `defaults.ts`: Provides `DEFAULT_CONFIG`, the base layer for resolution.
- `merge.ts`: Provides generic deep merge helpers used to combine config layers.
- `validate.ts`: Validates required and optional config fields and returns all validation errors.
- `load.ts`: Discovers config files, loads YAML, applies merge order, validates the result, and
  returns `ResolvedConfig`.
- `init.ts`: Generates `.stackctl` and optional `.stackctl.<profile>` templates, with preset,
  detection, force, and dry run support.
- `mod.ts`: Re-exports the public config module API.

## Design Patterns

- Layered configuration: `resolveConfig` starts from `DEFAULT_CONFIG` and applies discovered or
  explicit files in a fixed order.
- Partial overlays: `ProfileConfig` is `Partial<StackctlConfig>`, so profile, local, and explicit
  file content can override only selected fields.
- Immutable merge return values: `mergeConfig` copies the base object into a new record and returns
  a merged object instead of mutating the input object directly.
- Recursive object merge: Plain records are merged field by field when both base and overlay values
  are records.
- Replacement semantics for non-record values: Arrays, primitives, and `null` replace the existing
  value. `undefined` overlay values are skipped and do not overwrite the base.
- Aggregate validation: `validateConfig` collects all field errors before returning, allowing
  callers to report a complete validation failure set.
- Sidecar discovery: Profile and local files are discovered relative to the base `.stackctl` file,
  whether the base was found by walking up the directory tree or supplied through `configPath`.
- Template based initialization: `initConfig` writes static YAML templates, optionally modified by
  compose file detection.

## Data & Control Flow

Configuration resolution in `load.ts` proceeds as follows:

1. `resolveConfig` chooses the active profile from `ResolveOptions.profile` or the
   `STACKCTL_PROFILE` environment variable.
2. If `ResolveOptions.configPath` is supplied, it is converted to an absolute path relative to the
   current working directory when needed. Otherwise `discoverConfigFiles` walks upward from `cwd` to
   find `.stackctl`.
3. Discovery determines `repoRoot` by searching upward for `.git`, falling back to the directory
   containing `.stackctl`.
4. Sidecar files are checked in the base config directory: `.stackctl.<profile>`, `.stackctl.local`,
   and `.stackctl.local.<profile>`.
5. The final config starts as a shallow copy of `DEFAULT_CONFIG`.
6. Existing layers are merged left to right in this order:
   - `DEFAULT_CONFIG`
   - `.stackctl`
   - `.stackctl.<profile>`
   - `.stackctl.local`
   - `.stackctl.local.<profile>`
7. Each file is read by `loadConfigFile`, parsed with `@std/yaml`, and merged with `mergeConfig`.
8. `validateConfig` checks the merged result. Validation errors are formatted into one thrown
   `Error` from `resolveConfig`.
9. A `ResolvedConfig` is returned with the merged `base`, active profile name, loaded overlay
   objects, discovered paths, and an empty `overrides` array.

Single file loading uses `loadConfig`, which delegates to the YAML loader and returns a partial
config without defaults, sidecar discovery, merging, or validation.

Initialization in `init.ts` proceeds as follows:

1. `initConfig` selects the `standard` template by default or a configured preset from `PRESETS`.
2. Unknown presets return an `InitResult` containing an error and no file writes.
3. With `detect`, `applyDetection` scans the first level of `cwd` for compose file names, parses
   YAML, extracts service names for `stack.names`, extracts a non-default network name for
   `stack.network`, and derives `project` from the directory basename.
4. `writeConfigFile` writes `.stackctl`, unless it already exists and `force` is not set.
5. If `profile` is set, `writeConfigFile` also writes `.stackctl.<profile>`.
6. In `dryRun` mode, paths are added to `InitResult.written` without writing files.

## Integration Points

- Deno runtime APIs: Uses `Deno.cwd`, `Deno.env.get`, `Deno.readTextFile`, `Deno.writeTextFile`, and
  `Deno.readDir` for filesystem and environment access.
- Standard library dependencies: Uses `@std/fs/exists`, `@std/yaml/parse`, and `@std/path` helpers
  for path handling and YAML parsing.
- CLI integration: `mod.ts` exports config loading, validation, merge utilities, types, defaults,
  and init APIs for command handlers.
- Compose integration: Initialization detection reads compose YAML files to seed project, stack
  name, and network values, but it does not use compose module abstractions directly.
- Downstream modules consume `StackctlConfig` fields such as stack directory, stack names, network,
  render output directory, environment file options, secrets settings, and command defaults after
  `resolveConfig` validates the merged configuration.

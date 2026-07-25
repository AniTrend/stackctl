# stackctl Codemap

## Responsibility

`stackctl` is a Deno 2.x command line application for repository aware Docker Swarm stack control.
`src/main.ts` is the executable entry point. It delegates all command processing to `src/cli/mod.ts`
and exits with the numeric status returned by that module. `src/version.ts` provides the canonical
CLI version string for runtime use and release automation.

## Design Patterns

- Thin bootstrapper, `src/main.ts` contains process startup only and keeps command behavior inside
  the CLI module.
- Explicit entry point guard, `import.meta.main` prevents process execution when the module is
  imported.
- Centralized version constant, `VERSION` avoids duplicated version literals in source.
- Capability constrained runtime, the shebang declares Deno permissions for file IO, environment
  reads, host inspection, and selected external tools.

## Data & Control Flow

1. Deno starts `src/main.ts` with the permissions declared in the shebang or compiled binary
   metadata.
2. `src/main.ts` imports `main` from `src/cli/mod.ts`.
3. When executed directly, `Deno.args` is passed to `main`.
4. The CLI module resolves commands, performs repository and Docker Swarm operations, and returns an
   exit code.
5. `Deno.exit` terminates the process with that code.
6. Consumers that need the release identifier import `VERSION` from `src/version.ts`.

## Integration Points

- Runtime, Deno 2.x with JSR imports configured in `deno.json`.
- Package entry, `deno.json` exports `./src/main.ts` as `@anitrend/stackctl`.
- CLI implementation, `src/cli/mod.ts` receives argument vectors and owns command dispatch.
- External tools, Deno run permissions allow `git`, `docker`, `docker-compose`, `sops`, `age`,
  `age-keygen`, `shred`, and `rm`.
- Release metadata, `deno.json` version and `src/version.ts` `VERSION` must stay in sync during
  version updates.

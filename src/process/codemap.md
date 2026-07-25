# src/process/

## Responsibility

`src/process` defines the process execution boundary for stackctl. It centralizes all external
command invocation behind the `ProcessRunner` interface so Docker, SOPS, age, git, and other system
tools can be executed through one typed abstraction. The module supports real execution, dry-run
behavior, command availability checks, captured output, streamed output callbacks, and test
replacement through fake runners.

## Design Patterns

- **Port and adapter:** `ProcessRunner` is the port used by application code. `RealProcessRunner` is
  the Deno-backed adapter that calls `Deno.Command`.
- **Dependency inversion:** callers depend on `ProcessRunner` instead of `Deno.Command` directly,
  which allows tests to inject fakes and avoids real external process execution in unit tests.
- **Immutable mode switching:** `withDryRun(dryRun)` returns a new `ProcessRunner` instance with the
  requested dry-run mode rather than mutating the current runner.
- **Result object:** every command returns a `ProcessResult` containing `stdout`, `stderr`, `code`,
  `success`, and the original `command` array for diagnostics.
- **Callback-based streaming:** `stream()` accumulates full output while also emitting complete
  stdout and stderr lines to optional handlers.

## Data & Control Flow

1. A caller passes a command as `string[]`, where the first element is the executable and remaining
   elements are arguments.
2. Empty command arrays short-circuit with `code: 1`, `success: false`, empty output, and the
   original command.
3. In dry-run mode, `run()` and `stream()` print the intended command, skip OS execution, and return
   `code: 0` with `success: true`.
4. In capture mode, `run()` creates `Deno.Command` with piped stdout and stderr, optional `cwd`, and
   optional `env`. It awaits `command.output()`, decodes both byte streams with `TextDecoder`, and
   returns the Deno status code and success flag.
5. In streaming mode, `stream()` spawns the command, registers SIGINT and SIGTERM handlers, drains
   stdout and stderr streams, awaits child status, then removes signal handlers in `finally`.
6. `drainStream()` reads `ReadableStream<Uint8Array>` chunks, decodes them incrementally, preserves
   partial line buffers, emits only complete lines to callbacks, flushes the final residual line,
   releases the reader lock, and returns the full decoded text.
7. `which(name)` invokes the platform `which` command with null stdout and stderr, returning `true`
   when the lookup exits successfully and `false` on failure or exception.

Exit code semantics are normalized through `ProcessResult`: `code` is the process exit code and
`success` mirrors Deno's success flag, effectively successful when the exit code is `0`. Internal
runner errors and invalid empty commands are represented as `code: 1` with `success: false`. Dry-run
commands report success with `code: 0` because no external command is executed.

`RunOptions.timeout` and `timeoutSignal` are part of the public type contract, but the current
`RealProcessRunner` implementation does not apply timeout cancellation.

## Integration Points

- `src/docker` uses the process abstraction to call Docker and Docker Swarm commands.
- `src/secrets` uses the abstraction for SOPS, age, age-keygen, shred, and rm integrations.
- CLI commands can create a real runner and toggle dry-run behavior while keeping downstream code
  independent from Deno process APIs.
- `src/testing` provides fake implementations for unit tests, enabling deterministic command
  responses and verification of expected invocations.
- `src/main.ts` and release build settings must grant Deno permissions for external commands that
  flow through this abstraction.

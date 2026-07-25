# src/testing codemap

## Responsibility

`src/testing` provides the in-memory process execution test harness for stackctl modules that depend
on the `ProcessRunner` interface. The harness replaces real external command execution with
configured `ProcessResult` responses, records every command invocation, supports dry-run
propagation, and exposes assertion helpers for command-oriented unit tests. `mod.ts` is the public
barrel export for these testing utilities.

## Design Patterns

- Interface substitution: `FakeProcessRunner` implements `ProcessRunner`, allowing production
  modules to receive a deterministic test double through the same dependency boundary.
- Builder pattern: `FakeProcessRunnerBuilder` accumulates command response fixtures and produces
  configured runner instances.
- Fixture factory functions: `successResult` and `failureResult` construct canonical `ProcessResult`
  values for test setup.
- Fail-fast verification: unknown command invocations throw immediately, which forces tests to
  declare the complete expected external command surface.
- Immutable observation: the `commands` getter returns a copy of recorded invocations to preserve
  runner state integrity.

## Data & Control Flow

1. A test creates `CommandResponse` fixtures directly, through `FakeProcessRunnerBuilder`, or with
   helper factories for result payloads.
2. The unit under test receives `FakeProcessRunner` as a `ProcessRunner` dependency.
3. Calls to `run`, `stream`, or `which` are recorded in order as command argument arrays.
4. `run` and `stream` resolve responses through prefix or exact command matching, then return a
   `ProcessResult` whose `command` field reflects the actual invocation.
5. `which` records a synthetic `which <name>` command and resolves to the configured success state,
   defaulting to `false` when no response matches.
6. Assertion code inspects `recorded`, `commands`, or `containsCommand` to verify command routing
   and argument construction.
7. `withDryRun` returns a new fake runner with the same response table and the requested dry-run
   flag.

## Integration Points

- `../process/types.ts`: supplies `ProcessRunner`, `ProcessResult`, `RunOptions`, and
  `StreamOptions`, which define the production contract implemented by the fake harness.
- Command wrapper modules: docker, secrets, compose, env, and other modules can inject the fake
  runner to test external command orchestration without invoking Docker, sops, age, or shell tools.
- Public testing import path: `src/testing/mod.ts` re-exports `fakes.ts` so tests can import the
  harness through the testing module boundary.

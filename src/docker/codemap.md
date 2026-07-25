# src/docker/

## Responsibility

`src/docker` is the Docker CLI adapter layer for stackctl. It provides small typed wrappers around
Docker, Docker Compose, and Docker Swarm commands so higher level modules do not build or execute
Docker command lines directly.

The module is responsible for:

- Deploying a Swarm stack with `docker stack deploy`.
- Removing a Swarm stack with `docker stack rm`.
- Listing stack services and tasks with JSON formatted `docker stack services` and `docker stack ps`
  output.
- Streaming service logs through `docker service logs`.
- Updating a Swarm service through `docker service update`.
- Reading Docker daemon information with `docker info`.
- Deriving Swarm activation status from `docker info` JSON output.
- Normalizing Compose configuration with `docker compose -f <file> config`.

## Design Patterns

- **ProcessRunner boundary**: Every external command is executed through the injected
  `ProcessRunner`. This keeps the module deterministic in tests and prevents direct process spawning
  from Docker wrappers.
- **Thin command wrappers**: Each exported function maps one Docker CLI operation to a
  `Promise<ProcessResult>` or a parsed status object. The wrappers do not own business rules beyond
  command assembly and minimal result parsing.
- **Typed option objects**: Optional CLI flags are represented by narrow interfaces such as
  `DockerDeployOptions`, `DockerLogsOptions`, and `DockerServiceUpdateOptions`.
- **Argument vector construction**: Commands are constructed as string arrays, not shell strings.
  This avoids shell interpolation and keeps command arguments explicit. Optional flags are appended
  conditionally before positional arguments such as stack names, service names, and compose file
  paths.
- **JSON output contract**: Commands that need machine readable output include `--format {{json .}}`
  where Docker supports it. `dockerSwarmStatus` parses the JSON produced by `docker info` and
  converts it into a small domain specific result.

## Data & Control Flow

1. A caller passes a `ProcessRunner`, required identifiers such as `stackName`, `serviceName`, or
   `composeFile`, and optional typed settings.
2. The wrapper creates a command vector beginning with `docker` and the relevant subcommands.
3. Optional settings add flags in Docker CLI order. Examples include `--prune`, `--detach`,
   `--resolve-image`, `--force`, `--image`, `--tail`, `--since`, and `--timestamps`.
4. Positional arguments are appended last, for example the stack name or service name.
5. Most functions call `runner.run(cmd)` and return the resulting `ProcessResult` unchanged.
6. `dockerServiceLogs` calls `runner.stream(cmd)` because log following is a streaming operation.
   The `--follow` flag is enabled by default and omitted only when `follow` is explicitly `false`.
7. `dockerSwarmStatus` calls `docker info --format {{json .}}`, checks command success, parses
   `stdout` as JSON, reads `Swarm.LocalNodeState`, and returns `{ active: true, nodeId }` only when
   the local node state is `active`. Failed commands, invalid JSON, or inactive states return
   `{ active: false }`.

## Integration Points

- `src/process`: Supplies `ProcessRunner` and `ProcessResult`. Production code uses the real runner,
  while tests can inject fakes.
- `src/compose`: Produces compose files and rendered stack definitions that are later passed into
  Docker wrappers such as `dockerStackDeploy` and `dockerComposeConfig`.
- `src/cli`: Orchestrates user facing commands and delegates Docker operations to this module
  instead of invoking Docker directly.
- Docker CLI and Docker Swarm: The wrappers assume the `docker` executable is available in the
  runtime environment and preserve Docker's stdout, stderr, success state, and exit code through
  `ProcessResult` unless a function explicitly parses the output.

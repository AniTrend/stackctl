/**
 * Docker CLI integration module.
 *
 * All Docker commands go through ProcessRunner for testability.
 * Each function takes (runner: ProcessRunner) and returns structured results.
 */
import type { ProcessResult, ProcessRunner } from "../process/types.ts";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface DockerDeployOptions {
  /** Prune services that are no longer referenced. */
  prune?: boolean;
  /** Exit immediately without waiting for services to converge. */
  detach?: boolean;
  /** Override image resolution policy (always, changed, never). */
  resolveImage?: string;
}

export interface DockerLogsOptions {
  /** Follow log output. When undefined, defaults to true. */
  follow?: boolean;
  /** Number of lines to show from the end. */
  tail?: number;
  /** Show logs since timestamp. */
  since?: string;
  /** Show timestamps. */
  timestamps?: boolean;
}

export interface DockerServiceUpdateOptions {
  /** Force update even if no changes are detected. */
  force?: boolean;
  /** Image to update to. */
  image?: string;
}

// ---------------------------------------------------------------------------
// Docker CLI command wrappers
// ---------------------------------------------------------------------------

/**
 * Deploy a stack to Docker Swarm.
 *
 * Equivalent to: `docker stack deploy --compose-file <file> <stackName>`
 */
export function dockerStackDeploy(
  runner: ProcessRunner,
  stackName: string,
  composeFile: string,
  opts?: DockerDeployOptions,
): Promise<ProcessResult> {
  const cmd = ["docker", "stack", "deploy"];
  cmd.push("--compose-file", composeFile);
  if (opts?.prune) cmd.push("--prune");
  if (opts?.detach) cmd.push("--detach");
  if (opts?.resolveImage) cmd.push("--resolve-image", opts.resolveImage);
  cmd.push(stackName);
  return runner.run(cmd);
}

/**
 * Remove a stack from Docker Swarm.
 *
 * Equivalent to: `docker stack rm <stackName>`
 */
export function dockerStackRm(
  runner: ProcessRunner,
  stackName: string,
): Promise<ProcessResult> {
  return runner.run(["docker", "stack", "rm", stackName]);
}

/**
 * List services in a stack (JSON format for machine parsing).
 *
 * Equivalent to: `docker stack services --format '{{json .}}' <stackName>`
 */
export function dockerStackServices(
  runner: ProcessRunner,
  stackName: string,
): Promise<ProcessResult> {
  return runner.run([
    "docker",
    "stack",
    "services",
    "--format",
    "{{json .}}",
    stackName,
  ]);
}

/**
 * List tasks in a stack (JSON format for machine parsing).
 *
 * Equivalent to: `docker stack ps --format '{{json .}}' <stackName>`
 */
export function dockerStackPs(
  runner: ProcessRunner,
  stackName: string,
): Promise<ProcessResult> {
  return runner.run([
    "docker",
    "stack",
    "ps",
    "--format",
    "{{json .}}",
    stackName,
  ]);
}

/**
 * Stream service logs.
 *
 * Equivalent to: `docker service logs --follow --tail <n> <serviceName>`
 *
 * Returns ProcessResult with stdout containing captured log output.
 * Use ProcessRunner.stream() callbacks for real-time output.
 */
export function dockerServiceLogs(
  runner: ProcessRunner,
  serviceName: string,
  opts?: DockerLogsOptions,
): Promise<ProcessResult> {
  const cmd = ["docker", "service", "logs"];
  if (opts?.follow !== false) cmd.push("--follow");
  if (opts?.tail !== undefined) cmd.push("--tail", String(opts.tail));
  if (opts?.since) cmd.push("--since", opts.since);
  if (opts?.timestamps) cmd.push("--timestamps");
  cmd.push(serviceName);
  return runner.stream(cmd);
}

/**
 * Force a rolling update of a Docker service.
 *
 * Equivalent to: `docker service update --force <serviceName>`
 *
 * Used by `reload --force-service-update` to force a rolling restart
 * even when the service definition hasn't changed.
 */
export function dockerServiceUpdate(
  runner: ProcessRunner,
  serviceName: string,
  opts?: DockerServiceUpdateOptions,
): Promise<ProcessResult> {
  const cmd = ["docker", "service", "update"];
  if (opts?.force) cmd.push("--force");
  if (opts?.image) cmd.push("--image", opts.image);
  cmd.push(serviceName);
  return runner.run(cmd);
}

/**
 * Get Docker system information (JSON format).
 *
 * Equivalent to: `docker info --format '{{json .}}'`
 */
export function dockerInfo(runner: ProcessRunner): Promise<ProcessResult> {
  return runner.run(["docker", "info", "--format", "{{json .}}"]);
}

/**
 * Check whether Docker Swarm mode is active.
 *
 * Parses docker info output for Swarm state.
 */
export async function dockerSwarmStatus(
  runner: ProcessRunner,
): Promise<{ active: boolean; nodeId?: string }> {
  const result = await runner.run([
    "docker",
    "info",
    "--format",
    "{{json .}}",
  ]);

  if (!result.success) return { active: false };

  try {
    const info = JSON.parse(result.stdout) as Record<string, unknown>;
    const swarm = info?.Swarm as Record<string, unknown> | undefined;
    if (swarm?.LocalNodeState === "active") {
      return { active: true, nodeId: swarm.NodeID as string | undefined };
    }
    return { active: false };
  } catch {
    return { active: false };
  }
}

/**
 * Validate a Docker Compose file by running `docker compose config`.
 *
 * Equivalent to: `docker compose -f <file> config`
 * Returns success (true) if the compose file is valid YAML parsable by Docker.
 */
export async function dockerComposeConfig(
  runner: ProcessRunner,
  composeFile: string,
): Promise<ProcessResult> {
  return runner.run(["docker", "compose", "-f", composeFile, "config"]);
}

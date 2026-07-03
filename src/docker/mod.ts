/**
 * Docker CLI integration module.
 *
 * All Docker commands go through ProcessRunner for testability.
 */
import type { ProcessResult, ProcessRunner } from "../process/types.ts";

export interface DockerDeployOptions {
  prune?: boolean;
  detach?: boolean;
  resolveImage?: string;
}

export interface DockerLogsOptions {
  follow?: boolean;
  tail?: number;
  since?: string;
  timestamps?: boolean;
}

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

export function dockerStackRm(runner: ProcessRunner, stackName: string): Promise<ProcessResult> {
  return runner.run(["docker", "stack", "rm", stackName]);
}

export function dockerStackServices(
  runner: ProcessRunner,
  stackName: string,
): Promise<ProcessResult> {
  return runner.run(["docker", "stack", "services", "--format", "{{json .}}", stackName]);
}

export function dockerStackPs(runner: ProcessRunner, stackName: string): Promise<ProcessResult> {
  return runner.run(["docker", "stack", "ps", "--format", "{{json .}}", stackName]);
}

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

export function dockerInfo(runner: ProcessRunner): Promise<ProcessResult> {
  return runner.run(["docker", "info", "--format", "{{json .}}"]);
}

export async function dockerSwarmStatus(
  runner: ProcessRunner,
): Promise<{ active: boolean; nodeId?: string }> {
  const result = await runner.run(["docker", "info", "--format", "{{json .}}"]);
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

export function dockerComposeConfig(
  runner: ProcessRunner,
  composeFile: string,
): Promise<ProcessResult> {
  return runner.run(["docker", "compose", "-f", composeFile, "config"]);
}

/**
 * Deployed stack health evaluation.
 *
 * Evaluates Swarm stacks from the JSON output of the existing
 * `docker stack services` and `docker stack ps` wrappers. A service is
 * unhealthy when its parsed replica counts do not match (running !==
 * desired, including running above desired) or when any of its tasks is
 * in a failed or rejected current state.
 *
 * Evaluation fails closed: malformed service/task JSON lines and
 * unparseable `Replicas` values are recorded in `HealthCheckResult.errors`
 * and mark the affected stack and overall result unhealthy, so callers
 * exit nonzero instead of silently skipping data.
 *
 * This module is read-only and command-driven: it never mutates Swarm
 * state and never schedules shutdowns or redeploys.
 */
import type { ProcessRunner } from "../process/types.ts";
import { dockerStackPs, dockerStackServices } from "./mod.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailedTask {
  /** Full task name, e.g. "traefik_web.1". */
  name: string;
  /** Current state reported by Docker, e.g. "Failed 3 minutes ago". */
  state: string;
  /** Docker-reported error detail, when present. */
  error?: string;
}

export interface ServiceHealth {
  /** Full Swarm service name, e.g. "traefik_web". */
  name: string;
  /** Desired replica count parsed from the Replicas field. */
  desired: number;
  /** Running replica count parsed from the Replicas field. */
  running: number;
  /** True when the running count differs from the desired count. */
  replicaMismatch: boolean;
  /** Tasks whose current state is Failed or Rejected. */
  failedTasks: FailedTask[];
  /** True when the service is unhealthy (mismatch, failed tasks, or unparseable replicas). */
  unhealthy: boolean;
  /** Human-readable reasons for the reported health state. */
  reasons: string[];
}

export interface StackHealth {
  /** Stack name that was queried. */
  stack: string;
  /** Evaluated services for the stack. */
  services: ServiceHealth[];
  /** True when any service in the stack is unhealthy. */
  unhealthy: boolean;
}

export interface HealthCheckOptions {
  /** Process runner for the read-only Docker commands. */
  runner: ProcessRunner;
  /** Stack names to evaluate. */
  stacks: string[];
}

export interface HealthCheckResult {
  /** Per-stack evaluation results. */
  stacks: StackHealth[];
  /** True when any evaluated stack is unhealthy or a query failed. */
  unhealthy: boolean;
  /** Docker query and parse failures per stack. */
  errors: { stack: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate the health of the given stacks from Swarm service and task JSON.
 *
 * For each stack:
 * 1. Lists services via `docker stack services` and parses the `Replicas`
 *    field ("running/desired"). Any parsed mismatch (running !== desired,
 *    including running above desired) is a replica mismatch.
 * 2. Lists tasks via `docker stack ps` and collects tasks whose
 *    `CurrentState` starts with "Failed" or "Rejected".
 *
 * Query failures, malformed JSON lines, and unparseable `Replicas` values
 * are collected in `errors` and mark the affected stack and the overall
 * result unhealthy (fail closed).
 */
export async function checkStackHealth(
  options: HealthCheckOptions,
): Promise<HealthCheckResult> {
  const result: HealthCheckResult = { stacks: [], unhealthy: false, errors: [] };

  for (const stack of options.stacks) {
    const services: ServiceHealth[] = [];
    let stackUnhealthy = false;

    // 1. Service replica evaluation
    const svcResult = await dockerStackServices(options.runner, stack);
    if (svcResult.success) {
      const lines = svcResult.stdout.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const parsed = parseJsonLine(line);
        if (parsed === undefined) {
          // Fail closed: malformed service JSON is recorded as an error.
          result.errors.push({ stack, message: `malformed service JSON: ${line}` });
          stackUnhealthy = true;
          continue;
        }
        const svc = parsed as Record<string, unknown>;
        const name = typeof svc.Name === "string" ? svc.Name : "";
        if (!name) continue;

        const { health, parseError } = evaluateServiceReplicas(name, svc.Replicas);
        if (parseError) {
          result.errors.push({ stack, message: parseError });
        }
        if (health.unhealthy) stackUnhealthy = true;
        services.push(health);
      }
    } else {
      result.errors.push({
        stack,
        message: svcResult.stderr || "failed to list services",
      });
      stackUnhealthy = true;
    }

    // 2. Task state evaluation (failed/rejected tasks)
    const psResult = await dockerStackPs(options.runner, stack);
    if (psResult.success) {
      const failedByService = new Map<string, FailedTask[]>();
      const lines = psResult.stdout.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const parsed = parseJsonLine(line);
        if (parsed === undefined) {
          // Fail closed: malformed task JSON is recorded as an error.
          result.errors.push({ stack, message: `malformed task JSON: ${line}` });
          stackUnhealthy = true;
          continue;
        }
        const task = parsed as Record<string, unknown>;
        const state = typeof task.CurrentState === "string" ? task.CurrentState : "";
        if (!isFailedTaskState(state)) continue;

        const serviceName = deriveServiceName(task.Name);
        const error = typeof task.Error === "string" && task.Error.length > 0
          ? task.Error
          : undefined;
        const failed: FailedTask = { name: String(task.Name ?? ""), state, error };
        const bucket = failedByService.get(serviceName) ?? [];
        bucket.push(failed);
        failedByService.set(serviceName, bucket);
      }

      // Attach failed tasks to their evaluated services
      for (const svc of services) {
        const failed = failedByService.get(svc.name);
        if (failed && failed.length > 0) {
          svc.failedTasks.push(...failed);
          svc.unhealthy = true;
          svc.reasons.push(...failed.map((t) => describeFailedTask(t)));
          stackUnhealthy = true;
        }
      }

      // Failed tasks whose service was not in the services listing
      for (const [serviceName, failed] of failedByService) {
        if (services.some((s) => s.name === serviceName)) continue;
        services.push({
          name: serviceName,
          desired: 0,
          running: 0,
          replicaMismatch: false,
          failedTasks: failed,
          unhealthy: true,
          reasons: failed.map((t) => describeFailedTask(t)),
        });
        stackUnhealthy = true;
      }
    } else {
      result.errors.push({
        stack,
        message: psResult.stderr || "failed to list tasks",
      });
      stackUnhealthy = true;
    }

    result.stacks.push({ stack, services, unhealthy: stackUnhealthy });
    if (stackUnhealthy) result.unhealthy = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate one service's replica state from the `Replicas` field, which
 * Docker formats as "running/desired" (e.g. "2/2", "0/3").
 *
 * Any parsed mismatch (running !== desired, including running above
 * desired) marks the service unhealthy. The parser consumes the complete
 * value: trailing garbage such as "2/2 malformed" fails closed as
 * unparseable, the service is marked unhealthy, and a `parseError` is
 * returned so the caller can record it in `HealthCheckResult.errors`.
 */
function evaluateServiceReplicas(
  name: string,
  replicas: unknown,
): { health: ServiceHealth; parseError?: string } {
  const match = typeof replicas === "string" ? /^(\d+)\s*\/\s*(\d+)\s*$/.exec(replicas) : null;
  const running = match ? parseInt(match[1], 10) : 0;
  const desired = match ? parseInt(match[2], 10) : 0;
  const parsed = match !== null;
  const replicaMismatch = parsed && running !== desired;

  const reasons: string[] = [];
  if (!parsed) {
    reasons.push(`unparseable Replicas value: ${String(replicas)}`);
  } else if (replicaMismatch) {
    reasons.push(
      running < desired
        ? `replicas ${running}/${desired}: running below desired`
        : `replicas ${running}/${desired}: running above desired`,
    );
  }

  const health: ServiceHealth = {
    name,
    desired,
    running,
    replicaMismatch,
    failedTasks: [],
    // Fail closed: unparseable replica counts are treated as unhealthy.
    unhealthy: replicaMismatch || !parsed,
    reasons,
  };

  return parsed ? { health } : {
    health,
    parseError: `service ${name}: unparseable Replicas value: ${String(replicas)}`,
  };
}

/**
 * Parse one JSON object line from Docker output.
 *
 * Returns `undefined` when the line is malformed (syntax error) or does
 * not parse to a plain JSON object, so callers can fail closed instead of
 * silently skipping the line.
 */
function parseJsonLine(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * True when the task current state is Failed or Rejected. CurrentState
 * values include a trailing age, e.g. "Failed 3 minutes ago".
 */
function isFailedTaskState(state: string): boolean {
  return /^failed\b/i.test(state) || /^rejected\b/i.test(state);
}

/**
 * Derive the parent service name from a task name. Swarm task names are
 * "<service>.<taskId>", e.g. "traefik_web.1" -> "traefik_web".
 */
function deriveServiceName(taskName: unknown): string {
  const name = typeof taskName === "string" ? taskName : "";
  return name.replace(/\.\d+$/, "");
}

/** Human-readable description of a failed task. */
function describeFailedTask(task: FailedTask): string {
  return `task ${task.name} ${task.state}${task.error ? `: ${task.error}` : ""}`;
}

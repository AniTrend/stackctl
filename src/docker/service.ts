/**
 * Swarm service lifecycle operations built on the ProcessRunner boundary.
 *
 * Currently provides `shutdownService`, which scales an exact, full Swarm
 * service name down to zero replicas via `docker service scale <name>=0`.
 * The caller decides confirmation UX; this module only performs the
 * operation and returns a structured result.
 */
import type { ProcessRunner } from "../process/types.ts";
import { dockerServiceScale } from "./mod.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceShutdownOptions {
  /** Process runner for the scale command. */
  runner: ProcessRunner;
  /** Exact full Swarm service name, e.g. "traefik_web". */
  serviceName: string;
  /** Dry-run: report the intended action without executing. */
  dryRun?: boolean;
}

export type ServiceShutdownAction =
  /** Service was scaled to zero replicas. */
  | "scaled"
  /** Dry-run: the scale command was not executed. */
  | "would-scale"
  /** The scale command failed (including missing services). */
  | "error"
  /** The service name failed validation. */
  | "invalid";

export interface ServiceShutdownResult {
  /** The (trimmed) service name that was targeted. */
  serviceName: string;
  /** Outcome of the shutdown attempt. */
  action: ServiceShutdownAction;
  /** True when the target service does not exist in Swarm. */
  missing?: boolean;
  /** Error detail for `error` and `invalid` actions. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Swarm service names must start with an alphanumeric character and may
 * contain letters, digits, '.', '_' and '-'. Full names include the stack
 * prefix, e.g. "traefik_web".
 */
const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Scale an exact Swarm service down to zero replicas.
 *
 * - Validates the service name shape before touching Docker.
 * - In dry-run mode returns `would-scale` without executing anything.
 * - Executes `docker service scale <name>=0` and reports the result.
 * - A failed command returns `error`; when Docker reports "No such service"
 *   the result is flagged as `missing`.
 */
export async function shutdownService(
  options: ServiceShutdownOptions,
): Promise<ServiceShutdownResult> {
  const { runner, serviceName, dryRun } = options;
  const name = serviceName.trim();

  if (name.length === 0 || !SERVICE_NAME_PATTERN.test(name)) {
    return {
      serviceName: name,
      action: "invalid",
      error: `Invalid service name "${serviceName}"; expected a full Swarm ` +
        "service name using letters, digits, '.', '_' or '-'.",
    };
  }

  if (dryRun) {
    return { serviceName: name, action: "would-scale" };
  }

  const result = await dockerServiceScale(runner, name, 0);
  if (result.success) {
    return { serviceName: name, action: "scaled" };
  }

  const stderr = result.stderr || "Failed to scale service";
  return {
    serviceName: name,
    action: "error",
    missing: /no such service/i.test(stderr),
    error: stderr,
  };
}

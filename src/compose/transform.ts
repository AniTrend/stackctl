/**
 * Service-level transformations for Swarm compatibility.
 *
 * Each function takes a ServiceDef and returns a new ServiceDef — the originals
 * are never mutated.
 */
import { relative, resolve } from "@std/path";
import type { ServiceDef, VolumeMount } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Top-level service keys that are invalid in Docker Swarm mode. */
const COMPOSE_ONLY_KEYS = new Set(["container_name", "restart", "build"]);

/** Default logging configuration injected when a service lacks a logging block. */
const LOGGING_DEFAULTS: Record<string, unknown> = {
  driver: "local",
  options: {
    "max-size": "10m",
    "max-file": 3,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Remove keys from a service definition that are invalid in Docker Swarm mode.
 */
export function stripComposeOnlyKeys(service: ServiceDef): ServiceDef {
  const result: ServiceDef = {};
  for (const [key, value] of Object.entries(service)) {
    if (!COMPOSE_ONLY_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Inject safe logging defaults when no logging block exists on the service.
 */
export function applyLoggingDefaults(service: ServiceDef): ServiceDef {
  if (service.logging) return service; // already present — leave as-is
  return { ...service, logging: LOGGING_DEFAULTS };
}

/**
 * Rewrite relative `env_file` paths to be relative to `repoRoot`.
 *
 * Absolute paths are left unchanged.
 */
export function rewriteEnvFile(
  service: ServiceDef,
  composeDir: string,
  repoRoot: string,
): ServiceDef {
  if (!service.env_file) return service;

  const rewritten = Array.isArray(service.env_file)
    ? service.env_file.map((p) => toRepoRootRel(p, composeDir, repoRoot))
    : toRepoRootRel(service.env_file, composeDir, repoRoot);

  return { ...service, env_file: rewritten };
}

/**
 * Rewrite relative bind-mount source paths in `volumes` to be repo-root-relative.
 *
 * - Short-form strings: split on `:`, check if the source part is a relative path.
 * - Long-form dicts: check if `type` is "bind" (or absent) and `source` is a relative path.
 */
export function rewriteBindMountPaths(
  service: ServiceDef,
  composeDir: string,
  repoRoot: string,
): ServiceDef {
  if (!service.volumes) return service;

  const rewritten = service.volumes.map((vm) => rewriteBindMount(vm, composeDir, repoRoot));

  return { ...service, volumes: rewritten };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a relative path to one relative to repoRoot.
 */
function toRepoRootRel(path: string, composeDir: string, repoRoot: string): string {
  if (path.startsWith("/")) return path; // already absolute
  const clean = path.startsWith("./") ? path.slice(2) : path;
  const absPath = resolve(composeDir, clean);
  const rel = relative(repoRoot, absPath);
  return `./${rel}`;
}

/**
 * Rewrite a single volume mount entry.
 */
function rewriteBindMount(
  mount: VolumeMount,
  composeDir: string,
  repoRoot: string,
): VolumeMount {
  if (typeof mount === "string") {
    return rewriteBindMountString(mount, composeDir, repoRoot);
  }

  // Long-form dict
  const type = mount.type;
  if (type === "volume") return mount; // named volumes — skip

  // bind or missing type (treated as bind)
  if (typeof mount.source === "string" && !mount.source.startsWith("/")) {
    return { ...mount, source: toRepoRootRel(mount.source, composeDir, repoRoot) };
  }
  return mount;
}

/**
 * Rewrite a short-form volume mount string.
 *
 * Format: `[source:]target[:mode]`
 * If the source component is a relative path, rewrite it.
 */
function rewriteBindMountString(
  mount: string,
  composeDir: string,
  repoRoot: string,
): string {
  if (!isBindMountString(mount)) return mount;

  const parts = mount.split(":");
  // At least [source:target], possibly [source:target:mode]
  if (parts.length >= 2) {
    const source = parts[0];
    if (source.startsWith("/") || source.startsWith("~")) return mount;
    parts[0] = toRepoRootRel(source, composeDir, repoRoot);
    return parts.join(":");
  }
  return mount;
}

/**
 * Check if a short-form volume string is a bind mount (not a named volume).
 * Named volumes don't start with `.`, `/`, or `~`.
 */
function isBindMountString(mount: string): boolean {
  const source = mount.split(":")[0];
  return source.startsWith(".") || source.startsWith("/") || source.startsWith("~");
}

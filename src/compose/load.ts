/**
 * Low-level compose file loader.
 *
 * Parses docker-compose YAML files and optional swarm.fragment.yml
 * sidecar files from the same directory.
 */
import { parse as parseYaml } from "@std/yaml";
import { resolve } from "@std/path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoadResult {
  /** Parsed compose data with `x-stack` key removed. */
  data: Record<string, unknown>;
  /** Normalized stack name extracted from the `x-stack` key. */
  stackName: string;
}

// ---------------------------------------------------------------------------
// x-stack normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize the `x-stack` compose metadata field to a stack name string.
 *
 * Supports two forms:
 *   - legacy scalar:   `x-stack: infra`
 *   - object (v1):     `x-stack: { name: infra }`
 *
 * Throws on invalid values, unknown object fields, or missing/empty names.
 */
export function normalizeStackName(value: unknown): string {
  // Legacy scalar form
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new Error("x-stack value must be a non-empty string");
    }
    return trimmed;
  }

  // Object form: must be a plain record
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const knownKeys = new Set(["name"]);

    for (const key of Object.keys(obj)) {
      if (!knownKeys.has(key)) {
        throw new Error(`Unknown field in x-stack object: "${key}"`);
      }
    }

    const name = obj["name"];
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error('x-stack object must have a non-empty "name" field');
    }
    return name.trim();
  }

  throw new Error("x-stack must be a string or {name: string} object");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a docker-compose YAML file and extract its `x-stack` value.
 *
 * Throws if the file cannot be parsed or if `x-stack` is missing / invalid.
 */
export async function loadCompose(path: string): Promise<LoadResult> {
  const raw = await Deno.readTextFile(path);
  let parsed: Record<string, unknown>;
  try {
    parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse compose file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawStack = parsed["x-stack"];
  if (rawStack === undefined || rawStack === null) {
    throw new Error(`Compose file ${path} is missing a valid "x-stack" key`);
  }

  let stackName: string;
  try {
    stackName = normalizeStackName(rawStack);
  } catch (err: unknown) {
    throw new Error(
      `Compose file ${path} has invalid "x-stack": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Return a copy with x-stack removed
  const { "x-stack": _, ...data } = parsed;
  return { data, stackName };
}

/**
 * Load a swarm.fragment.yml from the given directory.
 *
 * Returns an empty object (`{}`) if the file does not exist.
 * Throws if the file exists but cannot be parsed.
 */
export async function loadFragment(directory: string): Promise<Record<string, unknown>> {
  const fragmentPath = resolve(directory, "swarm.fragment.yml");
  try {
    const raw = await Deno.readTextFile(fragmentPath);
    const parsed = parseYaml(raw);
    return (parsed ?? {}) as Record<string, unknown>;
  } catch (err: unknown) {
    // ENOENT means the file doesn't exist — return empty object
    if (err instanceof Deno.errors.NotFound) {
      return {};
    }
    throw err;
  }
}

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
  /** Value of the `x-stack` key (the stack name). */
  stackName: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a docker-compose YAML file and extract its `x-stack` value.
 *
 * Throws if the file cannot be parsed or if `x-stack` is missing / non-string.
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

  const stackName = parsed["x-stack"];
  if (typeof stackName !== "string" || stackName.trim() === "") {
    throw new Error(`Compose file ${path} is missing a valid "x-stack" key`);
  }

  // Return a copy with x-stack removed
  const { "x-stack": _, ...data } = parsed;
  return { data, stackName: stackName.trim() };
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

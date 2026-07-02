/**
 * Docker Compose override merge — distinct from fragment merge.
 *
 * Unlike fragment merge (composeDeepMerge, which REPLACES arrays), Docker
 * Compose override merge follows the official Compose `-f` file semantics:
 *
 *   - Scalars: override wins
 *   - Maps:    recursive merge (override wins on conflicts)
 *   - Arrays:  APPEND (not replace!)
 *   - Neither argument is mutated
 *
 * Ref: https://docs.docker.com/compose/multiple-compose-files/merge/
 */
import type { ComposeData } from "./types.ts";
import type { OverrideEntry } from "../config/types.ts";
import { parse as parseYaml } from "@std/yaml";
import { isAbsolute, resolve } from "@std/path";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge two compose structures using Docker Compose override rules.
 *
 * - Scalars: override wins
 * - Maps: recursive merge (override wins on scalar conflicts)
 * - Sequences: APPEND (unlike composeDeepMerge which replaces)
 * - Neither argument mutated — returns a fresh object.
 */
export function composeOverrideMerge(
  base: ComposeData,
  override: ComposeData,
): ComposeData {
  return deepOverrideRecord(base, override) as ComposeData;
}

/**
 * Load a YAML override file from path.
 *
 * Path can be absolute or relative to repoRoot.  Throws a helpful error
 * when the file is missing or contains invalid YAML.
 */
export async function loadOverrideFile(
  path: string,
  repoRoot: string,
): Promise<ComposeData> {
  const resolvedPath = isAbsolute(path) ? path : resolve(repoRoot, path);

  let raw: string;
  try {
    raw = await Deno.readTextFile(resolvedPath);
  } catch (err: unknown) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`Override file not found: ${resolvedPath}`);
    }
    throw err;
  }

  try {
    const parsed = parseYaml(raw);
    return (parsed ?? {}) as ComposeData;
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse override file ${resolvedPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Load override files and apply them sequentially to a base compose structure.
 *
 * Overrides are applied left-to-right (first entry is applied first).  Each
 * entry can be a plain file-path string or an {@link OverrideEntry} object.
 *
 * @param baseCompose - The base compose data to mutate (not mutated in place)
 * @param overrides   - Ordered list of override entries or file paths
 * @param repoRoot    - Repository root for resolving relative paths
 * @returns The fully-merged compose data
 */
export async function applyOverrides(
  baseCompose: ComposeData,
  overrides: (OverrideEntry | string)[],
  repoRoot: string,
): Promise<ComposeData> {
  let result = baseCompose;

  for (const entry of overrides) {
    const path = typeof entry === "string" ? entry : entry.path;
    const overrideData = await loadOverrideFile(path, repoRoot);
    result = composeOverrideMerge(result, overrideData);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function deepOverrideRecord(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    const baseVal = base[key];

    if (isPlainObject(overrideVal) && isPlainObject(baseVal)) {
      // Recursive merge for objects (handles services/volumes/networks
      // naturally — they are merged by key name)
      result[key] = deepOverrideRecord(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else if (Array.isArray(overrideVal) && Array.isArray(baseVal)) {
      // Arrays are appended (Docker Compose override behaviour)
      result[key] = [...baseVal, ...overrideVal];
    } else {
      // Scalars (or type mismatch): override wins
      result[key] = overrideVal;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compose file discovery: walk repo directories to find docker-compose files
 * annotated with `x-stack` metadata.
 */
import { walk } from "@std/fs/walk";
import { parse as parseYaml } from "@std/yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoverOptions {
  /** Repository root directory. */
  repoRoot: string;
  /** Extra directories to skip beyond the defaults. */
  skipDirs?: string[];
}

export interface DiscoverResult {
  /** Map of stack name -> list of compose file paths belonging to that stack. */
  stacks: Record<string, string[]>;
  /** Errors encountered (malformed YAML files). */
  errors: { path: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories always skipped during discovery. */
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  "stacks",
  "tools",
  "environments",
  "__pycache__",
]);

/** Compose file names to search for. */
const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml"];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Walk the repository root recursively looking for docker-compose files
 * that declare an `x-stack` key.  Groups discovered files by stack name.
 */
export async function discoverComposeFiles(
  options: DiscoverOptions,
): Promise<DiscoverResult> {
  const stacks: Record<string, string[]> = {};
  const errors: { path: string; message: string }[] = [];
  const skipDirs = new Set([
    ...DEFAULT_SKIP_DIRS,
    ...(options.skipDirs ?? []),
  ]);

  for await (
    const entry of walk(options.repoRoot, {
      includeDirs: false,
      includeFiles: true,
      skip: [
        // hidden directories (dot-prefixed)
        /(^|\/)\./,
      ],
    })
  ) {
    const name = entry.path.split("/").pop()!;
    if (!COMPOSE_NAMES.includes(name)) continue;

    const dir = entry.path.substring(0, entry.path.lastIndexOf("/"));

    // Skip if any ancestor directory is in the skip set
    if (hasSkipAncestor(dir, skipDirs)) continue;

    try {
      const raw = await Deno.readTextFile(entry.path);
      const parsed = parseYaml(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") continue;

      const stackName = parsed["x-stack"];
      if (typeof stackName !== "string" || stackName.trim() === "") continue;

      const nameStr = stackName.trim();
      if (!stacks[nameStr]) stacks[nameStr] = [];
      stacks[nameStr].push(entry.path);
    } catch (err: unknown) {
      errors.push({
        path: entry.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { stacks, errors };
}

/**
 * Check if any ancestor directory of `dir` is in the skip set.
 */
function hasSkipAncestor(dir: string, skipDirs: Set<string>): boolean {
  // Normalise to relative path from repo root
  const parts = dir.split("/").filter(Boolean);
  for (const part of parts) {
    if (skipDirs.has(part)) return true;
  }
  return false;
}

/**
 * Env module - .env scaffolding and profile preset support.
 *
 * Issue #14: feat(env): add .env scaffolding and profile preset support
 */
import { exists, walk } from "@std/fs";
import { basename, dirname, join } from "@std/path";
import type {
  BatchCreateResult,
  CreateOptions,
  CreateResult,
  DiscoverOptions,
  EnvDiff,
  EnvExample,
} from "./types.ts";

const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "stacks",
  ".rendered",
  "dist",
  "tools",
  "__pycache__",
]);

/** Parse a .env-style file and return only the keys (no values). */
async function parseEnvKeys(path: string): Promise<string[]> {
  const raw: string = await Deno.readTextFile(path);
  const keys: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    let effective = trimmed;
    if (effective.startsWith("export ")) effective = effective.slice(7).trim();
    const eqIdx = effective.indexOf("=");
    if (eqIdx === -1) continue;
    const key = effective.slice(0, eqIdx).trim();
    if (key.length > 0) keys.push(key);
  }
  return keys;
}

/** Derive a human-readable service name from an .env.example file path. */
function deriveServiceName(examplePath: string, projectDir: string): string {
  const dir = dirname(examplePath);
  if (dir === projectDir) return "root";
  const rel = dir.startsWith(projectDir) ? dir.slice(projectDir.length + 1) : dir;
  return rel || basename(dir);
}

/**
 * Walk the project directory looking for .env.example files.
 * Profile support: when `profile` is provided, looks for
 * `.env.example.<profile>` and `.env.<profile>` variants.
 */
export async function discoverEnvExamples(
  projectDir: string,
  options?: DiscoverOptions,
): Promise<EnvExample[]> {
  const profile = options?.profile;
  const results: EnvExample[] = [];
  const exampleSuffix = profile ? `.env.example.${profile}` : ".env.example";
  const envSuffix = profile ? `.env.${profile}` : ".env";

  for await (
    const entry of walk(projectDir, { includeDirs: false, includeFiles: true })
  ) {
    const name = entry.path.split("/").pop()!;
    if (name !== exampleSuffix) continue;
    const parentDir = dirname(entry.path);
    if (hasSkipAncestor(parentDir, projectDir, DEFAULT_SKIP_DIRS)) continue;
    if (isInHiddenDir(parentDir, projectDir)) continue;

    const examplePath = entry.path;
    const envDir = dirname(examplePath);
    const envPath = join(envDir, envSuffix);
    const serviceName = deriveServiceName(examplePath, projectDir);

    let status: EnvExample["status"];
    const envExists = await exists(envPath);
    if (!envExists) {
      status = "missing";
    } else {
      try {
        const exampleKeys = await parseEnvKeys(examplePath);
        const envKeys = await parseEnvKeys(envPath);
        const missingKeys = exampleKeys.filter((k) => !envKeys.includes(k));
        status = missingKeys.length > 0 ? "outdated" : "present";
      } catch {
        status = "present";
      }
    }
    results.push({ serviceName, examplePath, envPath, status });
  }
  return results;
}

function hasSkipAncestor(dir: string, projectDir: string, skipDirs: Set<string>): boolean {
  const rel = dir.startsWith(projectDir) ? dir.slice(projectDir.length + 1) : dir;
  const parts = rel.split("/").filter(Boolean);
  for (const part of parts) if (skipDirs.has(part)) return true;
  return false;
}

function isInHiddenDir(dir: string, projectDir: string): boolean {
  if (dir === projectDir) return false;
  const rel = dir.startsWith(projectDir) ? dir.slice(projectDir.length + 1) : dir;
  const parts = rel.split("/").filter(Boolean);
  for (const part of parts) if (part.startsWith(".")) return true;
  return false;
}

/** Copy .env.example to .env. Throws if .env exists and force is not set. */
export async function createEnvFromExample(
  examplePath: string,
  envPath: string,
  options?: CreateOptions,
): Promise<CreateResult> {
  const force = options?.force ?? false;
  const dryRun = options?.dryRun ?? false;

  const exampleExists = await exists(examplePath);
  if (!exampleExists) throw new Error(`Example file not found: ${examplePath}`);

  const envExists = await exists(envPath);
  if (envExists && !force) {
    if (dryRun) return { created: false, path: envPath };
    throw new Error(`Env file already exists: ${envPath}. Use --force to overwrite.`);
  }

  if (dryRun) return { created: true, path: envPath };

  const contents = await Deno.readTextFile(examplePath);
  await Deno.writeTextFile(envPath, contents);
  return { created: true, path: envPath };
}

/** Compare keys between .env.example and .env files. */
export async function diffEnvFiles(
  examplePath: string,
  envPath: string,
  serviceName?: string,
): Promise<EnvDiff> {
  const name = serviceName ?? basename(dirname(examplePath));
  let exampleKeys: string[] = [];
  let envKeys: string[] = [];

  const exampleExists = await exists(examplePath);
  if (exampleExists) {
    try {
      exampleKeys = await parseEnvKeys(examplePath);
    } catch (err: unknown) {
      throw new Error(
        `Failed to parse example file ${examplePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const envExists = await exists(envPath);
  if (envExists) {
    try {
      envKeys = await parseEnvKeys(envPath);
    } catch (err: unknown) {
      throw new Error(
        `Failed to parse env file ${envPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const exampleSet = new Set(exampleKeys);
  const envSet = new Set(envKeys);
  const onlyInExample = exampleKeys.filter((k) => !envSet.has(k));
  const onlyInEnv = envKeys.filter((k) => !exampleSet.has(k));
  const common = exampleKeys.filter((k) => envSet.has(k));
  return { serviceName: name, onlyInExample, onlyInEnv, common };
}

/** Discover .env.example files and create .env for each. */
export async function batchCreateEnvs(
  projectDir: string,
  options?: DiscoverOptions & CreateOptions & { serviceName?: string },
): Promise<BatchCreateResult> {
  const profile = options?.profile;
  const force = options?.force ?? false;
  const dryRun = options?.dryRun ?? false;
  const serviceName = options?.serviceName;

  const examples = await discoverEnvExamples(projectDir, { profile });
  const filtered = serviceName
    ? examples.filter((e) =>
      e.serviceName === serviceName || basename(dirname(e.examplePath)) === serviceName
    )
    : examples;

  const result: BatchCreateResult = { created: [], skipped: [], errors: [] };
  for (const ex of filtered) {
    try {
      const cr = await createEnvFromExample(ex.examplePath, ex.envPath, { force, dryRun });
      if (cr.created) result.created.push(cr);
      else {result.skipped.push({
          path: cr.path,
          reason: "Env file already exists (use --force to overwrite)",
        });}
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already exists")) {
        result.skipped.push({ path: ex.envPath, reason: message });
      } else result.errors.push({ path: ex.envPath, message });
    }
  }
  return result;
}

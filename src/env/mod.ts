/**
 * Env module - .env scaffolding and profile preset support.
 *
 * Issue #14: feat(env): add .env scaffolding and profile preset support
 */
import { exists, walk } from "@std/fs";
import { basename, dirname, join, relative } from "@std/path";
import type {
  BatchCreateResult,
  CreateOptions,
  CreateResult,
  DiscoverOptions,
  DoctorFinding,
  DoctorOptions,
  DoctorResult,
  EnvDiff,
  EnvExample,
  EnvStatusEntry,
  MaterializeOptions,
  MaterializeResult,
  MaterializeResultItem,
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
  const paths = options?.paths ?? [];
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

    if (paths.length > 0 && !matchesPaths(entry.path, projectDir, paths)) continue;

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

  if (envExists && force) {
    await backupEnvBeforeOverwrite(envPath);
  }

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
  const paths = options?.paths;

  const examples = await discoverEnvExamples(projectDir, { profile, paths });
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

function matchesPaths(filePath: string, projectDir: string, paths: string[]): boolean {
  if (paths.length === 0) return true;
  const relPath = relative(projectDir, filePath);
  for (const p of paths) {
    const normalized = p.replace(/\/$/, "");
    if (relPath === normalized) return true;
    if (relPath.startsWith(normalized + "/")) return true;
  }
  return false;
}

export async function getEnvStatusList(
  projectDir: string,
  o?: { profile?: string; paths?: string[] },
): Promise<EnvStatusEntry[]> {
  const profile = o?.profile;
  const paths = o?.paths ?? [];
  const entries: EnvStatusEntry[] = [];
  const seen = new Set<string>();

  const examples = await discoverEnvExamples(projectDir, { profile, paths });

  for (const ex of examples) {
    const envDir = dirname(ex.examplePath);
    const encryptedPath = join(envDir, ".env.enc");
    const hasEncrypted = await exists(encryptedPath);
    const hasEnv = ex.status !== "missing";

    entries.push({
      serviceName: ex.serviceName,
      examplePath: ex.examplePath,
      envPath: ex.envPath,
      encryptedPath: hasEncrypted ? encryptedPath : undefined,
      profile: profile,
      hasExample: true,
      hasEnv,
      hasEncrypted,
    });
    seen.add(ex.serviceName);
  }

  if (!profile) {
    for await (
      const entry of walk(projectDir, { includeDirs: false, includeFiles: true })
    ) {
      const name = entry.path.split("/").pop()!;
      const match = name.match(/^\.env\.example\.(.+)$/);
      if (!match) continue;

      const mp = match[1];
      const parentDir = dirname(entry.path);
      if (hasSkipAncestor(parentDir, projectDir, DEFAULT_SKIP_DIRS)) continue;
      if (isInHiddenDir(parentDir, projectDir)) continue;
      if (paths.length > 0 && !matchesPaths(entry.path, projectDir, paths)) continue;

      const svcName = deriveServiceName(entry.path, projectDir);
      const envDir = dirname(entry.path);
      const envPath = join(envDir, ".env." + mp);
      const encryptedPath = join(envDir, ".env.enc");
      const hasEnv = await exists(envPath);
      const hasEncrypted = await exists(encryptedPath);

      const key = svcName + ":" + mp;
      if (seen.has(key)) continue;
      seen.add(key);

      entries.push({
        serviceName: svcName,
        examplePath: entry.path,
        envPath,
        encryptedPath: hasEncrypted ? encryptedPath : undefined,
        profile: mp,
        hasExample: true,
        hasEnv,
        hasEncrypted,
      });
    }
  }

  entries.sort((a, b) => {
    const sn = a.serviceName.localeCompare(b.serviceName);
    if (sn !== 0) return sn;
    return (a.profile ?? "").localeCompare(b.profile ?? "");
  });

  return entries;
}

async function backupEnvBeforeOverwrite(envPath: string): Promise<void> {
  if (!(await exists(envPath))) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bakPath = envPath + ".bak." + ts;
  const contents = await Deno.readTextFile(envPath);
  await Deno.writeTextFile(bakPath, contents);
}

export async function materializeEnvFromProfile(
  projectDir: string,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  const { profile, force = false, dryRun = false, paths = [] } = options;
  if (!profile) throw new Error("--from-profile (or --profile) is required for materialize");

  const result: MaterializeResult = { materialized: [], skipped: [], errors: [] };
  const exampleSuffix = ".env.example." + profile;
  const targetSuffix = ".env";

  for await (
    const entry of walk(projectDir, { includeDirs: false, includeFiles: true })
  ) {
    const name = entry.path.split("/").pop()!;
    if (name !== exampleSuffix) continue;

    const parentDir = dirname(entry.path);
    if (hasSkipAncestor(parentDir, projectDir, DEFAULT_SKIP_DIRS)) continue;
    if (isInHiddenDir(parentDir, projectDir)) continue;
    if (paths.length > 0 && !matchesPaths(entry.path, projectDir, paths)) continue;

    const examplePath = entry.path;
    const envDir = dirname(examplePath);
    const targetPath = join(envDir, targetSuffix);
    const svcName = deriveServiceName(examplePath, projectDir);

    const item: MaterializeResultItem = {
      serviceName: svcName,
      sourcePath: examplePath,
      targetPath,
      written: false,
    };

    try {
      const targetExists = await exists(targetPath);

      if (targetExists && !force) {
        item.reason = "Target .env already exists (use --force to overwrite)";
        result.skipped.push(item);
        continue;
      }

      if (dryRun) {
        item.written = true;
        result.materialized.push(item);
        continue;
      }

      if (targetExists && force) {
        await backupEnvBeforeOverwrite(targetPath);
      }

      const contents = await Deno.readTextFile(examplePath);
      await Deno.writeTextFile(targetPath, contents);
      item.written = true;
      result.materialized.push(item);
    } catch (err: unknown) {
      result.errors.push({
        serviceName: svcName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export async function envDoctor(
  projectDir: string,
  options?: DoctorOptions,
): Promise<DoctorResult> {
  const paths = options?.paths ?? [];
  const dryRun = options?.dryRun ?? false;
  const suggest = options?.suggest ?? true;
  const findings: DoctorFinding[] = [];

  for await (
    const entry of walk(projectDir, { includeDirs: false, includeFiles: true })
  ) {
    const name = entry.path.split("/").pop()!;
    if (name !== ".env") continue;
    const parentDir = dirname(entry.path);
    if (hasSkipAncestor(parentDir, projectDir, DEFAULT_SKIP_DIRS)) continue;
    if (isInHiddenDir(parentDir, projectDir)) continue;
    if (paths.length > 0 && !matchesPaths(entry.path, projectDir, paths)) continue;

    const envPath = entry.path;
    const encryptedPath = join(dirname(envPath), ".env.enc");
    const hasEncrypted = await exists(encryptedPath);
    const relEnv = relative(projectDir, envPath);

    if (hasEncrypted) {
      const parts = ["Plaintext .env file has encrypted counterpart: " + relEnv];
      if (suggest) {
        parts.push("  Suggest: stackctl secrets encrypt " + relEnv);
        parts.push("          or stackctl secrets clean to remove plaintext");
      }
      if (dryRun) {
        parts.unshift("[dry-run] Would warn:");
      }
      findings.push({
        envPath,
        encryptedPath,
        severity: "warning",
        message: parts.join("\n"),
      });
    } else {
      const msg = dryRun
        ? "[dry-run] Would note: Plaintext .env file (no encrypted counterpart): " + relEnv
        : "Plaintext .env file (no encrypted counterpart): " + relEnv;
      findings.push({
        envPath,
        severity: "info",
        message: msg,
      });
    }
  }

  return {
    findings,
    hasWarnings: findings.some((f) => f.severity === "warning"),
  };
}

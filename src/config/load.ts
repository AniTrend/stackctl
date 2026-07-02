/**
 * Config file discovery and resolution.
 *
 * Resolution order (layers merged left to right):
 *   1. DEFAULT_CONFIG
 *   2. .stackctl               (base config)
 *   3. .stackctl.<profile>     (profile overlay)
 *   4. .stackctl.local          (local overrides)
 *   5. .stackctl.local.<profile> (local profile overrides)
 *
 * Validation runs after all layers are merged.
 */
import { exists } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { dirname, join } from "@std/path";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { mergeConfig } from "./merge.ts";
import { validateConfig } from "./validate.ts";
import type { ProfileConfig, ResolvedConfig, StackctlConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** Explicit config file path (bypasses discovery). */
  configPath?: string;
  /** Active profile name (from --profile or STACKCTL_PROFILE). */
  profile?: string;
  /** Working directory (default: Deno.cwd()). */
  cwd?: string;
}

export interface DiscoverResult {
  /** Absolute path to the discovered .stackctl file. */
  configPath: string;
  /** Absolute path to the repository root (parent of .stackctl or .git). */
  repoRoot: string;
  /** Path to .stackctl.<profile> if it exists. */
  profilePath?: string;
  /** Path to .stackctl.local if it exists. */
  localPath?: string;
  /** Path to .stackctl.local.<profile> if it exists. */
  localProfilePath?: string;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Walk up from `cwd` looking for `.stackctl`.
 * Also detects the repository root via `.git`.
 *
 * Returns null if no `.stackctl` file can be found.
 */
export async function discoverConfigFiles(
  options?: { cwd?: string; profile?: string },
): Promise<DiscoverResult | null> {
  const cwd = options?.cwd ?? Deno.cwd();

  const configPath = await walkUpFind(cwd, ".stackctl");
  if (!configPath) return null;

  const baseDir = dirname(configPath);
  const repoRoot = await findRepoRoot(cwd, baseDir);

  const result: DiscoverResult = {
    configPath,
    repoRoot,
  };

  if (options?.profile) {
    const profilePath = join(baseDir, `.stackctl.${options.profile}`);
    if (await exists(profilePath)) {
      result.profilePath = profilePath;
    }
  }

  const localPath = join(baseDir, ".stackctl.local");
  if (await exists(localPath)) {
    result.localPath = localPath;
  }

  if (options?.profile) {
    const localProfilePath = join(baseDir, `.stackctl.local.${options.profile}`);
    if (await exists(localProfilePath)) {
      result.localProfilePath = localProfilePath;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Full config resolution using the layer merge strategy.
 *
 * If `configPath` is provided, it takes precedence over automatic discovery.
 * Profile, local, and local-profile layers are loaded relative to the base config.
 */
export async function resolveConfig(
  options?: ResolveOptions,
): Promise<ResolvedConfig> {
  let profile = options?.profile ?? Deno.env.get("STACKCTL_PROFILE");
  const cwd = options?.cwd ?? Deno.cwd();

  // Acquire base config (discovery or explicit path)
  let discovery: DiscoverResult | null = null;

  if (options?.configPath) {
    const absPath = options.configPath.startsWith("/")
      ? options.configPath
      : join(cwd, options.configPath);

    discovery = {
      configPath: absPath,
      repoRoot: dirname(absPath),
    };

    // Also detect sidecar files if they exist
    const baseDir = dirname(absPath);
    if (profile) {
      const profilePath = join(baseDir, `.stackctl.${profile}`);
      if (await exists(profilePath)) discovery.profilePath = profilePath;
    }
    const localPath = join(baseDir, ".stackctl.local");
    if (await exists(localPath)) discovery.localPath = localPath;
    if (profile) {
      const localProfilePath = join(baseDir, `.stackctl.local.${profile}`);
      if (await exists(localProfilePath)) discovery.localProfilePath = localProfilePath;
    }
  } else {
    discovery = await discoverConfigFiles({ cwd, profile });
    if (!discovery) {
      throw new Error("No .stackctl config file found. Run `stackctl init` to create one.");
    }
  }

  // Start with defaults
  let merged = { ...DEFAULT_CONFIG } as StackctlConfig;
  let profileConfig: ProfileConfig | undefined;
  let localConfig: ProfileConfig | undefined;
  let localProfileConfig: ProfileConfig | undefined;

  // Layer 2: base config
  if (discovery) {
    const baseConfig = await loadConfigFile(discovery.configPath);
    merged = mergeConfig(merged, baseConfig);

    // Determine profile from defaultProfile if not already set
    if (!profile && merged.defaultProfile) {
      profile = merged.defaultProfile;
    }

    // If we now have a profile, discover .stackctl.<profile> in a second pass
    if (profile && !discovery.profilePath) {
      const baseDir = dirname(discovery.configPath);
      const profilePath = join(baseDir, `.stackctl.${profile}`);
      if (await exists(profilePath)) {
        discovery.profilePath = profilePath;
      }
      const localProfilePath = join(baseDir, `.stackctl.local.${profile}`);
      if (await exists(localProfilePath)) {
        discovery.localProfilePath = localProfilePath;
      }
    }

    // Check for ambiguity: no profile, multiple .stackctl.* files, no defaultProfile
    if (!profile) {
      const baseDir = dirname(discovery.configPath);
      const profileFiles = await findProfileFiles(baseDir);
      if (profileFiles.length > 1) {
        const names = profileFiles.map((f: string) => f.replace(".stackctl.", "")).join(", ");
        throw new Error(
          `Ambiguous profile detection: found multiple profile files (${names}). ` +
            `Either set a defaultProfile in .stackctl or specify --profile <name>.`,
        );
      } else if (profileFiles.length === 1) {
        const detected = profileFiles[0].replace(".stackctl.", "");
        profile = detected;
        const profilePath = join(baseDir, `.stackctl.${detected}`);
        if (await exists(profilePath)) {
          discovery.profilePath = profilePath;
        }
        const localProfilePath = join(baseDir, `.stackctl.local.${detected}`);
        if (await exists(localProfilePath)) {
          discovery.localProfilePath = localProfilePath;
        }
      }
    }

    // Layer 3: profile
    if (discovery.profilePath) {
      profileConfig = await loadConfigFile(discovery.profilePath);
      merged = mergeConfig(merged, profileConfig);
    }

    // Layer 4: local
    if (discovery.localPath) {
      localConfig = await loadConfigFile(discovery.localPath);
      merged = mergeConfig(merged, localConfig);
    }

    // Layer 5: local profile
    if (discovery.localProfilePath) {
      localProfileConfig = await loadConfigFile(discovery.localProfilePath);
      merged = mergeConfig(merged, localProfileConfig);
    }
  }

  // Validate
  const errors = validateConfig(merged);
  if (errors.length > 0) {
    const msg = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Config validation failed:\n${msg}`);
  }

  return {
    base: merged,
    profile,
    profileConfig,
    localConfig,
    localProfileConfig,
    overrides: [],
  };
}

// ---------------------------------------------------------------------------
// Simple single-file loader (for testing / external use)
// ---------------------------------------------------------------------------

/**
 * Load and parse a single YAML config file.
 * Returns a partial config (no merging, no defaults).
 */
export async function loadConfig(path: string): Promise<Partial<StackctlConfig>> {
  return await loadConfigFile(path);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Walk up directory tree looking for a file or directory named `target`. */
async function walkUpFind(startDir: string, target: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, target);
    if (await exists(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/** Find repo root by looking for .git upwards, falling back to baseDir. */
async function findProfileFiles(dir: string): Promise<string[]> {
  const profileFiles: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      const name = entry.name;
      if (!name.startsWith(".stackctl.")) continue;
      if (name === ".stackctl") continue;
      if (name === ".stackctl.local") continue;
      if (name.startsWith(".stackctl.local.")) continue;
      profileFiles.push(name);
    }
  } catch {
    // Directory unreadable, return empty
  }
  return profileFiles;
}

/** Find repo root by looking for .git upwards, falling back to baseDir. */
async function findRepoRoot(cwd: string, baseDir: string): Promise<string> {
  const gitDir = await walkUpFind(cwd, ".git");
  if (gitDir) {
    return dirname(gitDir);
  }
  return baseDir;
}

/** Read and parse a YAML file, returning a partial config. */
async function loadConfigFile(path: string): Promise<Partial<StackctlConfig>> {
  const raw = await Deno.readTextFile(path);
  try {
    const parsed = parseYaml(raw) as Record<string, unknown>;
    return (parsed ?? {}) as Partial<StackctlConfig>;
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse YAML config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

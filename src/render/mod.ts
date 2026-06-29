/**
 * Render/Env Interpolation Module — Issue #5
 *
 * Ported from tools/render_compose.py (AniTrend/local-stack).
 *
 * Pipeline position: Generate -> Override -> Render -> Deploy
 */
import { join, resolve } from "@std/path";
import type { ComposeData, ServiceDef, VolumeMount } from "../compose/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Parsed compose data to render. */
  data: ComposeData;
  /** Directory of the stack/compose file (for path resolution). */
  projectDir: string;
  /** Repository root for resolving service env_file paths. */
  repoRoot: string;
  /** Whether to fail on unresolved variables (default: false). */
  strict?: boolean;
}

export interface RenderResult {
  /** The rendered compose data. */
  data: ComposeData;
  /** Warnings encountered (e.g., missing env files, unresolved vars in non-strict). */
  warnings: string[];
  /** Whether any unresolved variables remain (only populated in strict mode). */
  hasUnresolved?: boolean;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Matches ${VAR}, ${VAR-default}, ${VAR:-default}.
 */
const INTERP_RE = /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?:(?<sep>:-|-)\s*(?<default>[^}]*))?\}/g;

/**
 * Matches plain $VAR (no braces, not preceded by another $).
 */
const PLAIN_VAR_RE = /(?<!\$)\$(?<name2>[A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Matches any leftover ${VAR} patterns (for strict-mode check).
 */
const UNRESOLVED_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * Matches any leftover plain $VAR patterns (for strict-mode check).
 * Excludes $$ (escaped dollar) via negative lookbehind.
 */
const UNRESOLVED_PLAIN_RE = /(?<!\$)\$[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Matches a relative path (starts with ./ or ../).
 */
const REL_PATH_RE = /^\.\.?\//;

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

/**
 * Parse a .env file (simple KEY=VALUE lines) into a dict.
 */
export async function parseEnvFile(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let raw: string;

  try {
    raw = await Deno.readTextFile(path);
  } catch (err: unknown) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`Env file not found: ${path}`);
    }
    throw err;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    let effective = trimmed;
    if (effective.startsWith("export ")) {
      effective = effective.slice(7).trim();
    }

    const eqIdx = effective.indexOf("=");
    if (eqIdx === -1) continue;

    const key = effective.slice(0, eqIdx).trim();
    let value = effective.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key.length > 0) {
      result[key] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// resolveEnvPath
// ---------------------------------------------------------------------------

/**
 * Resolve a service env_file path, trying projectDir first then repoRoot.
 */
export function resolveEnvPath(
  relPath: string,
  projectDir: string,
  repoRoot: string,
): string {
  if (relPath.startsWith("/")) return relPath;

  // Try projectDir first
  const fromProject = join(projectDir, relPath);
  try {
    Deno.statSync(fromProject);
    return fromProject;
  } catch {
    // Not found at projectDir, fall through to repoRoot
  }

  // Fallback to repoRoot
  return join(repoRoot, relPath);
}

// ---------------------------------------------------------------------------
// absolutizeServicePaths
// ---------------------------------------------------------------------------

/**
 * Rewrite relative env_file and bind-mount paths to absolute paths.
 * Does NOT mutate the input service.
 */
export function absolutizeServicePaths(
  service: ServiceDef,
  projectDir: string,
  repoRoot: string,
): ServiceDef {
  const result: ServiceDef = { ...service };

  // Absolutize env_file
  if (result.env_file !== undefined) {
    if (Array.isArray(result.env_file)) {
      result.env_file = result.env_file.map((p: string) => absolutizePath(p, projectDir, repoRoot));
    } else {
      result.env_file = absolutizePath(
        result.env_file as string,
        projectDir,
        repoRoot,
      );
    }
  }

  // Absolutize bind-mount paths in volumes
  if (result.volumes !== undefined) {
    result.volumes = result.volumes.map((vm: VolumeMount) => absolutizeVolumeMount(vm, projectDir));
  }

  return result;
}

/**
 * Make a path absolute by resolving relative to projectDir.
 */
function absolutizePath(
  path: string,
  projectDir: string,
  repoRoot: string,
): string {
  if (path.startsWith("/")) return path;
  if (!REL_PATH_RE.test(path)) {
    return resolveEnvPath(path, projectDir, repoRoot);
  }
  return resolve(projectDir, path);
}

/**
 * Determine whether a path is a relative bind-mount source.
 * Returns true for ./ and ../ prefixes, and repo-relative paths like data/logs.
 */
function isRelativeBindSource(path: string): boolean {
  if (REL_PATH_RE.test(path)) return true;
  if (!path.startsWith("/") && path.includes("/")) return true;
  return false;
}

/**
 * Absolutize a single volume mount entry.
 * Named volumes are left unchanged.
 */
function absolutizeVolumeMount(
  mount: VolumeMount,
  projectDir: string,
): VolumeMount {
  if (typeof mount === "string") {
    return absolutizeBindMountString(mount, projectDir);
  }

  const type = mount.type;
  if (type === "volume") return mount;

  if (
    typeof mount.source === "string" &&
    isRelativeBindSource(mount.source)
  ) {
    return {
      ...mount,
      source: resolve(projectDir, mount.source),
    };
  }
  return mount;
}

/**
 * Absolutize a short-form volume mount string.
 * Format: [source:]target[:mode]
 */
function absolutizeBindMountString(
  mount: string,
  projectDir: string,
): string {
  const parts = mount.split(":");
  if (parts.length >= 2) {
    const source = parts[0];
    if (isRelativeBindSource(source)) {
      parts[0] = resolve(projectDir, source);
      return parts.join(":");
    }
  }
  return mount;
}

// ---------------------------------------------------------------------------
// coerceEnvironmentToDict
// ---------------------------------------------------------------------------

/**
 * Normalize service.environment to a dict of strings.
 */
export function coerceEnvironmentToDict(env: unknown): Record<string, string> {
  if (env === undefined || env === null) return {};

  if (Array.isArray(env)) {
    const result: Record<string, string> = {};
    for (const item of env) {
      if (typeof item !== "string") continue;
      const eqIdx = item.indexOf("=");
      if (eqIdx === -1) continue;
      const key = item.slice(0, eqIdx).trim();
      const value = item.slice(eqIdx + 1);
      if (key.length > 0) result[key] = value;
    }
    return result;
  }

  if (typeof env === "object") {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (value !== undefined && value !== null) {
        result[key] = String(value);
      }
    }
    return result;
  }

  return {};
}

// ---------------------------------------------------------------------------
// buildServiceScope
// ---------------------------------------------------------------------------

/**
 * Build the variable scope for a service.
 * Layers: shell env -> env_file(s) -> service.environment.
 * Returns the scope and any warnings about missing env files.
 */
export async function buildServiceScope(
  service: ServiceDef,
  baseEnv: Record<string, string>,
  projectDir: string,
  repoRoot: string,
): Promise<{ scope: Record<string, string>; warnings: string[] }> {
  const scope: Record<string, string> = { ...baseEnv };
  const warnings: string[] = [];

  const envFiles = service.env_file;
  if (envFiles) {
    const files = Array.isArray(envFiles) ? envFiles : [envFiles];
    for (const f of files) {
      const resolved = resolveEnvPath(f, projectDir, repoRoot);
      try {
        const vars = await parseEnvFile(resolved);
        Object.assign(scope, vars);
      } catch {
        warnings.push(
          `Service env_file "${f}" resolved to "${resolved}" but file not found`,
        );
      }
    }
  }

  const serviceEnv = service.environment;
  if (serviceEnv !== undefined) {
    const envDict = coerceEnvironmentToDict(serviceEnv);
    Object.assign(scope, envDict);
  }

  return { scope, warnings };
}

// ---------------------------------------------------------------------------
// substitute
// ---------------------------------------------------------------------------

/**
 * Perform ${VAR}, ${VAR-default}, ${VAR:-default}, and $VAR substitution.
 */
export function substitute(s: string, vars: Record<string, string>): string {
  let result = s.replace(
    INTERP_RE,
    (_match, name: string, sep: string | undefined, defaultValue: string | undefined) => {
      const rawVar = name;
      const hasVar = rawVar in vars;
      const varValue = hasVar ? vars[rawVar] : undefined;

      if (!hasVar) {
        if (sep === undefined) return _match;
        return defaultValue ?? "";
      }

      if (sep === undefined) return varValue ?? "";

      if (sep === "-") return varValue ?? "";

      if (varValue !== undefined && varValue !== "") return varValue;
      return defaultValue ?? "";
    },
  );

  result = result.replace(PLAIN_VAR_RE, (_match, name: string) => {
    if (name in vars) return vars[name] ?? "";
    return _match;
  });

  return result;
}

// ---------------------------------------------------------------------------
// deepInterpolate
// ---------------------------------------------------------------------------

/**
 * Recursively interpolate all string values in a value.
 */
export function deepInterpolate(
  obj: unknown,
  vars: Record<string, string>,
): unknown {
  if (typeof obj === "string") return substitute(obj, vars);

  if (Array.isArray(obj)) return obj.map((item) => deepInterpolate(item, vars));

  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = deepInterpolate(value, vars);
    }
    return result;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// renderStack
// ---------------------------------------------------------------------------

/**
 * Render a stack/compose data structure with per-service env interpolation.
 */
export async function renderStack(options: RenderOptions): Promise<RenderResult> {
  const { data, projectDir, repoRoot, strict = false } = options;
  const warnings: string[] = [];

  const shellEnv = Deno.env.toObject();

  const rendered: ComposeData = { ...data };

  // Process services
  if (rendered.services) {
    const services: Record<string, ServiceDef> = {};

    for (const [svcName, svc] of Object.entries(rendered.services)) {
      let scope: Record<string, string>;
      try {
        const result = await buildServiceScope(svc, shellEnv, projectDir, repoRoot);
        scope = result.scope;
        for (const w of result.warnings) {
          warnings.push(`Service "${svcName}": ${w}`);
        }
      } catch (err: unknown) {
        warnings.push(
          `Service "${svcName}": failed to build env scope: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        scope = { ...shellEnv };
      }

      const interpolated = deepInterpolate(svc, scope) as ServiceDef;
      const absolutized = absolutizeServicePaths(interpolated, projectDir, repoRoot);
      services[svcName] = absolutized;
    }

    rendered.services = services;
  }

  // Interpolate top-level keys
  const topLevelKeys = Object.keys(rendered).filter((k) => k !== "services");
  for (const key of topLevelKeys) {
    const shellScope = { ...shellEnv };
    rendered[key] = deepInterpolate(rendered[key], shellScope);
  }

  // Strict/non-strict unresolved checks (covers both ${VAR} and plain $VAR)
  let hasUnresolved: boolean | undefined;
  if (strict) {
    hasUnresolved = false;
    for (const [, svc] of Object.entries(rendered.services ?? {})) {
      const svcJson = JSON.stringify(svc);

      const bracedMatches = svcJson.match(UNRESOLVED_RE);
      if (bracedMatches) {
        hasUnresolved = true;
        for (const m of new Set(bracedMatches)) {
          warnings.push(`Unresolved variable in strict mode: ${m}`);
        }
      }

      const plainMatches = svcJson.match(UNRESOLVED_PLAIN_RE);
      if (plainMatches) {
        hasUnresolved = true;
        for (const m of new Set(plainMatches)) {
          warnings.push(`Unresolved variable in strict mode: ${m}`);
        }
      }
    }
  } else {
    for (const [, svc] of Object.entries(rendered.services ?? {})) {
      const svcJson = JSON.stringify(svc);

      const bracedMatches = svcJson.match(UNRESOLVED_RE);
      if (bracedMatches) {
        for (const m of new Set(bracedMatches)) {
          warnings.push(`Unresolved variable (left as-is): ${m}`);
        }
      }

      const plainMatches = svcJson.match(UNRESOLVED_PLAIN_RE);
      if (plainMatches) {
        for (const m of new Set(plainMatches)) {
          warnings.push(`Unresolved variable (left as-is): ${m}`);
        }
      }
    }
  }

  return { data: rendered, warnings, hasUnresolved };
}

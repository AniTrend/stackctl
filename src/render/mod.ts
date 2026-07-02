/**
 * Render/Env Interpolation Module — Issue #5
 *
 * Ported from tools/render_compose.py (AniTrend/local-stack).
 *
 * Pipeline position: Generate -> Override -> Render -> Deploy
 */
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
 *
 * Groups:
 *   name - variable name
 *   sep  - separator: "-" or ":-"
 *   default - default value
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
 * Matches a relative path (starts with ./ or ../).
 */
const REL_PATH_RE = /^\.\.?\//;

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

/**
 * Parse a .env file (simple KEY=VALUE lines) into a dict.
 *
 * - Ignores comments (#) and blank lines.
 * - Supports `export KEY=VALUE` syntax.
 * - Strips surrounding quotes from values.
 * - Throws if the file cannot be read.
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
    // Trim and skip blank/comment lines
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Support "export KEY=VALUE" syntax
    let effective = trimmed;
    if (effective.startsWith("export ")) {
      effective = effective.slice(7).trim();
    }

    // Find first "="
    const eqIdx = effective.indexOf("=");
    if (eqIdx === -1) continue; // skip malformed lines

    const key = effective.slice(0, eqIdx).trim();
    let value = effective.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (single or double)
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
 *
 * - Absolute paths are returned as-is.
 * - Relative paths are resolved against projectDir first; if not found, repoRoot.
 */
export function resolveEnvPath(
  relPath: string,
  projectDir: string,
  repoRoot: string,
): string {
  if (relPath.startsWith("/")) return relPath;

  // Try projectDir first
  const fromProject = `${projectDir}/${relPath}`;
  try {
    Deno.statSync(fromProject);
    return fromProject;
  } catch {
    // Not found at projectDir, fall through to repoRoot
  }

  // Fallback to repoRoot
  return `${repoRoot}/${relPath}`;
}

// ---------------------------------------------------------------------------
// absolutizeServicePaths
// ---------------------------------------------------------------------------

/**
 * Rewrite relative env_file and bind-mount paths to absolute paths
 * so rendered YAML works from a different output directory.
 *
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
      result.env_file = result.env_file.map((p) => absolutizePath(p, projectDir, repoRoot));
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
    result.volumes = result.volumes.map((vm) => absolutizeVolumeMount(vm, projectDir));
  }

  return result;
}

/**
 * Make a path absolute by resolving relative to projectDir.
 * Absolute paths and paths with variables are left as-is.
 */
function absolutizePath(
  path: string,
  projectDir: string,
  repoRoot: string,
): string {
  if (path.startsWith("/")) return path;
  if (!REL_PATH_RE.test(path)) {
    // Might be repo-relative (e.g. "services/app/.env")
    // Check if exists relative to repoRoot
    return resolveEnvPath(path, projectDir, repoRoot);
  }
  // Resolve ./ or ../
  return resolvePath(projectDir, path);
}

/**
 * Resolve a path without checking existence.
 */
function resolvePath(base: string, rel: string): string {
  const parts = rel.split("/");
  const baseParts = base.split("/").filter(Boolean);

  for (const part of parts) {
    if (part === "..") {
      baseParts.pop();
    } else if (part !== ".") {
      baseParts.push(part);
    }
  }

  return "/" + baseParts.join("/");
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

  // Long-form dict
  const type = mount.type;
  if (type === "volume") return mount; // named volumes — skip

  // bind or missing type (treated as bind)
  if (
    typeof mount.source === "string" &&
    REL_PATH_RE.test(mount.source)
  ) {
    return {
      ...mount,
      source: resolvePath(projectDir, mount.source),
    };
  }
  return mount;
}

/**
 * Absolutize a short-form volume mount string.
 *
 * Format: `[source:]target[:mode]`
 * If the source component is a relative path, absolutize it.
 */
function absolutizeBindMountString(
  mount: string,
  projectDir: string,
): string {
  const parts = mount.split(":");
  if (parts.length >= 2) {
    const source = parts[0];
    // If source is a relative bind mount path, absolutize
    if (REL_PATH_RE.test(source)) {
      parts[0] = resolvePath(projectDir, source);
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
 *
 * Supports both:
 *   - Mapping form: { KEY: value }
 *   - List form: ["KEY=VALUE", ...]
 *
 * Bare keys (no "=" in list form) are skipped.
 * Returns empty dict for null/undefined/missing.
 */
export function coerceEnvironmentToDict(env: unknown): Record<string, string> {
  if (env === undefined || env === null) return {};

  if (Array.isArray(env)) {
    const result: Record<string, string> = {};
    for (const item of env) {
      if (typeof item !== "string") continue;
      const eqIdx = item.indexOf("=");
      if (eqIdx === -1) continue; // bare key — skip
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
 * Build the variable scope for a service, layering:
 *   1. Shell environment (base)
 *   2. Per-service env_file(s) (in order)
 *   3. service.environment (highest priority)
 */
export async function buildServiceScope(
  service: ServiceDef,
  baseEnv: Record<string, string>,
  projectDir: string,
  repoRoot: string,
): Promise<Record<string, string>> {
  // Start with shell env
  const scope: Record<string, string> = { ...baseEnv };

  // Layer env_file(s)
  const envFiles = service.env_file;
  if (envFiles) {
    const files = Array.isArray(envFiles) ? envFiles : [envFiles];
    for (const f of files) {
      const resolved = resolveEnvPath(f, projectDir, repoRoot);
      try {
        const vars = await parseEnvFile(resolved);
        Object.assign(scope, vars);
      } catch {
        // Missing env file — silently skip (warning emitted at renderStack level)
      }
    }
  }

  // Layer service.environment (highest priority)
  const serviceEnv = service.environment;
  if (serviceEnv !== undefined) {
    const envDict = coerceEnvironmentToDict(serviceEnv);
    Object.assign(scope, envDict);
  }

  return scope;
}

// ---------------------------------------------------------------------------
// substitute
// ---------------------------------------------------------------------------

/**
 * Perform ${VAR}, ${VAR-default}, ${VAR:-default} substitution on a single string.
 *
 * Rules:
 *   ${VAR}           — use VAR if defined, else leave as-is
 *   ${VAR-default}   — use VAR if defined (empty counts as defined!), else 'default'
 *   ${VAR:-default}  — use VAR if defined AND non-empty, else 'default'
 *   $VAR             — plain unbraced form (same as ${VAR})
 *   $$               — preserved as $ (handled by negative lookbehind in PLAIN_VAR_RE)
 *
 * Unresolved variables are left as-is.
 */
export function substitute(s: string, vars: Record<string, string>): string {
  // Step 1: resolve ${VAR...} patterns
  let result = s.replace(
    INTERP_RE,
    (_match, name: string, sep: string | undefined, defaultValue: string | undefined) => {
      const rawVar = name;
      const hasVar = rawVar in vars;
      const varValue = hasVar ? vars[rawVar] : undefined;

      if (!hasVar) {
        // Variable not defined at all
        if (sep === undefined) {
          // ${VAR} — leave as-is
          return _match;
        }
        // ${VAR-default} or ${VAR:-default} — use default
        return defaultValue ?? "";
      }

      if (sep === undefined) {
        // ${VAR} — use value
        return varValue ?? "";
      }

      if (sep === "-") {
        // ${VAR-default} — use var if defined (even empty)
        return varValue ?? "";
      }

      // sep === ":-" — use var if defined AND non-empty
      if (varValue !== undefined && varValue !== "") {
        return varValue;
      }
      return defaultValue ?? "";
    },
  );

  // Step 2: resolve plain $VAR patterns
  result = result.replace(PLAIN_VAR_RE, (_match, name: string) => {
    if (name in vars) {
      return vars[name] ?? "";
    }
    return _match;
  });

  return result;
}

// ---------------------------------------------------------------------------
// deepInterpolate
// ---------------------------------------------------------------------------

/**
 * Recursively interpolate all string values in a value (string/dict/list/scalar).
 *
 * Non-string values (numbers, booleans, null) are passed through unchanged.
 * Objects and arrays are recursed into.
 */
export function deepInterpolate(
  obj: unknown,
  vars: Record<string, string>,
): unknown {
  if (typeof obj === "string") {
    return substitute(obj, vars);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => deepInterpolate(item, vars));
  }

  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (
      const [key, value] of Object.entries(
        obj as Record<string, unknown>,
      )
    ) {
      result[key] = deepInterpolate(value, vars);
    }
    return result;
  }

  // Numbers, booleans, null — pass through
  return obj;
}

// ---------------------------------------------------------------------------
// renderStack
// ---------------------------------------------------------------------------

/**
 * Render a stack/compose data structure with per-service env interpolation.
 *
 * This is the main entry point equivalent to Python's render_compose().
 *
 * Steps:
 *   1. Get shell environment as baseline.
 *   2. For each service, build the variable scope:
 *      shell env -> env_file(s) -> service.environment
 *   3. Recursively interpolate all string values in the service.
 *   4. Absolutize relative paths so rendered YAML works from any directory.
 *   5. Collect warnings for missing env files and unresolved variables.
 *   6. In strict mode: check for leftover ${VAR} patterns and fail if found.
 */
export async function renderStack(options: RenderOptions): Promise<RenderResult> {
  const { data, projectDir, repoRoot, strict = false } = options;
  const warnings: string[] = [];

  // 1. Get shell environment
  const shellEnv = Deno.env.toObject();

  // 2. Clone the data (shallow) to avoid mutating input
  const rendered: ComposeData = { ...data };

  // 3. Process services
  if (rendered.services) {
    const services: Record<string, ServiceDef> = {};

    for (const [svcName, svc] of Object.entries(rendered.services)) {
      // Build variable scope for this service
      let scope: Record<string, string>;
      try {
        scope = await buildServiceScope(svc, shellEnv, projectDir, repoRoot);
      } catch (err: unknown) {
        warnings.push(
          `Service "${svcName}": failed to build env scope: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        scope = { ...shellEnv };
      }

      // Check for missing env files and warn
      const envFiles = svc.env_file;
      if (envFiles) {
        const files = Array.isArray(envFiles) ? envFiles : [envFiles];
        for (const f of files) {
          const resolved = resolveEnvPath(f, projectDir, repoRoot);
          try {
            await Deno.stat(resolved);
          } catch {
            warnings.push(
              `Service "${svcName}" references env_file "${f}" but file not found at "${resolved}"`,
            );
          }
        }
      }

      // Deep interpolate the service
      const interpolated = deepInterpolate(svc, scope) as ServiceDef;

      // Absolutize paths
      const absolutized = absolutizeServicePaths(
        interpolated,
        projectDir,
        repoRoot,
      );

      services[svcName] = absolutized;
    }

    rendered.services = services;
  }

  // 4. Interpolate top-level keys other than services (volumes, networks, etc.)
  const topLevelKeys = Object.keys(rendered).filter((k) => k !== "services");
  for (const key of topLevelKeys) {
    const shellScope = { ...shellEnv };
    rendered[key] = deepInterpolate(rendered[key], shellScope);
  }

  // 5. Strict mode check
  let hasUnresolved: boolean | undefined;
  if (strict) {
    // Stringify the rendered data and check for leftover ${VAR}
    // We need to check the service values since those are the ones that should be resolved
    hasUnresolved = false;
    for (const [, svc] of Object.entries(rendered.services ?? {})) {
      const svcJson = JSON.stringify(svc);
      if (UNRESOLVED_RE.test(svcJson)) {
        hasUnresolved = true;

        // Find which variables remain unresolved for the warning
        const matches = svcJson.match(
          /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g,
        );
        if (matches) {
          for (const m of new Set(matches)) {
            warnings.push(`Unresolved variable in strict mode: ${m}`);
          }
        }
      }
    }
  } else {
    // Non-strict: just warn about unresolvable patterns
    for (const [, svc] of Object.entries(rendered.services ?? {})) {
      const svcJson = JSON.stringify(svc);
      const matches = svcJson.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g);
      if (matches) {
        for (const m of new Set(matches)) {
          warnings.push(`Unresolved variable (left as-is): ${m}`);
        }
      }
    }
  }

  return { data: rendered, warnings, hasUnresolved };
}

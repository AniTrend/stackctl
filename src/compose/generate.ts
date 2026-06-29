/**
 * Stack generation pipeline — the core of `stackctl generate`.
 *
 * Orchestrates discovery, loading, merging, transforming, and serialising
 * compose files into canonical Swarm-ready stack files.
 */
import { stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import { ensureDir } from "@std/fs/ensure-dir";
import { discoverComposeFiles } from "./discover.ts";
import { loadCompose, loadFragment } from "./load.ts";
import { composeDeepMerge } from "./merge.ts";
import {
  applyLoggingDefaults,
  rewriteBindMountPaths,
  rewriteEnvFile,
  stripComposeOnlyKeys,
} from "./transform.ts";
import { collectAllNamedVolumes } from "./volumes.ts";
import type { ComposeData, ServiceDef } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /** Stack names to generate (undefined = all discovered). */
  stacks?: string[];
  /** Repository root path. */
  repoRoot: string;
  /** Output directory for generated stacks (default: <repoRoot>/stacks). */
  outputDir?: string;
  /** Whether this is a dry run (no files written). */
  dryRun?: boolean;
}

export interface GenerateResult {
  /** Map of stack name -> YAML string content. */
  generated: Record<string, string>;
  /** Warnings encountered (non-fatal). */
  warnings: string[];
  /** Errors encountered (non-fatal — some stacks may still succeed). */
  errors: string[];
  /** Files that were (or would be) written. */
  files: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NETWORK_NAME = "traefik-public";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Generate canonical Swarm stack files from per-service Compose sources.
 */
export async function generateStacks(
  options: GenerateOptions,
): Promise<GenerateResult> {
  const outputDir = options.outputDir ?? join(options.repoRoot, "stacks");
  const result: GenerateResult = {
    generated: {},
    warnings: [],
    errors: [],
    files: [],
  };

  // 1. Discover all compose files
  const discovery = await discoverComposeFiles({ repoRoot: options.repoRoot });

  for (const err of discovery.errors) {
    result.warnings.push(`Discovery error at ${err.path}: ${err.message}`);
  }

  // 2. Determine which stacks to generate
  const targetStacks = options.stacks ?? Object.keys(discovery.stacks);

  if (targetStacks.length === 0) {
    result.warnings.push("No stacks discovered");
    return result;
  }

  // 3. Ensure output directory exists
  if (!options.dryRun) {
    await ensureDir(outputDir);
  }

  // 4. Generate each stack
  for (const stackName of targetStacks) {
    try {
      const composePaths = discovery.stacks[stackName];
      if (!composePaths || composePaths.length === 0) {
        result.errors.push(`No compose files found for stack "${stackName}"`);
        continue;
      }

      const output = await generateSingleStack(
        stackName,
        composePaths,
        options.repoRoot,
      );

      result.generated[stackName] = output;

      const outPath = join(outputDir, `${stackName}.yml`);
      if (options.dryRun) {
        result.files.push(outPath);
      } else {
        await Deno.writeTextFile(outPath, output);
        result.files.push(outPath);
      }
    } catch (err: unknown) {
      result.errors.push(
        `Stack "${stackName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Single-stack generation
// ---------------------------------------------------------------------------

async function generateSingleStack(
  _stackName: string,
  composePaths: string[],
  repoRoot: string,
): Promise<string> {
  // 1. Load all compose files + fragments
  const sources = await Promise.all(
    composePaths.map(async (path) => {
      const composeDir = path.substring(0, path.lastIndexOf("/"));
      const { data } = await loadCompose(path);
      const fragment = await loadFragment(composeDir);
      return { composePath: path, composeDir, data, fragment };
    }),
  );

  // 2. Merge: compose data + fragment per-source, then merge all into one
  let merged: ComposeData = {};
  for (const src of sources) {
    const combined = composeDeepMerge(src.data, src.fragment);
    merged = composeDeepMerge(merged, combined);
  }

  // 3. Transform services
  if (merged.services) {
    const transformed: Record<string, ServiceDef> = {};
    for (const [svcName, svc] of Object.entries(merged.services)) {
      let t = stripComposeOnlyKeys(svc);
      t = applyLoggingDefaults(t);
      t = rewriteEnvFile(t, sources[0]?.composeDir ?? "", repoRoot);
      t = rewriteBindMountPaths(t, sources[0]?.composeDir ?? "", repoRoot);
      transformed[svcName] = t;
    }
    merged = { ...merged, services: transformed };
  }

  // 4. Collect named volumes
  const namedVolumes = collectAllNamedVolumes(merged.services);

  // 5. Assemble output structure
  const output: Record<string, unknown> = {};

  // Services
  if (merged.services && Object.keys(merged.services).length > 0) {
    output.services = merged.services;
  }

  // Networks
  output.networks = {
    default: {
      name: NETWORK_NAME,
      external: true,
    },
  };

  // Volumes (only if named volumes exist)
  if (namedVolumes.length > 0) {
    const volumes: Record<string, unknown> = {};
    for (const name of namedVolumes) {
      volumes[name] = { external: true };
    }
    output.volumes = volumes;
  }

  // 6. Serialise to YAML
  const header = "# Generated by stackctl generate — do not edit manually.\n";
  const body = stringifyYaml(output, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  } as Record<string, unknown>);
  return header + body;
}

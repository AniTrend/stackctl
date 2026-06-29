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

export interface GenerateOptions {
  stacks?: string[];
  configStackNames?: string[];
  repoRoot: string;
  outputDir?: string;
  dryRun?: boolean;
  network?: string;
}

export interface GenerateResult {
  generated: Record<string, string>;
  warnings: string[];
  errors: string[];
  files: string[];
}

const DEFAULT_NETWORK_NAME = "traefik-public";

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

  const discovery = await discoverComposeFiles({ repoRoot: options.repoRoot });

  for (const err of discovery.errors) {
    result.warnings.push("Discovery error at " + err.path + ": " + err.message);
  }

  const targetStacks = options.stacks ??
    (options.configStackNames && options.configStackNames.length > 0
      ? options.configStackNames
      : Object.keys(discovery.stacks));

  if (targetStacks.length === 0) {
    result.warnings.push("No stacks discovered");
    return result;
  }

  if (!options.dryRun) {
    await ensureDir(outputDir);
  }

  const network = options.network || DEFAULT_NETWORK_NAME;

  for (const stackName of targetStacks) {
    try {
      const composePaths = discovery.stacks[stackName];
      if (!composePaths || composePaths.length === 0) {
        result.errors.push('No compose files found for stack "' + stackName + '"');
        continue;
      }

      const output = await generateSingleStack(
        stackName,
        composePaths,
        options.repoRoot,
        network,
      );

      result.generated[stackName] = output;

      const outPath = join(outputDir, stackName + ".yml");
      if (options.dryRun) {
        result.files.push(outPath);
      } else {
        await Deno.writeTextFile(outPath, output);
        result.files.push(outPath);
      }
    } catch (err: unknown) {
      result.errors.push(
        'Stack "' + stackName + '": ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return result;
}

async function generateSingleStack(
  _stackName: string,
  composePaths: string[],
  repoRoot: string,
  network?: string,
): Promise<string> {
  const networkName = network || DEFAULT_NETWORK_NAME;

  const sources = await Promise.all(
    composePaths.map(async (path) => {
      const composeDir = path.substring(0, path.lastIndexOf("/"));
      const { data } = await loadCompose(path);
      const fragment = await loadFragment(composeDir);
      return { composePath: path, composeDir, data, fragment };
    }),
  );

  const serviceDirMap = new Map<string, string>();
  for (const src of sources) {
    if (src.data.services) {
      for (const svcName of Object.keys(src.data.services)) {
        if (!serviceDirMap.has(svcName)) {
          serviceDirMap.set(svcName, src.composeDir);
        }
      }
    }
    if (src.fragment.services) {
      for (const svcName of Object.keys(src.fragment.services)) {
        if (!serviceDirMap.has(svcName)) {
          serviceDirMap.set(svcName, src.composeDir);
        }
      }
    }
  }

  let merged: ComposeData = {};
  for (const src of sources) {
    const combined = composeDeepMerge(src.data, src.fragment);
    merged = composeDeepMerge(merged, combined);
  }

  if (merged.services) {
    const transformed: Record<string, ServiceDef> = {};
    for (const [svcName, svc] of Object.entries(merged.services)) {
      const svcDir = serviceDirMap.get(svcName) ?? sources[0]?.composeDir ?? "";
      let t = stripComposeOnlyKeys(svc);
      t = applyLoggingDefaults(t);
      t = rewriteEnvFile(t, svcDir, repoRoot);
      t = rewriteBindMountPaths(t, svcDir, repoRoot);
      transformed[svcName] = t;
    }
    merged = { ...merged, services: transformed };
  }

  const namedVolumes = collectAllNamedVolumes(merged.services);

  const output: Record<string, unknown> = {};

  if (merged.services && Object.keys(merged.services).length > 0) {
    const svcs: Record<string, unknown> = {};
    for (const key of Object.keys(merged.services).sort()) {
      svcs[key] = merged.services[key];
    }
    output.services = svcs;
  }

  output.networks = {
    default: {
      name: networkName,
      external: true,
    },
  };

  if (namedVolumes.length > 0) {
    const volumes: Record<string, unknown> = {};
    const topLevelVolumes = (merged.volumes ?? {}) as Record<string, unknown>;
    for (const name of namedVolumes.sort()) {
      const existingDef = topLevelVolumes[name];
      if (existingDef && typeof existingDef === "object" && existingDef !== null) {
        const def = { ...(existingDef as Record<string, unknown>) };
        if (def.external === undefined) {
          def.external = true;
        }
        volumes[name] = def;
      } else {
        volumes[name] = { external: true };
      }
    }
    output.volumes = volumes;
  }

  const header = "# Generated by stackctl generate — do not edit manually.\n";
  const body = stringifyYaml(output, {
    indent: 2,
    lineWidth: 120,
    useAnchors: false,
    sortKeys: true,
  });
  return header + body;
}

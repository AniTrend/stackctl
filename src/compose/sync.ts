/**
 * Full stack sync pipeline.
 *
 * Orchestrates: config → discover → generate → render → deploy.
 * This is the main entry point for the `sync` and `up` CLI commands.
 */
import { resolveConfig } from "../config/load.ts";
import { discoverComposeFiles } from "./discover.ts";
import { generateStacks } from "./generate.ts";
import { dockerStackDeploy } from "../docker/mod.ts";
import { parse as parseYaml } from "@std/yaml";
import { stringify as stringifyYaml } from "@std/yaml";
import { renderStack } from "../render/mod.ts";
import type { ProcessRunner } from "../process/types.ts";
import type { ResolvedConfig } from "../config/types.ts";
import type { OverrideEntry } from "../config/types.ts";
import type { ComposeData } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncOptions {
  /** Stack names to sync (undefined = all discovered). */
  stacks?: string[];
  /** Dry-run: execute all steps up to docker call but do not deploy. */
  dryRun?: boolean;
  /** Explicit config file path. */
  config?: string;
  /** Active profile name. */
  profile?: string;
  /** Override file paths to apply. */
  overrides?: string[];
  /** Whether to auto-prune obsolete services on deploy. */
  prune?: boolean;
  /** Whether to detach (exit immediately, don't wait for convergence). */
  detach?: boolean;
}

export interface StackSyncStatus {
  stack: string;
  success: boolean;
  error?: string;
}

export interface SyncResult {
  stacks: StackSyncStatus[];
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the full sync pipeline: config → discover → generate → render → deploy.
 *
 * Returns a SyncResult with per-stack status, errors, and warnings.
 * Uses the provided ProcessRunner for all external commands.
 */
export async function sync(
  runner: ProcessRunner,
  opts: SyncOptions,
): Promise<SyncResult> {
  const effectiveRunner = opts.dryRun ? runner.withDryRun(true) : runner;
  const result: SyncResult = { stacks: [], errors: [], warnings: [] };

  // 1. Resolve configuration
  let config: ResolvedConfig;
  try {
    config = await resolveConfig({
      configPath: opts.config,
      profile: opts.profile,
    });
  } catch (err: unknown) {
    result.errors.push(
      `Config resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const repoRoot = config.base.repoRoot ?? Deno.cwd();

  // 2. Discover compose files
  const discovery = await discoverComposeFiles({ repoRoot });
  const targetStacks = opts.stacks ?? Object.keys(discovery.stacks);

  if (targetStacks.length === 0) {
    result.warnings.push("No stacks discovered");
    return result;
  }

  // 3. Build override entries
  const overrideEntries: (OverrideEntry | string)[] = (opts.overrides ?? []).map((o) => ({
    source: "explicit" as const,
    path: o,
  }));

  // 4. Generate stacks in memory (with overrides applied during merge)
  const genResult = await generateStacks({
    stacks: targetStacks,
    repoRoot,
    outputDir: undefined,
    dryRun: true, // in-memory only
    overrides: overrideEntries,
  });

  for (const w of genResult.warnings) result.warnings.push(w);
  for (const e of genResult.errors) result.errors.push(e);

  // 5. Render and deploy each generated stack
  for (const [stackName, yamlContent] of Object.entries(genResult.generated)) {
    try {
      // 5a. Parse generated YAML
      const parsed = parseYaml(yamlContent) as ComposeData;

      // 5b. Render — resolve ${VAR} placeholders
      const renderResult = await renderStack({
        data: parsed,
        projectDir: repoRoot,
        repoRoot,
        strict: true,
      });

      for (const w of renderResult.warnings) {
        result.warnings.push(`[${stackName}] ${w}`);
      }

      // 5c. Deploy (or dry-run)
      if (opts.dryRun) {
        result.stacks.push({ stack: stackName, success: true });
      } else {
        // Write rendered YAML to a temp file for docker stack deploy
        const tempFile = await Deno.makeTempFile({ suffix: ".yml" });
        try {
          const yaml = stringifyYaml(renderResult.data, {
            indent: 2,
            lineWidth: 120,
            noRefs: true,
          } as Record<string, unknown>);
          await Deno.writeTextFile(tempFile, yaml);

          const deployResult = await dockerStackDeploy(
            effectiveRunner,
            stackName,
            tempFile,
            {
              prune: opts.prune,
              detach: opts.detach,
              resolveImage: "always",
            },
          );

          if (deployResult.success) {
            result.stacks.push({ stack: stackName, success: true });
          } else {
            result.stacks.push({
              stack: stackName,
              success: false,
              error: deployResult.stderr || "Deployment failed",
            });
          }
        } catch (err: unknown) {
          result.stacks.push({
            stack: stackName,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          // Clean up temp file
          try {
            await Deno.remove(tempFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    } catch (err: unknown) {
      result.errors.push(
        `Stack "${stackName}": ${err instanceof Error ? err.message : String(err)}`,
      );
      result.stacks.push({
        stack: stackName,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

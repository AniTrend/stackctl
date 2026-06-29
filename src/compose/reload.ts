/**
 * Reload pipeline — config-first, change-aware re-deployment.
 *
 * Unlike `stackctl up` (which runs the full generate→render→deploy pipeline
 * unconditionally), `reload` compares the newly rendered output against what's
 * already on disk in `.rendered/` and only re-deploys stacks whose rendered
 * content has changed.  This avoids unnecessary Swarm service updates when
 * iterating on config during development.
 *
 * Pipeline: generate → override → render → checksum → compare → deploy
 */
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { stringify as stringifyYaml } from "@std/yaml";
import { exists } from "@std/fs";
import { generateStacks } from "./generate.ts";
import { renderStack } from "../render/mod.ts";
import { dockerServiceLogs, dockerStackDeploy, dockerStackServices } from "../docker/mod.ts";
import type { ComposeData } from "./types.ts";
import type { OverrideEntry, ResolvedConfig } from "../config/types.ts";
import type { ProcessRunner } from "../process/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReloadOptions {
  /** Already-resolved configuration (passed from CLI). */
  config: ResolvedConfig;
  /** Process runner for Docker commands. */
  runner: ProcessRunner;
  /** Stack names to reload (undefined = all from config). */
  stacks?: string[];
  /** Skip stack generation, only re-render and re-deploy from existing files. */
  skipGenerate?: boolean;
  /** Dry-run: compare and report but do not write or deploy. */
  dryRun?: boolean;
  /** After deploying changed stacks, stream `docker service logs` for them. */
  followLogs?: boolean;
  /** Active profile name (informational — config is already resolved). */
  profile?: string;
  /** Additional override files from CLI (merged with config.overrides). */
  overrides?: (OverrideEntry | string)[];
}

export interface ReloadResult {
  /** Stack name. */
  stack: string;
  /** Action taken. */
  action: "deployed" | "unchanged" | "error" | "would-deploy" | "would-skip";
  /** Error message when action === "error". */
  error?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the config-first reload pipeline.
 *
 * 1. Generate stacks (unless --skip-generate)
 * 2. Render each stack with env interpolation
 * 3. Compute SHA-256 checksum of the rendered output
 * 4. Compare with existing `.rendered/*.rendered.yml` files
 * 5. Deploy only stacks whose rendered content changed
 * 6. Optionally follow logs for deployed stacks
 */
export async function reloadStacks(options: ReloadOptions): Promise<ReloadResult[]> {
  const {
    config,
    runner,
    stacks: requestedStacks,
    skipGenerate,
    dryRun,
    followLogs,
  } = options;

  const effectiveRunner = dryRun ? runner.withDryRun(true) : runner;
  const repoRoot = config.base.repoRoot ?? Deno.cwd();
  const stacksDir = join(repoRoot, config.base.stack.directory);
  const renderDir = join(repoRoot, config.base.render.outputDirectory);
  const results: ReloadResult[] = [];

  // Determine target stacks
  const stackNames = requestedStacks ?? config.base.stack.names;

  if (stackNames.length === 0) {
    return results;
  }

  // Merge config-level overrides with CLI-level overrides
  const allOverrides: (OverrideEntry | string)[] = [
    ...(config.overrides ?? []),
    ...(options.overrides ?? []),
  ];

  // 1. Generate stacks (unless skipped)
  if (!skipGenerate) {
    const genResult = await generateStacks({
      stacks: stackNames,
      repoRoot,
      outputDir: stacksDir,
      dryRun: false, // write to stacks/ so render can read them
      overrides: allOverrides.length > 0 ? allOverrides : undefined,
    });

    // Report generation errors
    for (const err of genResult.errors) {
      const name = extractStackFromError(err);
      if (name && stackNames.includes(name)) {
        results.push({ stack: name, action: "error", error: err });
      }
    }
  }

  // 2. Render, compare, and deploy each stack
  for (const stackName of stackNames) {
    // Skip stacks that already errored during generation
    if (results.some((r) => r.stack === stackName && r.action === "error")) {
      continue;
    }

    try {
      const stackFile = join(stacksDir, `${stackName}.yml`);

      // 2a. Load generated stack YAML from file
      let yamlContent: string;
      try {
        yamlContent = await Deno.readTextFile(stackFile);
      } catch {
        results.push({
          stack: stackName,
          action: "error",
          error: `Stack file not found: ${stackFile}. Run "stackctl generate" first.`,
        });
        continue;
      }

      // 2b. Parse YAML
      const parsed = parseYaml(yamlContent) as ComposeData;

      // 2c. Render — resolve ${VAR} placeholders
      const renderResult = await renderStack({
        data: parsed,
        projectDir: repoRoot,
        repoRoot,
        strict: true,
      });

      // 2d. Serialise rendered data to a canonical YAML string
      const renderedYaml = `# Rendered by stackctl reload\n${
        stringifyYaml(renderResult.data, {
          indent: 2,
          lineWidth: 120,
          noRefs: true,
        } as Record<string, unknown>)
      }`;

      // 2e. Compute SHA-256 checksum of new rendered content
      const newChecksum = await computeSha256(renderedYaml);

      // 2f. Compare with existing rendered file (if any)
      const renderedFile = join(renderDir, `${stackName}.rendered.yml`);
      const unchanged = await unchangedCheck(renderedFile, newChecksum);

      if (unchanged) {
        results.push({
          stack: stackName,
          action: dryRun ? "would-skip" : "unchanged",
        });
        continue;
      }

      // 2g. Write the new rendered file
      if (!dryRun) {
        try {
          await Deno.mkdir(renderDir, { recursive: true });
          await Deno.writeTextFile(renderedFile, renderedYaml);
        } catch (err: unknown) {
          results.push({
            stack: stackName,
            action: "error",
            error: `Failed to write rendered file: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          continue;
        }
      }

      // 2h. Deploy (or report would-deploy)
      if (dryRun) {
        results.push({ stack: stackName, action: "would-deploy" });
      } else {
        const deployResult = await dockerStackDeploy(
          effectiveRunner,
          stackName,
          renderedFile,
          { prune: false, resolveImage: "always" },
        );

        if (deployResult.success) {
          results.push({ stack: stackName, action: "deployed" });
        } else {
          results.push({
            stack: stackName,
            action: "error",
            error: deployResult.stderr || "Deployment failed",
          });
        }
      }
    } catch (err: unknown) {
      results.push({
        stack: stackName,
        action: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Follow logs for deployed stacks (best-effort)
  if (followLogs && !dryRun) {
    const deployed = results.filter((r) => r.action === "deployed");
    if (deployed.length > 0) {
      const realRunner = runner.withDryRun(false);
      for (const s of deployed) {
        try {
          const svcResult = await dockerStackServices(realRunner, s.stack);
          if (svcResult.success) {
            const lines = svcResult.stdout.trim().split("\n").filter(Boolean);
            for (const line of lines) {
              try {
                const svc = JSON.parse(line);
                if (svc.Name) {
                  await dockerServiceLogs(realRunner, svc.Name, {
                    follow: true,
                    tail: 10,
                  });
                }
              } catch { /* skip malformed JSON */ }
            }
          }
        } catch { /* logs are best-effort */ }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex digest of a UTF-8 string.
 */
async function computeSha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check whether the new rendered content is byte-identical to the existing
 * rendered file on disk.
 *
 * Returns `true` when the file exists AND its content produces the same
 * SHA-256 as `newChecksum`.  Returns `false` when the file is absent or
 * differs.
 */
async function unchangedCheck(
  filePath: string,
  newChecksum: string,
): Promise<boolean> {
  try {
    if (!(await exists(filePath))) return false;
    const existing = await Deno.readTextFile(filePath);
    const existingChecksum = await computeSha256(existing);
    return existingChecksum === newChecksum;
  } catch {
    return false;
  }
}

/**
 * Extract a stack name from a generateStacks error message of the form
 * `Stack "name": reason`.
 */
function extractStackFromError(errorMsg: string): string | null {
  const match = errorMsg.match(/Stack\s+"([^"]+)"/);
  return match ? match[1] : null;
}

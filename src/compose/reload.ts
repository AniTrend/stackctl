/**
 * Reload pipeline — config-first, change-aware re-deployment.
 *
 * Unlike `stackctl up` (which runs the full generate→render→deploy pipeline
 * unconditionally), `reload` is an in-place update tool.  By default it
 * deploys **every selected stack** (generate → render → deploy).
 *
 * Opt-in checksum behaviour: pass `--skip-unchanged` to avoid deploying
 * stacks whose rendered output matches the previously written file on disk.
 *
 * Option precedence (highest to lowest):
 *   CLI flag > active profile config > base config > built-in default
 *
 * Safety: reload only deploys/updates.  It never schedules `docker stack rm`,
 * `docker network rm`, or `docker volume rm` commands.
 *
 * Pipeline: generate → override → render → [checksum?] → deploy → [force-update?]
 */
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { stringify as stringifyYaml } from "@std/yaml";
import { exists } from "@std/fs";
import { generateStacks } from "./generate.ts";
import { renderStack } from "../render/mod.ts";
import {
  dockerServiceLogs,
  dockerServiceUpdate,
  dockerStackDeploy,
  dockerStackServices,
} from "../docker/mod.ts";
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
  /**
   * Only re-deploy stacks whose rendered output has changed from the last
   * written `.rendered/*.rendered.yml` file.  **Default: false** — all
   * stacks are re-deployed every time.
   *
   * Set `--skip-unchanged` to opt in to checksum-based skipping.
   */
  skipUnchanged?: boolean;
  /**
   * Force `docker service update --force` on every service in the stack
   * after `docker stack deploy` completes.  When unset the value from the
   * config file is used; CLI `--force-service-update` / `--no-force-service-update`
   * take precedence.
   */
  forceServiceUpdate?: boolean;
  /** Dry-run: log planned actions without modifying the filesystem or calling Docker. */
  dryRun?: boolean;
  /** After deploying, stream `docker service logs` for changed stacks (best-effort). */
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
 * By default every selected stack is re-deployed unconditionally.
 * Pass `skipUnchanged: true` to opt in to checksum-based change detection.
 *
 * 1. Generate stacks (unless --skip-generate)
 * 2. Render each stack with env interpolation
 * 3. [opt-in] Compute SHA-256 checksum; skip if unchanged
 * 4. Deploy (or report would-deploy in dry-run)
 * 5. [opt-in] Force `docker service update --force` on deployed services
 * 6. [opt-in] Follow logs for deployed stacks
 */
export async function reloadStacks(options: ReloadOptions): Promise<ReloadResult[]> {
  const {
    config,
    runner,
    stacks: requestedStacks,
    skipGenerate,
    skipUnchanged,
    dryRun,
    followLogs,
    forceServiceUpdate,
  } = options;

  // ── Option precedence: CLI flag > profile config > base config ──
  // forceServiceUpdate uses the first defined value:
  //   CLI flag (boolean) > config.commands.reload.forceServiceUpdate > false (default)
  const effectiveForceUpdate = forceServiceUpdate ??
    config.base.commands?.reload?.forceServiceUpdate ??
    false;

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

  // ── 1. Generate stacks (unless skipped) ──────────────────────────
  if (!skipGenerate) {
    if (dryRun) {
      console.log("[dry-run] Step: generate");
    }

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

  // ── 2. Render, [opt-in compare], and deploy each stack ──────────
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

      if (dryRun) {
        console.log(`[dry-run] Step: load ${stackName}.yml`);
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

      if (dryRun) {
        console.log(`[dry-run] Step: render ${stackName}`);
        for (const w of renderResult.warnings) {
          console.error(`[dry-run] render warning: ${w}`);
        }
      }

      // 2d. Serialise rendered data to a canonical YAML string
      const renderedYaml = `# Rendered by stackctl reload\n${
        stringifyYaml(renderResult.data, {
          indent: 2,
          lineWidth: 120,
          noRefs: true,
        } as Record<string, unknown>)
      }`;

      // Define rendered file path (used by checksum, write, and deploy steps)
      const renderedFile = join(renderDir, `${stackName}.rendered.yml`);

      // 2e. [opt-in] Checksum comparison — only when --skip-unchanged
      if (skipUnchanged) {
        const newChecksum = await computeSha256(renderedYaml);

        if (dryRun) {
          console.log(
            `[dry-run] Step: checksum ${stackName} (sha256) ⋯ ${newChecksum.slice(0, 12)}…`,
          );
        }

        const unchanged = await unchangedCheck(renderedFile, newChecksum);

        if (unchanged) {
          if (dryRun) {
            console.log(`[dry-run]   checksum matches previous — skipping`);
          }
          results.push({
            stack: stackName,
            action: dryRun ? "would-skip" : "unchanged",
          });
          continue;
        }
      }

      // 2f. Write the new rendered file
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
      } else {
        console.log(`[dry-run] Step: would write ${renderedFile}`);
      }

      // 2g. Deploy (or report would-deploy)
      if (dryRun) {
        console.log(
          `[dry-run] Step: would deploy ${stackName}` +
            `  → docker stack deploy --compose-file .rendered/${stackName}.rendered.yml ${stackName}`,
        );
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

          // 2h. [opt-in] Force service update after deploy
          if (effectiveForceUpdate) {
            if (dryRun) {
              console.log(`[dry-run] Step: would force-update services for ${stackName}`);
            } else {
              try {
                const svcResult = await dockerStackServices(effectiveRunner, stackName);
                if (svcResult.success) {
                  const lines = svcResult.stdout.trim().split("\n").filter(Boolean);
                  for (const line of lines) {
                    try {
                      const svc = JSON.parse(line);
                      if (svc.Name) {
                        await dockerServiceUpdate(effectiveRunner, svc.Name, { force: true });
                      }
                    } catch { /* skip malformed JSON */ }
                  }
                }
              } catch { /* force-update is best-effort */ }
            }
          }
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

  // ── 3. Follow logs for deployed stacks (best-effort) ────────────
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
 *
 * Only called when `skipUnchanged` is enabled (opt-in).
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
 * Only called when `skipUnchanged` is enabled (opt-in).
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

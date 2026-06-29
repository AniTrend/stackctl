import { Command } from "@cliffy/command";
import { VERSION } from "../version.ts";
import { initConfig } from "../config/mod.ts";
import { resolveConfig } from "../config/mod.ts";
import { ExitCode, type ResolvedConfig } from "../config/types.ts";
import { generateStacks } from "../compose/mod.ts";
import { discoverComposeFiles } from "../compose/mod.ts";
import type { ComposeData, GenerateOptions } from "../compose/mod.ts";
import { join, resolve } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { renderStack } from "../render/mod.ts";
import { RealProcessRunner } from "../process/runner.ts";
import { sync as syncPipeline } from "../compose/sync.ts";
import { reloadStacks } from "../compose/reload.ts";
import type { ReloadResult } from "../compose/reload.ts";
import {
  checkTooling,
  cleanTempFiles,
  decryptFile,
  deploySecrets,
  discoverDecryptedFiles,
  discoverEncryptedFiles,
  encryptFile,
} from "../secrets/mod.ts";
import {
  dockerInfo,
  dockerServiceLogs,
  dockerStackPs,
  dockerStackRm,
  dockerStackServices,
  dockerSwarmStatus,
} from "../docker/mod.ts";
import { batchCreateEnvs, diffEnvFiles, discoverEnvExamples } from "../env/mod.ts";
import type { EnvDiff } from "../env/types.ts";
import { basename, dirname } from "@std/path";

/**
 * Parse and execute CLI commands.
 * Returns the process exit code (0 for success).
 */
export async function main(args: string[]): Promise<number> {
  try {
    const cmd = await buildCli().parse(args);
    return cmd instanceof Error ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/**
 * Build the stackctl CLI command tree.
 * Commands are registered here in their skeleton form;
 * full implementations are added in subsequent issues.
 */
export function buildCli(): Command {
  const cli = new Command()
    .name("stackctl")
    .version(VERSION)
    .description(
      "Standalone repository-aware Docker Swarm stack controller.\n" +
        "Manage Docker Swarm stacks with generation, rendering, secrets, and lifecycle commands.",
    )
    .help({ hints: true })
    .option("--debug", "Enable debug output and stack traces.", { hidden: false })
    .option("--config <path:string>", "Path to .stackctl config file.", { hidden: false });

  // Default action: show help when no subcommand matches
  cli.action(() => {
    cli.showHelp();
    Deno.exit(0);
  });

  // --- init (issue #3) ---
  cli.command("init", "Generate a commented .stackctl configuration file.")
    .option("--detect", "Detect repository layout and infer config values.")
    .option("--preset <name:string>", "Use a preset configuration template.")
    .option("--profile <name:string>", "Create an additional profile config file.")
    .option("--write-gitignore", "Append .stackctl.local and .env to .gitignore.")
    .option("--force", "Overwrite existing .stackctl file.")
    .option("--dry-run", "Print the config that would be written without writing.")
    .action(async (options: Record<string, unknown>) => {
      const detect = options.detect as boolean | undefined;
      const preset = options.preset as string | undefined;
      const profile = options.profile as string | undefined;
      const writeGitignore = options.writeGitignore as boolean | undefined;
      const force = options.force as boolean | undefined;
      const dryRun = options.dryRun as boolean | undefined;

      const result = await initConfig({
        detect,
        preset,
        profile,
        force,
        dryRun,
        cwd: Deno.cwd(),
      });

      for (const err of result.errors) {
        console.error(`error: ${err}`);
      }

      if (result.errors.length > 0) {
        Deno.exit(2); // ExitCode.UserConfigError
      }

      if (dryRun) {
        for (const file of result.written) {
          console.log(`would write: ${file}`);
        }
      } else {
        for (const file of result.written) {
          console.log(`wrote: ${file}`);
        }
      }

      // Handle --write-gitignore
      if (writeGitignore) {
        await appendGitignore(Deno.cwd());
      }
    });

  // --- generate (issue #4) ---
  cli.command("generate", "Generate canonical stack files from per-service Compose sources.")
    .option("--dry-run", "Print generated output without writing files.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to generate.")
    .option("--output-dir <path:string>", "Write generated stacks to a specific directory.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option(
      "--override <files:string>",
      "Comma-separated list of override files to apply.",
    )
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;

        const config = await resolveConfig({ profile, cwd: Deno.cwd() });
        const repoRoot = config.base.repoRoot ?? Deno.cwd();

        // Parse override file paths
        const overrideFiles = options.override
          ? (options.override as string).split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;

        const genOptions: GenerateOptions = {
          stacks: options.stacks
            ? (options.stacks as string).split(",").map((s: string) => s.trim())
            : undefined,
          repoRoot,
          outputDir: options.outputDir as string | undefined,
          dryRun,
          overrides: overrideFiles,
        };

        const result = await generateStacks(genOptions);

        // Print warnings
        for (const w of result.warnings) {
          console.error(`warning: ${w}`);
        }

        // Print errors
        if (result.errors.length > 0) {
          for (const e of result.errors) {
            console.error(`error: ${e}`);
          }
          Deno.exit(ExitCode.DriftOrValidation);
        }

        if (dryRun) {
          for (const [name, content] of Object.entries(result.generated)) {
            console.log(`# --- stack: ${name} ---`);
            console.log(content);
          }
        } else {
          for (const f of result.files) {
            console.log(`wrote: ${f}`);
          }
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- render (issue #5) ---
  cli.command(
    "render",
    "Resolve ${VAR} placeholders in stack files using service-local env values.",
  )
    .option("--stacks <names:string>", "Comma-separated list of stack names to render.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--strict", "Fail on any unresolved variable.")
    .option("--output-dir <path:string>", "Write rendered output to a specific directory.")
    .option(
      "--override <files:string>",
      "Comma-separated list of override files to apply before rendering.",
    )
    .option("--dry-run", "Print rendered output without writing files.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const strict = options.strict as boolean | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const outputDir = options.outputDir as string | undefined;

        const config = await resolveConfig({ profile, cwd: Deno.cwd() });
        const repoRoot = config.base.repoRoot ?? Deno.cwd();
        const renderOutputDir = outputDir || config.base.render.outputDirectory;

        // 1. Generate stacks (in memory)
        const genResult = await generateStacks({
          stacks: options.stacks
            ? (options.stacks as string).split(",").map((s: string) => s.trim())
            : undefined,
          repoRoot,
          outputDir: undefined, // generate in memory only
          dryRun: true, // generate in memory for render
          overrides: options.override
            ? (options.override as string).split(",").map((s: string) => s.trim())
            : undefined,
        });

        if (genResult.errors.length > 0) {
          for (const e of genResult.errors) console.error(`error: ${e}`);
          Deno.exit(ExitCode.DriftOrValidation);
        }

        // 2. Render each generated stack
        const allWarnings: string[] = [];
        const results: Record<string, string> = {};
        let hasUnresolved = false;

        for (const [stackName, yamlContent] of Object.entries(genResult.generated)) {
          const parsed = parseYaml(yamlContent) as ComposeData;
          const projectDir = repoRoot; // generated stacks live at repo root

          const result = await renderStack({
            data: parsed,
            projectDir,
            repoRoot,
            strict,
          });

          allWarnings.push(...result.warnings);
          if (result.hasUnresolved) hasUnresolved = true;

          results[stackName] = `# Rendered by stackctl render — do not edit manually.\n${
            stringifyYaml(result.data, {
              indent: 2,
              lineWidth: 120,
            } as Record<string, unknown>)
          }`;
        }

        // 3. Print warnings
        for (const w of allWarnings) {
          console.error(`warning: ${w}`);
        }

        // 4. Output
        if (dryRun) {
          for (const [name, content] of Object.entries(results)) {
            console.log(`# --- rendered: ${name} ---`);
            console.log(content);
          }
        } else {
          const outDir = resolve(repoRoot, renderOutputDir);
          await ensureDir(outDir);
          for (const [name, content] of Object.entries(results)) {
            const outPath = join(outDir, `${name}.rendered.yml`);
            await Deno.writeTextFile(outPath, content);
            console.log(`wrote: ${outPath}`);
          }
        }

        if (strict && hasUnresolved) {
          Deno.exit(ExitCode.DriftOrValidation);
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- up (issue #6) ---
  cli.command("up", "Deploy stacks to Docker Swarm.")
    .option("--follow-logs", "Follow logs after deploy.")
    .option("--dry-run", "Print planned actions without executing.")
    .option("--detach", "Exit immediately without waiting for services to converge.")
    .option("--prune", "Prune obsolete services.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to deploy.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--override <files:string>", "Comma-separated list of override files.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const followLogs = options.followLogs as boolean | undefined;
        const detach = options.detach as boolean | undefined;
        const prune = options.prune as boolean | undefined;

        const stacks = options.stacks
          ? (options.stacks as string).split(",").map((s: string) => s.trim())
          : undefined;

        const overrides = options.override
          ? (options.override as string).split(",").map((s: string) => s.trim())
          : undefined;

        const runner = new RealProcessRunner(dryRun ?? false);

        const result = await syncPipeline(runner, {
          stacks,
          dryRun,
          profile,
          overrides,
          prune,
          detach,
        });

        for (const w of result.warnings) console.error(`warning: ${w}`);
        for (const e of result.errors) console.error(`error: ${e}`);

        for (const s of result.stacks) {
          const icon = s.success ? "✓" : "✗";
          console.log(`${icon} ${s.stack}`);
          if (s.error) console.error(`  error: ${s.error}`);
        }

        if (result.errors.length > 0 || result.stacks.some((s) => !s.success)) {
          Deno.exit(ExitCode.DriftOrValidation);
        }

        // Follow logs after deploy if requested
        if (followLogs && !dryRun) {
          console.log("\n--- Following logs (Ctrl-C to stop) ---");
          for (const s of result.stacks.filter((s) => s.success)) {
            try {
              const svcResult = await dockerStackServices(
                new RealProcessRunner(false),
                s.stack,
              );
              if (svcResult.success) {
                const lines = svcResult.stdout.trim().split("\n").filter(Boolean);
                for (const line of lines) {
                  try {
                    const svc = JSON.parse(line);
                    if (svc.Name) {
                      await dockerServiceLogs(new RealProcessRunner(false), svc.Name, {
                        follow: true,
                        tail: 10,
                      });
                    }
                  } catch { /* skip malformed JSON lines */ }
                }
              }
            } catch { /* logs are best-effort */ }
          }
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- down (issue #6) ---
  cli.command("down", "Remove stacks from Docker Swarm.")
    .option("--yes", "Skip confirmation prompt.")
    .option("--dry-run", "Print planned actions without executing.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to remove.")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const skipConfirm = options.yes as boolean | undefined;

        const config = await resolveConfig({ profile, cwd: Deno.cwd() });
        const repoRoot = config.base.repoRoot ?? Deno.cwd();

        const discovery = await discoverComposeFiles({ repoRoot });
        const targetStacks = options.stacks
          ? (options.stacks as string).split(",").map((s: string) => s.trim())
          : Object.keys(discovery.stacks);

        if (targetStacks.length === 0) {
          console.log("No stacks to remove.");
          return;
        }

        // Confirmation prompt
        if (!dryRun && !skipConfirm) {
          console.log("The following stacks will be removed:");
          for (const s of targetStacks) console.log(`  - ${s}`);
          const answer = prompt("Proceed? [y/N] ");
          if (!answer || answer.toLowerCase() !== "y") {
            console.log("Aborted.");
            return;
          }
        }

        const runner = new RealProcessRunner(dryRun ?? false);

        for (const stackName of targetStacks) {
          const result = await dockerStackRm(runner, stackName);
          if (result.success) {
            console.log(`${dryRun ? "[dry-run] would remove" : "Removed"}: ${stackName}`);
          } else {
            console.error(`error removing ${stackName}: ${result.stderr || "failed"}`);
          }
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- status (issue #6) ---
  cli.command("status", "Show stack service status.")
    .option("--json", "Output JSON machine-readable status.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const jsonOutput = options.json as boolean | undefined;

        const config = await resolveConfig({ profile, cwd: Deno.cwd() });
        const repoRoot = config.base.repoRoot ?? Deno.cwd();

        const discovery = await discoverComposeFiles({ repoRoot });
        const targetStacks = options.stacks
          ? (options.stacks as string).split(",").map((s: string) => s.trim())
          : Object.keys(discovery.stacks);

        if (targetStacks.length === 0) {
          console.log(jsonOutput ? "{}" : "No stacks discovered.");
          return;
        }

        const runner = new RealProcessRunner(false);
        const statusResult: Record<string, unknown> = {};

        for (const stackName of targetStacks) {
          if (jsonOutput) {
            const svcResult = await dockerStackServices(runner, stackName);
            const psResult = await dockerStackPs(runner, stackName);

            const services: unknown[] = [];
            if (svcResult.success) {
              for (const line of svcResult.stdout.trim().split("\n").filter(Boolean)) {
                try {
                  services.push(JSON.parse(line));
                } catch { /* skip */ }
              }
            }

            const tasks: unknown[] = [];
            if (psResult.success) {
              for (const line of psResult.stdout.trim().split("\n").filter(Boolean)) {
                try {
                  tasks.push(JSON.parse(line));
                } catch { /* skip */ }
              }
            }

            statusResult[stackName] = { services, tasks };
          } else {
            console.log(`\n=== ${stackName} ===`);
            const svcResult = await dockerStackServices(runner, stackName);
            if (svcResult.success) {
              console.log(svcResult.stdout || "  (no services)");
            } else {
              console.error(`  error: ${svcResult.stderr || "failed to list services"}`);
            }
          }
        }

        if (jsonOutput) {
          console.log(JSON.stringify(statusResult, null, 2));
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- logs (issue #6) ---
  cli.command("logs", "Follow service logs.")
    .arguments("[services...:string]")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--follow", "Follow log output (default: true).")
    .option("--tail <n:number>", "Number of lines from end (default: all).")
    .action(async (options: Record<string, unknown>, ...serviceArgs: string[]) => {
      try {
        const profile = options.profile as string | undefined;
        const follow = options.follow !== false;
        const tail = options.tail as number | undefined;
        const services = serviceArgs.length > 0 ? serviceArgs : undefined;

        const config = await resolveConfig({ profile, cwd: Deno.cwd() });
        const repoRoot = config.base.repoRoot ?? Deno.cwd();

        const runner = new RealProcessRunner(false);

        // If explicit services provided, tail them directly
        if (services && services.length > 0) {
          for (const svc of services) {
            console.log(`=== ${svc} ===`);
            await dockerServiceLogs(runner, svc, { follow, tail });
          }
          return;
        }

        // Otherwise discover stacks and tail all services
        const stacks = options.stacks
          ? (options.stacks as string).split(",").map((s: string) => s.trim())
          : undefined;

        const discovery = await discoverComposeFiles({ repoRoot });
        const targetStacks = stacks ?? Object.keys(discovery.stacks);

        for (const stackName of targetStacks) {
          const svcResult = await dockerStackServices(runner, stackName);
          if (!svcResult.success) {
            console.error(`error listing services for ${stackName}: ${svcResult.stderr}`);
            continue;
          }

          const lines = svcResult.stdout.trim().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const svc = JSON.parse(line);
              if (svc.Name) {
                console.log(`=== ${svc.Name} ===`);
                await dockerServiceLogs(runner, svc.Name, { follow, tail });
              }
            } catch { /* skip */ }
          }
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- sync (issue #6) ---
  cli.command("sync", "Full sync pipeline: generate, render, and deploy stacks.")
    .option("--dry-run", "Preview sync without deploying.")
    .option("--config <path:string>", "Explicit config file path.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--override <files:string>", "Comma-separated list of override files.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--prune", "Prune obsolete services on deploy.")
    .option("--detach", "Exit immediately without waiting for services to converge.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const configPath = options.config as string | undefined;
        const prune = options.prune as boolean | undefined;
        const detach = options.detach as boolean | undefined;

        const stacks = options.stacks
          ? (options.stacks as string).split(",").map((s: string) => s.trim())
          : undefined;

        const overrides = options.override
          ? (options.override as string).split(",").map((s: string) => s.trim())
          : undefined;

        const runner = new RealProcessRunner(dryRun ?? false);

        const result = await syncPipeline(runner, {
          stacks,
          dryRun,
          config: configPath,
          profile,
          overrides,
          prune,
          detach,
        });

        for (const w of result.warnings) console.error(`warning: ${w}`);
        for (const e of result.errors) console.error(`error: ${e}`);

        for (const s of result.stacks) {
          const icon = dryRun ? "[dry-run]" : s.success ? "✓" : "✗";
          console.log(`${icon} ${s.stack}`);
          if (s.error) console.error(`  error: ${s.error}`);
        }

        if (result.errors.length > 0 || result.stacks.some((s) => !s.success)) {
          Deno.exit(ExitCode.DriftOrValidation);
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- doctor (issue #6) ---
  cli.command("doctor", "Check system and project health.")
    .option("--fix-volumes", "Create missing external volumes.")
    .option("--check-secrets", "Also check for secrets tooling (sops, age).")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(async (options: Record<string, unknown>) => {
      const issues: string[] = [];
      const checks: string[] = [];

      const profile = options.profile as string | undefined;
      const checkSecrets = options.checkSecrets as boolean | undefined;

      const runner = new RealProcessRunner(false);

      // 1. Check Docker installed and running
      checks.push("Docker installed and running...");
      try {
        const infoResult = await dockerInfo(runner);
        if (infoResult.success) {
          checks.push("  ✓ Docker is running");
        } else {
          issues.push("Docker is not running or not accessible.");
        }
      } catch {
        issues.push("Docker command not found. Is Docker installed?");
      }

      // 2. Check Docker Swarm mode
      checks.push("Docker Swarm mode...");
      try {
        const swarm = await dockerSwarmStatus(runner);
        if (swarm.active) {
          checks.push(`  ✓ Swarm mode active${swarm.nodeId ? ` (node: ${swarm.nodeId})` : ""}`);
        } else {
          issues.push("Docker is not in Swarm mode. Run: docker swarm init");
        }
      } catch {
        issues.push("Could not determine Swarm status.");
      }

      // 3. Check config file exists and is valid
      checks.push("Config file...");
      try {
        const config = await resolveConfig({ profile, cwd: Deno.cwd() });
        checks.push(`  ✓ Config resolved (profile: ${config.profile ?? "default"})`);
        checks.push(`    Project: ${config.base.project || "(unnamed)"}`);
        checks.push(`    Stack directory: ${config.base.stack.directory}`);
        checks.push(`    Stack names: ${config.base.stack.names.join(", ") || "(none)"}`);

        // 4. Check override files referenced in config exist
        for (const override of config.overrides) {
          const existsInFs = await exists(override.path);
          if (!existsInFs) {
            issues.push(`Override file not found: ${override.path}`);
          } else {
            checks.push(`  ✓ Override: ${override.path}`);
          }
        }
      } catch (err: unknown) {
        issues.push(
          `Config error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 5. Check sops/age available (if secrets configured)
      if (checkSecrets) {
        checks.push("Secrets tooling...");
        const sopsOk = await runner.which("sops");
        const ageOk = await runner.which("age");
        if (sopsOk) {
          checks.push("  ✓ sops available");
        } else {
          issues.push("sops not found on PATH. Install: https://github.com/getsops/sops");
        }
        if (ageOk) {
          checks.push("  ✓ age available");
        } else {
          issues.push("age not found on PATH. Install: https://github.com/FiloSottile/age");
        }
      }

      // 6. Check for external volumes (if --fix-volumes)
      if (options.fixVolumes as boolean | undefined) {
        checks.push("External volumes: not yet implemented");
      }

      // Output results
      console.log("=== stackctl doctor ===\n");
      for (const c of checks) console.log(c);
      console.log("");

      if (issues.length > 0) {
        console.error("Issues found:");
        for (const issue of issues) console.error(`  ✗ ${issue}`);
        console.error(`\n${issues.length} issue(s) found.`);
        Deno.exit(ExitCode.MissingDependency);
      } else {
        console.log("All checks passed.");
      }
    });

  // --- reload (issue #9) ---
  cli.command("reload", "Re-render and redeploy only changed stacks without tearing them down.")
    .option("--skip-generate", "Only re-render and re-deploy, do not regenerate stacks.")
    .option("--follow-logs", "Stream logs for deployed stacks after reload.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to reload.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--config <path:string>", "Explicit path to .stackctl config file.")
    .option("--override <files:string>", "Comma-separated list of override files to apply.")
    .option("--dry-run", "Compare and report planned actions without executing.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const skipGenerate = options.skipGenerate as boolean | undefined;
        const followLogs = options.followLogs as boolean | undefined;
        const configPath = options.config as string | undefined;

        const stacks = options.stacks
          ? (options.stacks as string).split(",").map((s: string) => s.trim())
          : undefined;

        const overrides = options.override
          ? (options.override as string).split(",").map((s: string) => s.trim())
          : undefined;

        const config = await resolveConfig({
          configPath,
          profile,
          cwd: Deno.cwd(),
        });

        const runner = new RealProcessRunner(dryRun ?? false);

        const results = await reloadStacks({
          config,
          runner,
          stacks,
          skipGenerate,
          dryRun,
          followLogs,
          profile,
          overrides,
        });

        // Report results
        for (const r of results) {
          const icon = r.action === "deployed"
            ? "✓"
            : r.action === "unchanged"
            ? "·"
            : r.action === "would-deploy"
            ? "[dry-run] would deploy"
            : r.action === "would-skip"
            ? "[dry-run] unchanged"
            : "✗";
          console.log(`${icon} ${r.stack}`);
          if (r.error) console.error(`  error: ${r.error}`);
        }

        if (results.some((r: ReloadResult) => r.action === "error")) {
          Deno.exit(ExitCode.DriftOrValidation);
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- secrets (issue #7) ---
  const secretsCmd = cli.command("secrets", "Manage SOPS/age encrypted secrets.");

  secretsCmd.command("encrypt", "Encrypt .env files to encrypted output.")
    .arguments("[files...:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .option("--age-key <key:string>", "Explicit age public key for encryption.")
    .action(async (options: Record<string, unknown>, ...fileArgs: string[]) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const ageKey = options.ageKey as string | undefined;

        let config: ResolvedConfig;
        try {
          config = await resolveConfig({ profile, cwd: Deno.cwd() });
        } catch (err: unknown) {
          console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
          Deno.exit(ExitCode.MissingDependency);
        }

        const runner = new RealProcessRunner(dryRun ?? false);

        const sopsOk = await runner.which("sops");
        if (!sopsOk && !dryRun) {
          console.error("error: sops is not installed. Install: https://github.com/getsops/sops");
          Deno.exit(ExitCode.MissingDependency);
        }

        const files: string[] = fileArgs.length > 0
          ? fileArgs
          : await discoverDecryptedFiles(config);

        if (files.length === 0) {
          console.log("No files to encrypt.");
          return;
        }

        let hasErrors = false;
        for (const file of files) {
          const result = await encryptFile(file, config, runner, { dryRun, ageKey });
          if (result.success) {
            console.log(`${dryRun ? "[dry-run] encrypted" : "encrypted"}: ${file}`);
          } else {
            console.error(`error encrypting ${file}: ${result.error}`);
            hasErrors = true;
          }
        }

        if (hasErrors) Deno.exit(ExitCode.DriftOrValidation);
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  secretsCmd.command("decrypt", "Decrypt encrypted .env files to plaintext.")
    .arguments("[files...:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .option("--output <dir:string>", "Directory to write decrypted output.")
    .option("--age-key <key:string>", "Explicit age key for decryption.")
    .action(async (options: Record<string, unknown>, ...fileArgs: string[]) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const outputDir = options.output as string | undefined;
        const ageKey = options.ageKey as string | undefined;

        let config: ResolvedConfig;
        try {
          config = await resolveConfig({ profile, cwd: Deno.cwd() });
        } catch (err: unknown) {
          console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
          Deno.exit(ExitCode.MissingDependency);
        }

        const runner = new RealProcessRunner(dryRun ?? false);

        const sopsOk = await runner.which("sops");
        if (!sopsOk && !dryRun) {
          console.error("error: sops is not installed. Install: https://github.com/getsops/sops");
          Deno.exit(ExitCode.MissingDependency);
        }

        const files: string[] = fileArgs.length > 0
          ? fileArgs
          : await discoverEncryptedFiles(config);

        if (files.length === 0) {
          console.log("No encrypted files to decrypt.");
          return;
        }

        let hasErrors = false;
        for (const file of files) {
          const result = await decryptFile(file, config, runner, {
            dryRun,
            outputDir,
            ageKey,
          });
          if (result.success) {
            console.log(
              `${dryRun ? "[dry-run] decrypted" : "decrypted"}: ${file} -> ${result.outputPath}`,
            );
          } else {
            console.error(`error decrypting ${file}: ${result.error}`);
            hasErrors = true;
          }
        }

        if (hasErrors) Deno.exit(ExitCode.DriftOrValidation);
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  secretsCmd.command("deploy", "Decrypt and deploy stacks with secret values.")
    .arguments("[stack:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .option("--age-key <key:string>", "Explicit age key.")
    .action(async (options: Record<string, unknown>, stackArg?: string) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const ageKey = options.ageKey as string | undefined;

        let config: ResolvedConfig;
        try {
          config = await resolveConfig({ profile, cwd: Deno.cwd() });
        } catch (err: unknown) {
          console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
          Deno.exit(ExitCode.MissingDependency);
        }

        const runner = new RealProcessRunner(dryRun ?? false);

        const sopsOk = await runner.which("sops");
        const dockerOk = await runner.which("docker");
        if (!sopsOk && !dryRun) {
          console.error("error: sops is not installed. Install: https://github.com/getsops/sops");
          Deno.exit(ExitCode.MissingDependency);
        }
        if (!dockerOk && !dryRun) {
          console.error("error: docker is not installed or not on PATH.");
          Deno.exit(ExitCode.MissingDependency);
        }

        const stacks: string[] = stackArg ? [stackArg] : config.base.stack.names;

        if (stacks.length === 0) {
          console.log("No stacks configured. Use `stackctl init` to set up.");
          return;
        }

        let hasErrors = false;
        for (const stack of stacks) {
          const result = await deploySecrets(stack, config, runner, {
            dryRun,
            ageKey,
          });

          if (result.success) {
            const prefix = dryRun ? "[dry-run] deployed" : "deployed";
            console.log(`${prefix} ${result.secrets.length} secrets for stack: ${stack}`);
            for (const secret of result.secrets) {
              console.log(`  ${dryRun ? "[dry-run]" : "✓"} ${secret}`);
            }
          } else {
            console.error(`error deploying secrets for ${stack}: ${result.error}`);
            hasErrors = true;
          }
        }

        if (hasErrors) Deno.exit(ExitCode.DriftOrValidation);
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  secretsCmd.command("clean", "Remove plaintext .env files that have encrypted counterparts.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;

        let config: ResolvedConfig;
        try {
          config = await resolveConfig({ profile, cwd: Deno.cwd() });
        } catch (err: unknown) {
          console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
          Deno.exit(ExitCode.MissingDependency);
        }

        const repoRoot = config.base.repoRoot ?? Deno.cwd();
        const runner = new RealProcessRunner(dryRun ?? false);

        const result = await cleanTempFiles(repoRoot, runner, { dryRun });

        if (result.removedFiles.length === 0) {
          console.log("Nothing to clean.");
        } else {
          const prefix = dryRun ? "[dry-run] would remove" : "removed";
          for (const f of result.removedFiles) {
            console.log(`${prefix}: ${f}`);
          }
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  secretsCmd.command("check", "Check secrets tooling availability.")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;

        let config: ResolvedConfig | undefined;
        try {
          config = await resolveConfig({ profile, cwd: Deno.cwd() });
        } catch {
          // Config is optional for the tooling check
        }

        const runner = new RealProcessRunner(false);
        const status = await checkTooling(runner);

        console.log("Secrets Tooling Status:");
        console.log(`  sops: ${status.sops.available ? "✓ available" : "✗ not found"}`);
        if (status.sops.version) {
          console.log(`    version: ${status.sops.version}`);
        }
        console.log(`  age:  ${status.age.available ? "✓ available" : "✗ not found"}`);
        if (status.age.version) {
          console.log(`    version: ${status.age.version}`);
        }

        if (config?.base.secrets) {
          console.log("\nConfig:");
          if (config.base.secrets.ageKeyFile) {
            console.log(`  ageKeyFile: ${config.base.secrets.ageKeyFile}`);
          }
          if (config.base.secrets.encryptedFileName) {
            console.log(`  encryptedFileName: ${config.base.secrets.encryptedFileName}`);
          }
        }

        const bothAvailable = status.sops.available && status.age.available;
        if (!bothAvailable) {
          console.error(
            "\nOne or more secrets tools are missing. Install them to use secrets commands.\n" +
              "  sops: https://github.com/getsops/sops\n" +
              "  age:  https://github.com/FiloSottile/age",
          );
          Deno.exit(ExitCode.MissingDependency);
        }

        console.log("\nAll secrets tooling is available.");
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- env (issue #14) ---
  const envCmd = cli.command(
    "env",
    "Manage .env files and profile env presets.",
  );

  // env list
  envCmd.command("list", "List discovered .env.example files and their status.")
    .option("--profile <name:string>", "Use a specific profile for variant lookup.")
    .option("--json", "Output machine-readable JSON.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const jsonOutput = options.json as boolean | undefined;
        const cwd = Deno.cwd();
        const examples = await discoverEnvExamples(cwd, { profile });

        if (jsonOutput) {
          console.log(JSON.stringify(examples, null, 2));
        } else {
          if (examples.length === 0) {
            console.log("No .env.example files found.");
            return;
          }
          console.log(`${"Service".padEnd(30)} ${"Status".padEnd(12)} Path`);
          console.log(`${"-".repeat(30)} ${"-".repeat(12)} ${"-".repeat(40)}`);
          for (const ex of examples) {
            const icon = ex.status === "present" ? "✓" : ex.status === "outdated" ? "~" : "✗";
            console.log(
              `${ex.serviceName.padEnd(30)} ${(icon + " " + ex.status).padEnd(12)} ${ex.envPath}`,
            );
          }
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // env create
  envCmd.command("create", "Create .env files from .env.example templates.")
    .arguments("[name:string]")
    .option("--profile <name:string>", "Use a specific profile for variant lookup.")
    .option("--force", "Overwrite existing .env files.")
    .option("--dry-run", "Print planned changes without writing.")
    .option("--json", "Output machine-readable JSON.")
    .action(async (options: Record<string, unknown>, name?: string) => {
      try {
        const profile = options.profile as string | undefined;
        const force = options.force as boolean | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const jsonOutput = options.json as boolean | undefined;
        const cwd = Deno.cwd();

        const result = await batchCreateEnvs(cwd, { profile, force, dryRun, serviceName: name });

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (dryRun) {
            for (const c of result.created) console.log(`[dry-run] would create: ${c.path}`);
            for (const s of result.skipped) {
              console.log(`[dry-run] would skip: ${s.path} (${s.reason})`);
            }
          } else {
            for (const c of result.created) console.log(`created: ${c.path}`);
            for (const s of result.skipped) console.log(`skipped: ${s.path} (${s.reason})`);
          }
          for (const e of result.errors) console.error(`error: ${e.path}: ${e.message}`);
        }
        if (result.errors.length > 0) Deno.exit(ExitCode.DriftOrValidation);
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // env diff
  envCmd.command("diff", "Show differences between .env.example and .env files.")
    .arguments("[name:string]")
    .option("--profile <name:string>", "Use a specific profile for variant lookup.")
    .option("--json", "Output machine-readable JSON.")
    .action(async (options: Record<string, unknown>, name?: string) => {
      try {
        const profile = options.profile as string | undefined;
        const jsonOutput = options.json as boolean | undefined;
        const cwd = Deno.cwd();

        const examples = await discoverEnvExamples(cwd, { profile });
        const filtered = name
          ? examples.filter((e) =>
            e.serviceName === name || basename(dirname(e.examplePath)) === name
          )
          : examples;

        if (filtered.length === 0) {
          console.log(
            jsonOutput ? "[]" : `No .env.example files found${name ? ` matching "${name}"` : ""}.`,
          );
          return;
        }

        const diffs: EnvDiff[] = [];
        for (const ex of filtered) {
          diffs.push(await diffEnvFiles(ex.examplePath, ex.envPath, ex.serviceName));
        }

        if (jsonOutput) {
          console.log(JSON.stringify(diffs, null, 2));
        } else {
          for (const diff of diffs) {
            console.log(`\n=== ${diff.serviceName} ===`);
            if (diff.onlyInExample.length > 0) {
              console.log("  Missing from .env:");
              for (const k of diff.onlyInExample) console.log(`    - ${k}`);
            }
            if (diff.onlyInEnv.length > 0) {
              console.log("  Only in .env (not in example):");
              for (const k of diff.onlyInEnv) console.log(`    + ${k}`);
            }
            if (diff.common.length > 0) console.log(`  Common (${diff.common.length} keys)`);
            if (diff.onlyInExample.length === 0 && diff.onlyInEnv.length === 0) {
              console.log("  (no differences)");
            }
          }
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- plan (issue #15) ---
  cli.command("plan", "Produce a deterministic plan of what an operation would do.")
    .arguments("<operation:string>")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--override <files:string>", "Comma-separated list of override files.")
    .option("--json", "Output machine-readable JSON.")
    .action(() => {
      console.error("plan: not yet implemented (issue #15)");
      Deno.exit(1);
    });

  // --- completions (issue #10) ---
  const completionsCmd = cli.command("completions", "Generate shell completion scripts.");
  completionsCmd.command("bash", "Generate bash completion script.")
    .action(() => {
      console.error("completions bash: not yet implemented (issue #10)");
      Deno.exit(1);
    });
  completionsCmd.command("zsh", "Generate zsh completion script.")
    .action(() => {
      console.error("completions zsh: not yet implemented (issue #10)");
      Deno.exit(1);
    });
  completionsCmd.command("fish", "Generate fish completion script.")
    .action(() => {
      console.error("completions fish: not yet implemented (issue #10)");
      Deno.exit(1);
    });

  return cli as unknown as Command;
}

/**
 * Append stackctl-specific entries to .gitignore.
 */
async function appendGitignore(cwd: string): Promise<void> {
  const gitignorePath = join(cwd, ".gitignore");
  const entries = [
    "# stackctl generated files",
    ".stackctl.local",
    ".stackctl.local.*",
    ".env",
    ".env.*",
    "!.env.example",
  ];

  let existing = "";
  if (await exists(gitignorePath)) {
    existing = await Deno.readTextFile(gitignorePath);
    if (!existing.endsWith("\n")) existing += "\n";
  }

  // Check which entries are already present
  const newEntries = entries.filter((e) => !existing.includes(e));
  if (newEntries.length === 0) {
    console.log(".gitignore already up to date");
    return;
  }

  const toAppend = (existing ? "\n" : "") + newEntries.join("\n") + "\n";
  await Deno.writeTextFile(gitignorePath, existing + toAppend);
  console.log(`updated: ${gitignorePath}`);
}

import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { VERSION } from "../version.ts";
import { initConfig } from "../config/mod.ts";
import { resolveConfig } from "../config/mod.ts";
import { ExitCode } from "../config/types.ts";
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
import {
  dockerInfo,
  dockerServiceLogs,
  dockerStackPs,
  dockerStackRm,
  dockerStackServices,
  dockerSwarmStatus,
} from "../docker/mod.ts";

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
  cli.command(
    "init",
    "Generate a commented .stackctl configuration file. Detects repository layout to infer stack names, profiles, and default paths. Supports presets, profiles, and dry-run preview.",
  )
    .option("--detect", "Detect repository layout and infer config values.")
    .option("--preset <name:string>", "Use a preset configuration template.")
    .option("--profile <name:string>", "Create an additional profile config file.")
    .option("--write-gitignore", "Append .stackctl.local and .env to .gitignore.")
    .option("--force", "Overwrite existing .stackctl file.")
    .option("--dry-run", "Print the config that would be written without writing.")
    .example("Generate a default config interactively", "stackctl init")
    .example("Detect and preview config before writing", "stackctl init --detect --dry-run")
    .example("Create a staging profile config", "stackctl init --profile staging --force")
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
  cli.command(
    "generate",
    "Generate canonical Docker Compose stack files from per-service compose sources. Resolves includes and merges per-service files into unified stacks ready for deployment. Supports file overrides, stack filtering, and dry-run output.",
  )
    .option("--dry-run", "Print generated output without writing files.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to generate.")
    .option("--output-dir <path:string>", "Write generated stacks to a specific directory.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option(
      "--override <files:string>",
      "Comma-separated list of override files to apply.",
    )
    .example("Generate all stacks for the current profile", "stackctl generate")
    .example(
      "Preview generated output without writing",
      "stackctl generate --dry-run --stacks web,api",
    )
    .example(
      "Generate with overrides for production",
      "stackctl generate --profile production --override override.prod.yml",
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
    "Resolve ${VAR} environment variable placeholders in generated stack files. " +
      "Reads service-local .env files and interpolates variables into stack YAML before deployment. " +
      "Supports strict mode for unreferenced variables and custom output directories.",
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
    .example("Render all stacks for the current profile", "stackctl render")
    .example(
      "Preview rendered output in strict mode",
      "stackctl render --dry-run --strict --stacks web,api",
    )
    .example(
      "Render to a custom output directory",
      "stackctl render --output-dir ./rendered --profile production",
    )
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
  cli.command(
    "up",
    "Deploy one or more stacks to a Docker Swarm cluster. Runs the full generate-render-deploy pipeline with support for dry-run preview, detached deployment, service pruning, and log following.",
  )
    .option("--follow-logs", "Follow logs after deploy.")
    .option("--dry-run", "Print planned actions without executing.")
    .option("--detach", "Exit immediately without waiting for services to converge.")
    .option("--prune", "Prune obsolete services.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to deploy.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--override <files:string>", "Comma-separated list of override files.")
    .example("Deploy all stacks for the current profile", "stackctl up")
    .example("Dry-run to preview what would be deployed", "stackctl up --dry-run")
    .example("Deploy a specific stack and follow logs", "stackctl up --stacks web --follow-logs")
    .example("Deploy in detached mode with pruning", "stackctl up --detach --prune")
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
  cli.command(
    "down",
    "Remove stacks from a Docker Swarm cluster. Prompts for confirmation unless --yes is passed. Supports dry-run to preview which stacks would be removed and stack filtering to target specific stacks.",
  )
    .option("--yes", "Skip confirmation prompt.")
    .option("--dry-run", "Print planned actions without executing.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to remove.")
    .option("--profile <name:string>", "Use a specific profile.")
    .example("Remove all stacks with confirmation", "stackctl down")
    .example("Remove specific stacks without confirmation", "stackctl down --stacks web,api --yes")
    .example("Preview which stacks would be removed", "stackctl down --dry-run")
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
  cli.command(
    "status",
    "Show service and task status for deployed stacks. Outputs human-readable summaries by default or machine-readable JSON with the --json flag. Filter by specific stacks to narrow the scope.",
  )
    .option("--json", "Output JSON machine-readable status.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--profile <name:string>", "Use a specific profile.")
    .example("Show status for all deployed stacks", "stackctl status")
    .example("Show JSON status for specific stacks", "stackctl status --stacks web,api --json")
    .example("Show human-readable status for a profile", "stackctl status --profile production")
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
  cli.command(
    "logs",
    "Stream logs from Docker Swarm services in real time. Accepts explicit service names as arguments or discovers services from deployed stacks. Supports following logs continuously and tailing a specified number of recent lines.",
  )
    .arguments("[services...:string]")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--follow", "Follow log output (default: true).")
    .option("--tail <n:number>", "Number of lines from end (default: all).")
    .example("Stream logs for all services in the default profile", "stackctl logs")
    .example("Tail recent logs for specific stacks", "stackctl logs --stacks web,api --tail 50")
    .example("Follow logs for a specific service by name", "stackctl logs --follow web-prod_app")
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
  cli.command(
    "sync",
    "Run the full lifecycle pipeline: generate, render, and deploy stacks. Equivalent to running generate, render, and up in sequence with error propagation at each stage. Supports all options from each subcommand for targeted or filtered deployments.",
  )
    .option("--dry-run", "Preview sync without deploying.")
    .option("--config <path:string>", "Explicit config file path.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--override <files:string>", "Comma-separated list of override files.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--prune", "Prune obsolete services on deploy.")
    .option("--detach", "Exit immediately without waiting for services to converge.")
    .example("Sync all stacks for the default profile", "stackctl sync")
    .example("Preview the full sync pipeline", "stackctl sync --dry-run --prune")
    .example(
      "Sync specific stacks for production",
      "stackctl sync --stacks web,api --profile production",
    )
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
  cli.command(
    "doctor",
    "Check system and project health by verifying Docker daemon, Swarm mode, config validity, and optional secrets tooling. Reports issues with clear remediation steps to get the environment ready for deployment.",
  )
    .option("--fix-volumes", "Create missing external volumes.")
    .option("--check-secrets", "Also check for secrets tooling (sops, age).")
    .option("--profile <name:string>", "Use a specific profile.")
    .example("Run all health checks", "stackctl doctor")
    .example("Check secrets tooling availability", "stackctl doctor --check-secrets")
    .example("Run checks with a specific profile", "stackctl doctor --profile staging")
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
  cli.command(
    "reload",
    "Re-render and redeploy only changed stacks without tearing them down. Generates and renders only modified stacks, then triggers a rolling update in Docker Swarm. Supports force service updates, stack filtering, and skipping the generation step to speed up iterations.",
  )
    .option("--skip-generate", "Only re-render and re-deploy, do not regenerate stacks.")
    .option("--follow-logs", "Stream logs for deployed stacks after reload.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to reload.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--config <path:string>", "Explicit path to .stackctl config file.")
    .option("--override <files:string>", "Comma-separated list of override files to apply.")
    .option("--dry-run", "Compare and report planned actions without executing.")
    .example("Reload all stacks with rolling updates", "stackctl reload")
    .example(
      "Force update services for a specific stack",
      "stackctl reload --stacks web --follow-logs",
    )
    .example("Skip generation and preview reload", "stackctl reload --skip-generate --dry-run")
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

        if (results.some((r) => r.action === "error")) {
          Deno.exit(ExitCode.DriftOrValidation);
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // --- secrets (issue #7) ---
  const secretsCmd = cli.command(
    "secrets",
    "Manage encrypted secrets using SOPS and age. Encrypt, decrypt, deploy, and clean secrets across services. Requires sops and age to be installed on the system PATH.",
  );
  secretsCmd.command(
    "encrypt",
    "Encrypt plaintext .env files to encrypted output using sops with age keys. Accepts optional service names as arguments to limit which files are processed.",
  )
    .arguments("[services...:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .example("Encrypt all service .env files", "stackctl secrets encrypt")
    .example(
      "Encrypt specific services with dry-run preview",
      "stackctl secrets encrypt web api --dry-run",
    )
    .action(() => {
      console.error("secrets encrypt: not yet implemented (issue #7)");
      Deno.exit(1);
    });
  secretsCmd.command(
    "decrypt",
    "Decrypt sops-encrypted .env files back to plaintext for local development and debugging. Accepts optional service names to limit the scope.",
  )
    .arguments("[services...:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .example("Decrypt all service .env files", "stackctl secrets decrypt")
    .example("Decrypt specific services for debugging", "stackctl secrets decrypt web --dry-run")
    .action(() => {
      console.error("secrets decrypt: not yet implemented (issue #7)");
      Deno.exit(1);
    });
  secretsCmd.command(
    "deploy",
    "Decrypt secrets and deploy stacks with the resolved values. Runs the decryption step followed by the sync pipeline. Supports dry-run mode for preview.",
  )
    .arguments("[services...:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .example("Decrypt and deploy all stacks", "stackctl secrets deploy")
    .example("Deploy specific services with secrets", "stackctl secrets deploy web api --dry-run")
    .action(() => {
      console.error("secrets deploy: not yet implemented (issue #7)");
      Deno.exit(1);
    });
  secretsCmd.command(
    "clean",
    "Remove plaintext .env files that have encrypted counterparts. Helps prevent accidental commits of unencrypted secrets. Supports dry-run to preview which files would be removed.",
  )
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .example("Clean all plaintext .env files with encrypted counterparts", "stackctl secrets clean")
    .example("Preview which files would be removed", "stackctl secrets clean --dry-run")
    .action(() => {
      console.error("secrets clean: not yet implemented (issue #7)");
      Deno.exit(1);
    });
  secretsCmd.command(
    "check",
    "Verify that sops and age are installed and accessible on the system PATH. Reports version information and helps diagnose secrets tooling setup issues.",
  )
    .option("--profile <name:string>", "Use a specific profile.")
    .example("Check that sops and age are available", "stackctl secrets check")
    .action(() => {
      console.error("secrets check: not yet implemented (issue #7)");
      Deno.exit(1);
    });

  // --- env (issue #14) ---
  cli.command(
    "env",
    "Manage .env files and profile env presets. List discovered services and their .env status with --list, create missing .env files from .env.example templates with --recreate, and materialize profile presets into concrete .env files with --materialize.",
  )
    .option("--list", "List discovered services and .env status.")
    .option("--recreate", "Create missing .env files from .env.example.")
    .option("--force", "Overwrite existing .env files.")
    .option("--yes", "Skip confirmation.")
    .option("--dry-run", "Print planned changes without writing.")
    .option("--paths <paths:string>", "Comma-separated list of service paths.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--from-profile <name:string>", "Materialize env from a profile preset.")
    .option("--materialize", "Materialize profile preset env values.")
    .example("List all services and their .env status", "stackctl env --list")
    .example("Create missing .env files from templates", "stackctl env --recreate --dry-run")
    .example(
      "Materialize env from a profile preset",
      "stackctl env --materialize --from-profile production",
    )
    .action(() => {
      console.error("env: not yet implemented (issue #14)");
      Deno.exit(1);
    });

  // --- plan (issue #15) ---
  cli.command(
    "plan",
    "Produce a deterministic plan of what a given operation would do without executing it. Shows the sequence of actions that would be performed for up, down, sync, or other operations. Supports JSON output for machine consumption and stack filtering.",
  )
    .arguments("<operation:string>")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--override <files:string>", "Comma-separated list of override files.")
    .option("--json", "Output machine-readable JSON.")
    .example("Plan what 'up' would deploy", "stackctl plan up")
    .example("Plan a sync with stack filtering", "stackctl plan sync --stacks web,api")
    .example("Plan a down operation with JSON output", "stackctl plan down --json")
    .action(() => {
      console.error("plan: not yet implemented (issue #15)");
      Deno.exit(1);
    });

  // --- completions (issue #10) ---
  cli.command("completions", new CompletionsCommand())
    .description(
      "Generate shell completion scripts for bash, zsh, fish, and PowerShell.\n" +
        "Pipe the output to the appropriate location for your shell to enable tab-completion.",
    )
    .example("Generate bash completions and source them", "stackctl completions bash")
    .example("Generate zsh completions", "stackctl completions zsh")
    .example("Generate fish completions", "stackctl completions fish")
    .example("Generate PowerShell completions", "stackctl completions powershell");

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

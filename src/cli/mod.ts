import { Command } from "@cliffy/command";
import { VERSION } from "../version.ts";
import { initConfig } from "../config/mod.ts";
import { resolveConfig } from "../config/mod.ts";
import { ExitCode } from "../config/types.ts";
import { generateStacks } from "../compose/mod.ts";
import { discoverComposeFiles } from "../compose/discover.ts";
import type { ComposeData, GenerateOptions } from "../compose/mod.ts";
import { basename, dirname, join, resolve } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { renderStack } from "../render/mod.ts";
import { RealProcessRunner } from "../process/runner.ts";
import { sync as syncValidation } from "../compose/sync.ts";
import {
  dockerComposeConfig,
  dockerInfo,
  dockerServiceLogs,
  dockerStackDeploy,
  dockerStackPs,
  dockerStackRm,
  dockerStackServices,
  dockerSwarmStatus,
} from "../docker/mod.ts";
import {
  batchCreateEnvs,
  diffEnvFiles,
  discoverEnvExamples,
  envDoctor,
  getEnvStatusList,
  materializeEnvFromProfile,
} from "../env/mod.ts";
import type { EnvDiff } from "../env/types.ts";
import { reloadStacks } from "../compose/reload.ts";
import type { ReloadResult } from "../compose/reload.ts";
import { planOperation } from "../compose/plan.ts";
import type { PlanResult } from "../compose/plan.ts";
import { CompletionsCommand } from "@cliffy/command/completions";
import {
  checkTooling,
  cleanDecryptedEnvFiles,
  decryptEnvFile,
  deployPipeline,
  encryptEnvFile,
  ensureTooling,
  findEncryptedEnvFiles,
} from "../secrets/mod.ts";

let exitCode = 0;

/**
 * Parse and execute CLI commands.
 * Returns the process exit code (0 for success).
 */
export async function main(args: string[]): Promise<number> {
  try {
    const cmd = await buildCli().parse(args);
    if (cmd instanceof Error) {
      exitCode = 1;
    }
    return exitCode;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/**
 * Best-effort stack-name completion provider.
 * Returns stack names discovered from the repository.
 * Never throws — returns an empty array if config or discovery fails.
 */
async function completeStackNames(): Promise<string[]> {
  try {
    const config = await resolveConfig({ profile: undefined, cwd: Deno.cwd() });
    const repoRoot = config.base.repoRoot ?? Deno.cwd();
    const discovery = await discoverComposeFiles({ repoRoot });
    return Object.keys(discovery.stacks);
  } catch {
    return [];
  }
}

/**
 * Build the stackctl CLI command tree.
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
    exitCode = 0;
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
        exitCode = ExitCode.UserConfigError;
        return;
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
          exitCode = ExitCode.DriftOrValidation;
          return;
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
        exitCode = ExitCode.UnexpectedError;
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
          exitCode = ExitCode.DriftOrValidation;
          return;
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
          exitCode = ExitCode.DriftOrValidation;
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        exitCode = ExitCode.UnexpectedError;
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

        const config = await resolveConfig({ profile, cwd: Deno.cwd() });
        const repoRoot = config.base.repoRoot ?? Deno.cwd();

        const runner = new RealProcessRunner(dryRun ?? false);

        // 1. Discover or use specified stacks
        const discovery = await discoverComposeFiles({ repoRoot });
        const targetStacks = stacks ?? Object.keys(discovery.stacks);

        if (targetStacks.length === 0) {
          console.error("error: No stacks discovered.");
          exitCode = ExitCode.DriftOrValidation;
          return;
        }

        // 2. Generate stacks in memory
        const genResult = await generateStacks({
          stacks: targetStacks,
          repoRoot,
          outputDir: undefined,
          dryRun: true,
          overrides: overrides,
        });

        for (const w of genResult.warnings) console.error(`warning: ${w}`);
        for (const e of genResult.errors) console.error(`error: ${e}`);

        if (genResult.errors.length > 0) {
          exitCode = ExitCode.DriftOrValidation;
          return;
        }

        // 3. Render and deploy each stack
        let deployFailed = false;
        const deployedStacks: string[] = [];

        for (const [stackName, yamlContent] of Object.entries(genResult.generated)) {
          try {
            const parsed = parseYaml(yamlContent) as ComposeData;
            const renderResult = await renderStack({
              data: parsed,
              projectDir: repoRoot,
              repoRoot,
              strict: true,
            });

            for (const w of renderResult.warnings) {
              console.error(`warning: [${stackName}] ${w}`);
            }

            if (dryRun) {
              console.log(`[dry-run] would deploy: ${stackName}`);
              deployedStacks.push(stackName);
              continue;
            }

            // Write rendered YAML to temp file for docker stack deploy
            const tempFile = await Deno.makeTempFile({ suffix: ".yml" });
            try {
              const yaml = stringifyYaml(renderResult.data, {
                indent: 2,
                lineWidth: 120,
                noRefs: true,
              } as Record<string, unknown>);
              await Deno.writeTextFile(tempFile, yaml);

              const deployResult = await dockerStackDeploy(runner, stackName, tempFile, {
                prune,
                detach,
                resolveImage: "always",
              });

              if (deployResult.success) {
                console.log(`Deployed: ${stackName}`);
                deployedStacks.push(stackName);
              } else {
                console.error(
                  `error deploying ${stackName}: ${deployResult.stderr || "failed"}`,
                );
                deployFailed = true;
              }
            } finally {
              try {
                await Deno.remove(tempFile);
              } catch { /* ignore */ }
            }
          } catch (err: unknown) {
            console.error(
              `error: [${stackName}] ${err instanceof Error ? err.message : String(err)}`,
            );
            deployFailed = true;
          }
        }

        if (deployFailed) {
          exitCode = ExitCode.DriftOrValidation;
          return;
        }

        // 4. Follow logs after deploy if requested
        if (followLogs && !dryRun && deployedStacks.length > 0) {
          console.log("\n--- Following logs (Ctrl-C to stop) ---");
          const logRunner = new RealProcessRunner(false);
          for (const stackName of deployedStacks) {
            try {
              const svcResult = await dockerStackServices(logRunner, stackName);
              if (svcResult.success) {
                const lines = svcResult.stdout.trim().split("\n").filter(Boolean);
                for (const line of lines) {
                  try {
                    const svc = JSON.parse(line);
                    if (svc.Name) {
                      console.log(`\n=== ${svc.Name} ===`);
                      await dockerServiceLogs(logRunner, svc.Name, {
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
        exitCode = ExitCode.UnexpectedError;
      }
    });

  // --- down (issue #6) ---
  cli.command(
    "down",
    "Remove Docker Swarm stacks from the cluster.\n" +
      "WARNING: This is a destructive operation. Running services, networks,\n" +
      "and associated resources will be removed. Use --dry-run to preview\n" +
      "without executing, and --yes to skip the confirmation prompt.",
  )
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
        exitCode = ExitCode.UnexpectedError;
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
        exitCode = ExitCode.UnexpectedError;
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
        exitCode = ExitCode.UnexpectedError;
      }
    });

  // --- sync (issue #6) ---
  cli.command("sync", "Validate that generated stacks match committed stack files.")
    .option("--quiet", "Suppress diff output.")
    .option("--non-interactive", "Skip confirmation; exit 1 on drift.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const quiet = options.quiet as boolean | undefined;
        const nonInteractive = options.nonInteractive as boolean | undefined;
        const stacks = options.stacks
          ? (options.stacks as string).split(",").map((s: string) => s.trim())
          : undefined;

        const result = await syncValidation({
          stacks,
          profile,
          quiet,
          nonInteractive,
        });

        for (const w of result.warnings) console.error(`warning: ${w}`);
        for (const e of result.errors) console.error(`error: ${e}`);

        if (!result.match) {
          if (!quiet) {
            for (const [stackName, diff] of Object.entries(result.diffs)) {
              if (diff) {
                console.log(`\n--- ${stackName} diff ---`);
                console.log(diff);
              }
            }
          }
          exitCode = ExitCode.DriftOrValidation;
        } else {
          console.log("Sync OK: generated stacks match committed files.");
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        exitCode = ExitCode.UnexpectedError;
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
          checks.push("  \u2713 Docker is running");
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
          checks.push(
            `  \u2713 Swarm mode active${swarm.nodeId ? ` (node: ${swarm.nodeId})` : ""}`,
          );
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
        checks.push(`  \u2713 Config resolved (profile: ${config.profile ?? "default"})`);
        checks.push(`    Project: ${config.base.project || "(unnamed)"}`);
        checks.push(`    Stack directory: ${config.base.stack.directory}`);
        checks.push(`    Stack names: ${config.base.stack.names.join(", ") || "(none)"}`);

        // Check override files referenced in config exist
        for (const override of config.overrides) {
          const existsInFs = await exists(override.path);
          if (!existsInFs) {
            issues.push(`Override file not found: ${override.path}`);
          } else {
            checks.push(`  \u2713 Override: ${override.path}`);
          }
        }

        // Render path validation
        checks.push("Render path...");
        const repoRootPath = config.base.repoRoot ?? Deno.cwd();
        const renderDir = join(repoRootPath, config.base.render.outputDirectory);
        try {
          await Deno.stat(renderDir);
          checks.push(`  \u2713 Render directory exists: ${renderDir}`);
        } catch {
          try {
            await Deno.mkdir(renderDir);
            checks.push(`  \u2713 Render directory created (and removed): ${renderDir}`);
            await Deno.remove(renderDir);
          } catch {
            issues.push(`Render directory not creatable: ${renderDir}`);
          }
        }

        // Validate stack files with docker compose config
        checks.push("Compose file validation...");
        for (const stackName of config.base.stack.names) {
          const composeFile = join(
            repoRootPath,
            config.base.stack.directory,
            `${stackName}.yml`,
          );
          try {
            await Deno.stat(composeFile);
          } catch {
            issues.push(`Stack file not found: ${composeFile}`);
            continue;
          }

          try {
            const composeResult = await dockerComposeConfig(runner, composeFile);
            if (composeResult.success) {
              checks.push(`  \u2713 Stack "${stackName}" compose file is valid`);
            } else {
              issues.push(
                `Stack "${stackName}" compose file has errors:\n${composeResult.stderr}`,
              );
            }
          } catch {
            issues.push(`docker compose config failed for stack "${stackName}"`);
          }
        }
      } catch (err: unknown) {
        issues.push(
          `Config error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 4. Check sops/age available (if secrets configured)
      if (checkSecrets) {
        checks.push("Secrets tooling...");
        const sopsOk = await runner.which("sops");
        const ageOk = await runner.which("age");
        if (sopsOk) {
          checks.push("  \u2713 sops available");
        } else {
          issues.push("sops not found on PATH. Install: https://github.com/getsops/sops");
        }
        if (ageOk) {
          checks.push("  \u2713 age available");
        } else {
          issues.push("age not found on PATH. Install: https://github.com/FiloSottile/age");
        }
      }

      // 5. Check for external volumes (if --fix-volumes)
      if (options.fixVolumes as boolean | undefined) {
        checks.push("External volumes: not yet implemented");
      }

      // Output results
      console.log("=== stackctl doctor ===\n");
      for (const c of checks) console.log(c);
      console.log("");

      if (issues.length > 0) {
        console.error("Issues found:");
        for (const issue of issues) console.error(`  \u2717 ${issue}`);
        console.error(`\n${issues.length} issue(s) found.`);
        exitCode = ExitCode.MissingDependency;
      } else {
        console.log("All checks passed.");
      }
    });

  // --- reload (issue #9) ---
  //
  // Option precedence (highest to lowest):
  //   CLI flag > active profile config > base config > built-in default
  //
  // Safety: reload only deploys/updates. It never schedules `docker stack rm`,
  // `docker network rm`, or `docker volume rm`.
  cli.command("reload", "Re-render and redeploy stacks without tearing down.")
    .option("--skip-generate", "Only re-render and re-deploy, do not regenerate stacks.")
    .option(
      "--skip-unchanged",
      "Only redeploy stacks whose rendered output changed (default: always deploy).",
    )
    .option(
      "--force-service-update",
      "Force `docker service update --force` on every service after deploy.",
    )
    .option(
      "--no-force-service-update",
      "Disable force service update (overrides config).",
    )
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
        const skipUnchanged = options.skipUnchanged as boolean | undefined;
        const followLogs = options.followLogs as boolean | undefined;
        const configPath = options.config as string | undefined;

        // forceServiceUpdate: CLI false > CLI true > absent (uses config default)
        const forceServiceUpdate = options.forceServiceUpdate !== undefined
          ? (options.forceServiceUpdate as boolean)
          : options.noForceServiceUpdate !== undefined
          ? false
          : undefined;

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
          skipUnchanged,
          dryRun,
          followLogs,
          forceServiceUpdate,
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
  const secretsCmd = cli.command("secrets", "Manage SOPS/age encrypted secrets (dotenv).");

  // secrets encrypt
  secretsCmd.command("encrypt", "Encrypt .env files to .env.enc using SOPS+age.")
    .arguments("[files...:string]")
    .option("--dry-run", "Print planned actions without executing.")
    .action(async (options: Record<string, unknown>, ...fileArgs: string[]) => {
      try {
        if (options.dryRun) {
          console.log("[dry-run] Would encrypt .env files using SOPS (dotenv format)");
        }

        const runner = new RealProcessRunner(false);

        // Ensure tooling before any mutation
        await ensureTooling(runner);

        // Determine files to encrypt
        let files: string[] = fileArgs;
        if (files.length === 0) {
          // Discover .env files that don't have .enc counterparts
          const encFiles = await findEncryptedEnvFiles(Deno.cwd());
          const encFileDirs = new Set(
            encFiles.map((f) => f.replace(/\.enc$/, "")),
          );

          // Walk for .env files
          const { walk } = await import("@std/fs");
          const allEnv: string[] = [];
          for await (
            const entry of walk(Deno.cwd(), {
              includeDirs: false,
              includeFiles: true,
              skip: [/(^|\/)\.(git|rendered)$/, /node_modules/],
            })
          ) {
            if (entry.name === ".env") {
              allEnv.push(entry.path);
            }
          }
          // Only include .env files that don't have .enc counterparts yet
          files = allEnv.filter((f) => !encFileDirs.has(f));
        }

        if (files.length === 0) {
          console.log("No .env files to encrypt.");
          return;
        }

        let hasErrors = false;
        for (const file of files) {
          const result = await encryptEnvFile(file, runner);
          if (result.success) {
            console.log(`encrypted: ${file} -> ${result.outputPath}`);
          } else {
            console.error(`error encrypting ${file}: ${result.error}`);
            hasErrors = true;
          }
        }

        if (hasErrors) Deno.exit(ExitCode.DriftOrValidation);
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.MissingDependency);
      }
    });

  // secrets decrypt
  secretsCmd.command("decrypt", "Decrypt .env.enc files to .env using SOPS+age.")
    .arguments("[files...:string]")
    .option("--dry-run", "Print planned actions without executing.")
    .action(async (options: Record<string, unknown>, ...fileArgs: string[]) => {
      try {
        const dryRun = options.dryRun as boolean | undefined;

        if (dryRun) {
          console.log("[dry-run] Would decrypt .env.enc files using SOPS (dotenv format)");
        }

        const runner = new RealProcessRunner(dryRun ?? false);

        // Ensure tooling before any mutation
        if (!dryRun) {
          await ensureTooling(runner);
        }

        // Determine files to decrypt
        let files: string[] = fileArgs;
        if (files.length === 0) {
          files = await findEncryptedEnvFiles(Deno.cwd());
        }

        if (files.length === 0) {
          console.log("No .env.enc files to decrypt.");
          return;
        }

        let hasErrors = false;
        for (const file of files) {
          const result = await decryptEnvFile(file, runner);
          if (result.success) {
            console.log(
              `${dryRun ? "[dry-run] decrypted" : "decrypted"}: ${file} -> ${result.outputPath}`,
            );
            for (const w of result.warnings) {
              console.error(`warning: ${w}`);
            }
          } else {
            console.error(`error decrypting ${file}: ${result.error}`);
            hasErrors = true;
          }
        }

        if (hasErrors) Deno.exit(ExitCode.DriftOrValidation);
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.MissingDependency);
      }
    });

  // secrets deploy
  secretsCmd.command("deploy", "Decrypt env files and deploy stacks.")
    .arguments("[stacks...:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .action(async (options: Record<string, unknown>, ...stackArgs: string[]) => {
      try {
        const profile = options.profile as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;

        const result = await deployPipeline({
          cwd: Deno.cwd(),
          profile,
          stacks: stackArgs.length > 0 ? stackArgs : undefined,
          dryRun,
        });

        for (const w of result.warnings) console.error(`warning: ${w}`);
        for (const e of result.errors) console.error(`error: ${e}`);

        if (result.errors.length > 0) {
          Deno.exit(ExitCode.DriftOrValidation);
        }

        if (result.warnings.length === 0) {
          console.log("Deploy pipeline completed successfully.");
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        Deno.exit(ExitCode.UnexpectedError);
      }
    });

  // secrets clean
  secretsCmd.command("clean", "Remove decrypted .env files securely (shred + rm).")
    .option("--dry-run", "Print planned actions without executing.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const dryRun = options.dryRun as boolean | undefined;
        const cwd = Deno.cwd();

        // Find .env files that have .env.enc counterparts
        const encFiles = await findEncryptedEnvFiles(cwd);
        const decryptedFiles = encFiles.map((f) => f.replace(/\.enc$/, ""));

        if (decryptedFiles.length === 0) {
          console.log("No decrypted .env files to clean.");
          return;
        }

        const runner = new RealProcessRunner(dryRun ?? false);

        const result = await cleanDecryptedEnvFiles(
          decryptedFiles,
          dryRun,
          runner,
        );

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

  // secrets check
  secretsCmd.command("check", "Check secrets tooling availability.")
    .action(async () => {
      try {
        const runner = new RealProcessRunner(false);

        // Check tooling (throws if missing)
        try {
          await ensureTooling(runner);
        } catch (err: unknown) {
          console.error(err instanceof Error ? err.message : String(err));
          Deno.exit(ExitCode.MissingDependency);
        }

        // Get version info
        const status = await checkTooling(runner);

        console.log("Secrets Tooling Status:");
        console.log(`  sops: ${status.sops.available ? "available" : "not found"}`);
        if (status.sops.version) {
          console.log(`    version: ${status.sops.version}`);
        }
        console.log(`  age:  ${status.age.available ? "available" : "not found"}`);
        if (status.age.version) {
          console.log(`    version: ${status.age.version}`);
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
    .option("--paths <paths:string>", "Comma-separated list of service paths to limit listing.")
    .option("--json", "Output machine-readable JSON.")
    .option("--list", "Extended status listing (example, env, encrypted, profile variants).")
    .action(async (options: Record<string, unknown>) => {
      try {
        const profile = options.profile as string | undefined;
        const jsonOutput = options.json as boolean | undefined;
        const extendedList = options.list as boolean | undefined;
        const pathsOpt = options.paths as string | undefined;
        const paths = pathsOpt
          ? pathsOpt.split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        const cwd = Deno.cwd();

        if (extendedList) {
          const statusList = await getEnvStatusList(cwd, { profile, paths });
          if (jsonOutput) {
            console.log(JSON.stringify(statusList, null, 2));
          } else {
            if (statusList.length === 0) {
              console.log("No .env files or examples found.");
              return;
            }
            console.log(
              `${"Service".padEnd(28)} ${"Example".padEnd(8)} ${"Env".padEnd(8)} ${
                "Enc".padEnd(8)
              } ${"Profile".padEnd(12)} Path`,
            );
            console.log(
              `${"-".repeat(28)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(8)} ${
                "-".repeat(12)
              } ${"-".repeat(40)}`,
            );
            for (const entry of statusList) {
              const exIcon = entry.hasExample ? "\u2713" : "\u2717";
              const envIcon = entry.hasEnv ? "\u2713" : "\u2717";
              const encIcon = entry.hasEncrypted ? "\u2713" : "\u2717";
              const profLabel = entry.profile ?? "(default)";
              const pathLabel = entry.envPath ?? entry.examplePath ?? "";
              console.log(
                `${entry.serviceName.padEnd(28)} ${exIcon.padEnd(8)} ${envIcon.padEnd(8)} ${
                  encIcon.padEnd(8)
                } ${profLabel.padEnd(12)} ${pathLabel}`,
              );
            }
          }
        } else {
          const examples = await discoverEnvExamples(cwd, { profile, paths });
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
              const icon = ex.status === "present"
                ? "\u2713"
                : ex.status === "outdated"
                ? "~"
                : "\u2717";
              console.log(
                `${ex.serviceName.padEnd(30)} ${(icon + " " + ex.status).padEnd(12)} ${ex.envPath}`,
              );
            }
          }
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        exitCode = ExitCode.UnexpectedError;
      }
    });

  // env create
  envCmd.command("create", "Create .env files from .env.example templates.")
    .arguments("[name:string]")
    .option("--profile <name:string>", "Use a specific profile for variant lookup.")
    .option("--paths <paths:string>", "Comma-separated list of service paths to limit creation.")
    .option("--force", "Overwrite existing .env files.")
    .option("--dry-run", "Print planned changes without writing.")
    .option("--json", "Output machine-readable JSON.")
    .action(async (options: Record<string, unknown>, name?: string) => {
      try {
        const profile = options.profile as string | undefined;
        const force = options.force as boolean | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const jsonOutput = options.json as boolean | undefined;
        const pathsOpt = options.paths as string | undefined;
        const paths = pathsOpt
          ? pathsOpt.split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        const cwd = Deno.cwd();

        const result = await batchCreateEnvs(cwd, {
          profile,
          force,
          dryRun,
          serviceName: name,
          paths,
        });

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
        if (result.errors.length > 0) exitCode = ExitCode.DriftOrValidation;
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        exitCode = ExitCode.UnexpectedError;
      }
    });

  // env diff
  envCmd.command("diff", "Show differences between .env.example and .env files.")
    .arguments("[name:string]")
    .option("--profile <name:string>", "Use a specific profile for variant lookup.")
    .option("--paths <paths:string>", "Comma-separated list of service paths to limit diff.")
    .option("--json", "Output machine-readable JSON.")
    .action(async (options: Record<string, unknown>, name?: string) => {
      try {
        const profile = options.profile as string | undefined;
        const jsonOutput = options.json as boolean | undefined;
        const pathsOpt = options.paths as string | undefined;
        const paths = pathsOpt
          ? pathsOpt.split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        const cwd = Deno.cwd();

        const examples = await discoverEnvExamples(cwd, { profile, paths });
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
        exitCode = ExitCode.UnexpectedError;
      }
    });

  // env materialize
  envCmd.command("materialize", "Materialize profile preset env values into .env files.")
    .option(
      "--from-profile <name:string>",
      "Profile from which to source values (required).",
      { required: true },
    )
    .option(
      "--paths <paths:string>",
      "Comma-separated list of service paths to limit materialization.",
    )
    .option("--force", "Overwrite existing .env files.")
    .option("--dry-run", "Print planned changes without writing.")
    .option("--json", "Output machine-readable JSON.")
    .action(async (options: Record<string, unknown>) => {
      try {
        const fromProfile = options.fromProfile as string;
        const force = options.force as boolean | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const jsonOutput = options.json as boolean | undefined;
        const pathsOpt = options.paths as string | undefined;
        const paths = pathsOpt
          ? pathsOpt.split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        const cwd = Deno.cwd();

        if (!fromProfile) {
          console.error("error: --from-profile is required");
          exitCode = ExitCode.UserConfigError;
          return;
        }

        const result = await materializeEnvFromProfile(cwd, {
          profile: fromProfile,
          force,
          dryRun,
          paths,
        });

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const prefix = dryRun ? "[dry-run] would materialize" : "materialized";
          for (const m of result.materialized) {
            console.log(`${prefix}: ${m.sourcePath} -> ${m.targetPath}`);
          }
          for (const s of result.skipped) {
            console.log(`skipped: ${s.sourcePath} -> ${s.targetPath} (${s.reason})`);
          }
          for (const e of result.errors) {
            console.error(`error: ${e.serviceName}: ${e.message}`);
          }
        }

        if (result.errors.length > 0) exitCode = ExitCode.DriftOrValidation;
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        exitCode = ExitCode.UnexpectedError;
      }
    });

  // env audit
  envCmd.command("audit", "Check .env files for sensitive plaintext issues.")
    .option("--paths <paths:string>", "Comma-separated list of service paths to limit check.")
    .option("--dry-run", "Report what would be checked without logging as errors.")
    .option("--json", "Output machine-readable JSON.")
    .option("--suggest", "Suggest commands to fix issues (default: true).")
    .action(async (options: Record<string, unknown>) => {
      try {
        const pathsOpt = options.paths as string | undefined;
        const dryRun = options.dryRun as boolean | undefined;
        const jsonOutput = options.json as boolean | undefined;
        const suggest = options.suggest !== false; // default true
        const paths = pathsOpt
          ? pathsOpt.split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        const cwd = Deno.cwd();

        const result = await envDoctor(cwd, { paths, dryRun, suggest });

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.findings.length === 0) {
            console.log("No .env files found. Nothing to check.");
            return;
          }

          for (const finding of result.findings) {
            const icon = finding.severity === "warning" ? "\u26A0" : "\u2139";
            console.log(`${icon} ${finding.message}`);
          }

          if (result.hasWarnings) {
            console.log(
              "\n\u26A0 Warnings found. Consider running:",
            );
            console.log("  stackctl secrets encrypt  (to encrypt plaintext .env files)");
            console.log("  stackctl secrets clean    (to remove plaintext after encryption)");
          } else {
            console.log("\nNo sensitive plaintext issues detected.");
          }
        }

        if (result.hasWarnings) {
          exitCode = ExitCode.DriftOrValidation;
        }
      } catch (err: unknown) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        exitCode = ExitCode.UnexpectedError;
      }
    });

  // --- plan (issue #15) ---
  cli.command("plan", "Produce a deterministic plan of what an operation would do.")
    .arguments("<operation:string>")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.", {
      complete: completeStackNames,
    } as any)
    .option("--override <files:string>", "Comma-separated list of override files.")
    .option("--json", "Output machine-readable JSON.")
    .description(
      "Shows a structured summary of what the specified operation would do without executing it.\n\n" +
        "Supported operations:\n" +
        "  up       - Preview stack deployment\n" +
        "  down     - Preview stack removal\n" +
        "  sync     - Preview full generate+render+deploy pipeline\n" +
        "  generate - Preview stack generation only\n" +
        "  render   - Preview rendering only\n" +
        "  reload   - Preview config-first reload\n" +
        "  env      - Preview env file scaffolding\n" +
        "  secrets  - Preview secrets workflow\n" +
        "  all      - Preview everything",
    )
    .example(
      "Preview what would happen during a sync",
      "stackctl plan sync",
    )
    .example(
      "Preview with a specific profile",
      "stackctl plan up --profile staging",
    )
    .example(
      "Preview specific stacks only",
      "stackctl plan generate --stacks api,web",
    )
    .example(
      "Machine-readable JSON output",
      "stackctl plan all --json",
    )
    .action((opts: Record<string, unknown>, operation: string) => {
      const profile = opts.profile as string | undefined;
      const stacks = opts.stacks
        ? (opts.stacks as string).split(",").map((s: string) => s.trim())
        : undefined;
      const overrides = opts.override
        ? (opts.override as string).split(",").map((s: string) => s.trim())
        : undefined;

      planOperation({
        operation,
        profile,
        stacks,
        overrides,
      })
        .then((plan: PlanResult) => {
          if (opts.json) {
            console.log(JSON.stringify(plan.json, null, 2));
            return;
          }

          // Human-readable output
          console.log(`Plan: ${plan.operation}`);
          console.log("=".repeat(40));

          for (const section of plan.sections) {
            console.log(`\n${section.title}`);
            console.log("-".repeat(section.title.length));
            for (const item of section.items) {
              console.log(item);
            }
          }

          if (plan.warnings.length > 0) {
            console.log("\nWarnings:");
            for (const w of plan.warnings) {
              console.log(`  ! ${w}`);
            }
          }

          if (plan.errors.length > 0) {
            console.log("\nErrors:");
            for (const e of plan.errors) {
              console.log(`  ✗ ${e}`);
            }
            Deno.exit(ExitCode.DriftOrValidation);
          }
        })
        .catch((err: unknown) => {
          console.error(
            `error: ${err instanceof Error ? err.message : String(err)}`,
          );
          Deno.exit(ExitCode.UnexpectedError);
        });
    });

  // --- completions (issue #10) ---
  cli.command("completions", new CompletionsCommand());

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

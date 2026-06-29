import { Command } from "@cliffy/command";
import { VERSION } from "../version.ts";
import { initConfig } from "../config/mod.ts";
import { resolveConfig } from "../config/mod.ts";
import { ExitCode } from "../config/types.ts";
import { generateStacks } from "../compose/mod.ts";
import type { ComposeData, GenerateOptions } from "../compose/mod.ts";
import { join, resolve } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { renderStack } from "../render/mod.ts";

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
    .option("--no-logs", "Do not follow logs after deploy.")
    .option("--dry-run", "Print planned actions without executing.")
    .option("--skip-generate", "Skip stack generation step.")
    .option("--allow-unrendered", "Deploy unrendered stack files (not recommended).")
    .option("--stacks <names:string>", "Comma-separated list of stack names to deploy.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--override <files:string>", "Comma-separated list of override files.")
    .action(() => {
      console.error("up: not yet implemented (issue #6)");
      Deno.exit(1);
    });

  // --- down (issue #6) ---
  cli.command("down", "Remove stacks from Docker Swarm.")
    .option("--yes", "Skip confirmation prompt.")
    .option("--dry-run", "Print planned actions without executing.")
    .option("--remove-network", "Also remove the configured overlay network.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to remove.")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(() => {
      console.error("down: not yet implemented (issue #6)");
      Deno.exit(1);
    });

  // --- status (issue #6) ---
  cli.command("status", "Show stack service status.")
    .option("--json", "Output JSON machine-readable status.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(() => {
      console.error("status: not yet implemented (issue #6)");
      Deno.exit(1);
    });

  // --- logs (issue #6) ---
  cli.command("logs", "Follow service logs.")
    .arguments("[services...:string]")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(() => {
      console.error("logs: not yet implemented (issue #6)");
      Deno.exit(1);
    });

  // --- sync (issue #6) ---
  cli.command("sync", "Validate that generated stacks match committed stack files.")
    .option("--quiet", "Suppress diff output.")
    .option("--non-interactive", "Skip confirmation; exit 1 on drift.")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(() => {
      console.error("sync: not yet implemented (issue #6)");
      Deno.exit(1);
    });

  // --- doctor (issue #6) ---
  cli.command("doctor", "Check system and project health.")
    .option("--fix-volumes", "Create missing external volumes.")
    .option("--check-secrets", "Also check for secrets tooling (sops, age).")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(() => {
      console.error("doctor: not yet implemented (issue #6)");
      Deno.exit(1);
    });

  // --- reload (issue #9) ---
  cli.command("reload", "Re-render and redeploy stacks without tearing down.")
    .option("--force-service-update", "Force update all services after deploy.")
    .option("--no-force-service-update", "Skip force update (config override).")
    .option("--no-generate", "Skip stack generation step.")
    .option("--stacks <names:string>", "Comma-separated list of stack names.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--override <files:string>", "Comma-separated list of override files.")
    .option("--dry-run", "Print planned actions without executing.")
    .action(() => {
      console.error("reload: not yet implemented (issue #9)");
      Deno.exit(1);
    });

  // --- secrets (issue #7) ---
  const secretsCmd = cli.command("secrets", "Manage SOPS/age encrypted secrets.");
  secretsCmd.command("encrypt", "Encrypt .env files to encrypted output.")
    .arguments("[services...:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .action(() => {
      console.error("secrets encrypt: not yet implemented (issue #7)");
      Deno.exit(1);
    });
  secretsCmd.command("decrypt", "Decrypt encrypted .env files to plaintext.")
    .arguments("[services...:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .action(() => {
      console.error("secrets decrypt: not yet implemented (issue #7)");
      Deno.exit(1);
    });
  secretsCmd.command("deploy", "Decrypt and deploy stacks with secret values.")
    .arguments("[services...:string]")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .action(() => {
      console.error("secrets deploy: not yet implemented (issue #7)");
      Deno.exit(1);
    });
  secretsCmd.command("clean", "Remove plaintext .env files that have encrypted counterparts.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--dry-run", "Print planned actions without executing.")
    .action(() => {
      console.error("secrets clean: not yet implemented (issue #7)");
      Deno.exit(1);
    });
  secretsCmd.command("check", "Check secrets tooling availability.")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(() => {
      console.error("secrets check: not yet implemented (issue #7)");
      Deno.exit(1);
    });

  // --- env (issue #14) ---
  cli.command("env", "Manage .env files and profile env presets.")
    .option("--list", "List discovered services and .env status.")
    .option("--recreate", "Create missing .env files from .env.example.")
    .option("--force", "Overwrite existing .env files.")
    .option("--yes", "Skip confirmation.")
    .option("--dry-run", "Print planned changes without writing.")
    .option("--paths <paths:string>", "Comma-separated list of service paths.")
    .option("--profile <name:string>", "Use a specific profile.")
    .option("--from-profile <name:string>", "Materialize env from a profile preset.")
    .option("--materialize", "Materialize profile preset env values.")
    .action(() => {
      console.error("env: not yet implemented (issue #14)");
      Deno.exit(1);
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

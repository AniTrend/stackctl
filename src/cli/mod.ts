import { Command } from "@cliffy/command";
import { VERSION } from "../version.ts";

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
    .option("--debug", "Enable debug output and stack traces.", { hidden: false });

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
    .action(() => {
      console.error("init: not yet implemented (issue #3)");
      Deno.exit(1);
    });

  // --- generate (issue #4) ---
  cli.command("generate", "Generate canonical stack files from per-service Compose sources.")
    .option("--dry-run", "Print generated output without writing files.")
    .option("--stacks <names:string>", "Comma-separated list of stack names to generate.")
    .option("--output-dir <path:string>", "Write generated stacks to a specific directory.")
    .option("--profile <name:string>", "Use a specific profile.")
    .action(() => {
      console.error("generate: not yet implemented (issue #4)");
      Deno.exit(1);
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
    .action(() => {
      console.error("render: not yet implemented (issue #5)");
      Deno.exit(1);
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

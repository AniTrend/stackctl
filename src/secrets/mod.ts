/**
 * Secrets management: encrypt/decrypt/clean/deploy .env files with SOPS + age.
 *
 * Dotenv encryption model (local-stack compatible):
 * - Encrypt/decrypt .env files using SOPS with --input-type dotenv --output-type dotenv
 * - SOPS resolves age keys from its own config (typically .sops.yaml)
 * - No explicit age key or recipient is passed on operations
 * - Cleanup uses shred -u with rm -f fallback
 *
 * All external commands go through the ProcessRunner interface.
 */
import { exists, walk } from "@std/fs";
import type { ProcessRunner } from "../process/types.ts";
import { RealProcessRunner } from "../process/runner.ts";
import type {
  CleanResult,
  DecryptResult,
  DeployPipelineOptions,
  DeployPipelineResult,
  EncryptResult,
  ToolingStatus,
} from "./types.ts";
import { resolveConfig } from "../config/mod.ts";
import { discoverComposeFiles } from "../compose/mod.ts";
import { generateStacks } from "../compose/mod.ts";
import type { GenerateOptions } from "../compose/mod.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { renderStack } from "../render/mod.ts";
import { dockerStackDeploy } from "../docker/mod.ts";
import type { ComposeData } from "../compose/types.ts";

// ---------------------------------------------------------------------------
// Tooling
// ---------------------------------------------------------------------------

/**
 * Check that sops and age are available on PATH.
 * Throws an Error with a clear message if either tool is missing.
 *
 * This MUST be called before any file mutation operations.
 */
export async function ensureTooling(
  processRunner?: ProcessRunner,
): Promise<{ sops: boolean; age: boolean }> {
  const runner = processRunner ?? new RealProcessRunner(false);

  const sops = await runner.which("sops");
  const age = await runner.which("age");

  if (!sops || !age) {
    const missing: string[] = [];
    if (!sops) missing.push("sops");
    if (!age) missing.push("age");
    throw new Error(
      `Missing required secrets tooling: ${missing.join(", ")}. ` +
        `sops: https://github.com/getsops/sops  age: https://github.com/FiloSottile/age`,
    );
  }

  return { sops, age };
}

/**
 * Check whether sops and age are available on PATH, with version extraction.
 *
 * Non-throwing variant used for status display.
 */
export async function checkTooling(runner: ProcessRunner): Promise<ToolingStatus> {
  const sopsAvailable = await runner.which("sops");
  const ageAvailable = await runner.which("age");

  let sopsVersion: string | undefined;
  let ageVersion: string | undefined;

  if (sopsAvailable) {
    sopsVersion = await tryVersion(runner, ["sops", "--version"]);
  }
  if (ageAvailable) {
    ageVersion = await tryVersion(runner, ["age", "--version"]);
  }

  return {
    sops: { available: sopsAvailable, version: sopsVersion },
    age: { available: ageAvailable, version: ageVersion },
  };
}

/** Try to get a tool's version string from its --version output. */
async function tryVersion(
  runner: ProcessRunner,
  cmd: string[],
): Promise<string | undefined> {
  try {
    const result = await runner.run(cmd);
    if (result.success && result.stdout) {
      return result.stdout.trim().split("\n")[0];
    }
  } catch {
    // Tool is present but --version failed — ignore
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a .env file using SOPS with dotenv format.
 *
 * Runs: sops --encrypt --input-type dotenv --output-type dotenv --output <sourcePath>.enc <sourcePath>
 *
 * SOPS resolves age keys from its own config (typically .sops.yaml in repo root).
 * No explicit age key or recipient is passed.
 */
export async function encryptEnvFile(
  sourcePath: string,
  processRunner?: ProcessRunner,
): Promise<EncryptResult> {
  const runner = processRunner ?? new RealProcessRunner(false);
  const outputPath = sourcePath + ".enc";

  if (!(await exists(sourcePath))) {
    return {
      file: sourcePath,
      outputPath,
      success: false,
      error: `File not found: ${sourcePath}`,
    };
  }

  const result = await runner.run([
    "sops",
    "--encrypt",
    "--input-type",
    "dotenv",
    "--output-type",
    "dotenv",
    "--output",
    outputPath,
    sourcePath,
  ]);

  if (!result.success) {
    return {
      file: sourcePath,
      outputPath,
      success: false,
      error: result.stderr || "sops encrypt failed",
    };
  }

  return { file: sourcePath, outputPath, success: true };
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypt an encrypted .env file using SOPS with dotenv format.
 *
 * Runs: sops --decrypt --input-type dotenv --output-type dotenv --output <plainPath> <sourcePath>
 *
 * Output path is derived by stripping the `.enc` suffix.
 * SOPS resolves age keys from its own config.
 * No explicit age key or recipient is passed.
 */
export async function decryptEnvFile(
  sourcePath: string,
  processRunner?: ProcessRunner,
): Promise<DecryptResult> {
  const runner = processRunner ?? new RealProcessRunner(false);
  const warnings: string[] = [];

  // Derive plaintext output path by stripping .enc suffix
  const outputPath = sourcePath.replace(/\.enc$/, "");

  if (!(await exists(sourcePath))) {
    return {
      file: sourcePath,
      outputPath,
      success: false,
      error: `File not found: ${sourcePath}`,
      warnings,
    };
  }

  const result = await runner.run([
    "sops",
    "--decrypt",
    "--input-type",
    "dotenv",
    "--output-type",
    "dotenv",
    "--output",
    outputPath,
    sourcePath,
  ]);

  if (!result.success) {
    return {
      file: sourcePath,
      outputPath,
      success: false,
      error: result.stderr || "sops decrypt failed",
      warnings,
    };
  }

  warnings.push(
    `Decrypted ${sourcePath} -> ${outputPath}. Remember to clean up decrypted files after deployment.`,
  );

  return { file: sourcePath, outputPath, success: true, warnings };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Discover all `.env.enc` files under the given directory.
 *
 * Skips node_modules, .git, and .rendered directories.
 */
export async function findEncryptedEnvFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  for await (
    const entry of walk(cwd, {
      includeDirs: false,
      includeFiles: true,
      skip: [/(^|\/)\.(git|rendered)$/, /node_modules/],
    })
  ) {
    if (entry.name === ".env.enc") {
      files.push(entry.path);
    }
  }
  return files;
}

/**
 * Discover all `.env.example` files under the given directory.
 *
 * Skips node_modules, .git, and .rendered directories.
 */
export async function findEnvExampleFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  for await (
    const entry of walk(cwd, {
      includeDirs: false,
      includeFiles: true,
      skip: [/(^|\/)\.(git|rendered)$/, /node_modules/],
    })
  ) {
    if (entry.name === ".env.example") {
      files.push(entry.path);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------

/**
 * Remove decrypted .env files securely.
 *
 * Uses `shred -u <path>` for secure deletion, with `rm -f <path>` as fallback.
 *
 * In dry-run mode, returns the paths that would be cleaned without removing them.
 */
export async function cleanDecryptedEnvFiles(
  envFiles: string[],
  dryRun?: boolean,
  processRunner?: ProcessRunner,
): Promise<CleanResult> {
  const runner = processRunner ?? new RealProcessRunner(dryRun ?? false);
  const removedFiles: string[] = [];

  if (dryRun) {
    return { removedFiles: [...envFiles] };
  }

  for (const file of envFiles) {
    let removed = false;

    // Try shred -u first
    try {
      const shredResult = await runner.run(["shred", "-u", file]);
      if (shredResult.success) {
        removed = true;
      }
    } catch {
      // shred failed or not available — fall through to rm
    }

    // Fallback to rm -f
    if (!removed) {
      try {
        const rmResult = await runner.run(["rm", "-f", file]);
        if (rmResult.success) {
          removed = true;
        }
      } catch {
        // Both shred and rm failed — best-effort
      }
    }

    if (removed) {
      removedFiles.push(file);
    }
  }

  return { removedFiles };
}

// ---------------------------------------------------------------------------
// Deploy Pipeline
// ---------------------------------------------------------------------------

/**
 * Full deploy pipeline: decrypt .env.enc -> generate -> render -> deploy -> cleanup.
 *
 * Steps:
 *   a. Find all `.env.enc` files
 *   b. Decrypt them to their `.env` locations
 *   c. Determine which stacks are affected (from service dirs)
 *   d. Generate, render, and deploy those stacks
 *   e. Clean up decrypted `.env` files
 *
 * In dry-run mode, every step is printed without any mutation.
 */
export async function deployPipeline(
  options: DeployPipelineOptions,
): Promise<DeployPipelineResult> {
  const result: DeployPipelineResult = { warnings: [], errors: [] };
  const runner = options.processRunner ?? new RealProcessRunner(options.dryRun ?? false);
  const dryRun = options.dryRun ?? false;

  // ------------------------------------------------------------------
  // a. Find all encrypted .env files
  // ------------------------------------------------------------------
  const envEncFiles = await findEncryptedEnvFiles(options.cwd);

  if (envEncFiles.length === 0) {
    result.warnings.push("No .env.enc files found. Nothing to decrypt.");
    return result;
  }

  if (dryRun) {
    result.warnings.push(`[dry-run] Would decrypt ${envEncFiles.length} .env.enc file(s):`);
    for (const f of envEncFiles) {
      result.warnings.push(`[dry-run]   ${f}`);
    }
  }

  // ------------------------------------------------------------------
  // b. Decrypt all encrypted files
  // ------------------------------------------------------------------
  const decryptedFiles: string[] = [];

  for (const encFile of envEncFiles) {
    if (dryRun) {
      const plainPath = encFile.replace(/\.enc$/, "");
      result.warnings.push(`[dry-run]   -> ${plainPath}`);
      decryptedFiles.push(plainPath);
    } else {
      const decryptResult = await decryptEnvFile(encFile, runner);
      if (decryptResult.success) {
        decryptedFiles.push(decryptResult.outputPath);
        for (const w of decryptResult.warnings) result.warnings.push(w);
      } else {
        result.errors.push(
          `Failed to decrypt ${encFile}: ${decryptResult.error}`,
        );
      }
    }
  }

  if (result.errors.length > 0) {
    return result;
  }

  // ------------------------------------------------------------------
  // c. Determine affected stacks
  // ------------------------------------------------------------------
  // A stack is affected if any of its service directories contains
  // a decrypted .env file. We extract service names from the paths
  // of the encrypted files and match against discovered stacks.

  const affectedServiceNames = new Set<string>();
  for (const encFile of envEncFiles) {
    // Normalize: extract the immediate parent directory as the service name
    const relPath = encFile.startsWith(options.cwd)
      ? encFile.slice(options.cwd.length).replace(/^\//, "")
      : encFile;

    // Example: services/web/.env.enc -> parts = ["services", "web", ".env.enc"]
    const parts = relPath.split("/").filter(Boolean);
    if (parts.length >= 2) {
      // The parent directory of .env.enc is the service name
      affectedServiceNames.add(parts[parts.length - 2]);
    }
  }

  const affectedStacks = options.stacks ??
    [...affectedServiceNames];

  if (affectedStacks.length === 0) {
    result.warnings.push("Could not determine affected stacks from encrypted file locations.");
    // Clean up before returning
    if (!dryRun && decryptedFiles.length > 0) {
      await cleanDecryptedEnvFiles(decryptedFiles, false, runner);
    }
    return result;
  }

  // Resolve config for the sync pipeline
  let config;
  try {
    config = await resolveConfig({ profile: options.profile, cwd: options.cwd });
  } catch (err: unknown) {
    result.errors.push(
      `Config resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Clean up before returning
    if (!dryRun && decryptedFiles.length > 0) {
      await cleanDecryptedEnvFiles(decryptedFiles, false, runner);
    }
    return result;
  }

  const repoRoot = config.base.repoRoot ?? options.cwd;

  // ------------------------------------------------------------------
  // d. Generate -> Render -> Deploy each affected stack
  // ------------------------------------------------------------------
  try {
    // Discover stacks
    const discovery = await discoverComposeFiles({ repoRoot });
    const targetStacks = affectedStacks.filter((s) => Object.keys(discovery.stacks).includes(s));

    if (targetStacks.length === 0) {
      result.warnings.push(
        `None of the affected stacks ${
          [...affectedStacks].join(", ")
        } were discovered in the repo.`,
      );
      // Clean up before returning
      if (!dryRun && decryptedFiles.length > 0) {
        await cleanDecryptedEnvFiles(decryptedFiles, false, runner);
      }
      return result;
    }

    if (dryRun) {
      result.warnings.push(
        `[dry-run] Would generate, render, and deploy stacks: ${targetStacks.join(", ")}`,
      );
    }

    // Generate stacks (in memory)
    const genOptions: GenerateOptions = {
      stacks: targetStacks,
      repoRoot,
      outputDir: undefined,
      dryRun: true, // in-memory only
    };

    const genResult = await generateStacks(genOptions);

    for (const w of genResult.warnings) result.warnings.push(w);
    for (const e of genResult.errors) result.errors.push(e);

    if (genResult.errors.length > 0) {
      // Clean up before returning
      if (!dryRun && decryptedFiles.length > 0) {
        await cleanDecryptedEnvFiles(decryptedFiles, false, runner);
      }
      return result;
    }

    // Render and deploy each stack
    for (const [stackName, yamlContent] of Object.entries(genResult.generated)) {
      if (dryRun) {
        result.warnings.push(`[dry-run] Would deploy stack: ${stackName}`);
        continue;
      }

      try {
        // Parse generated YAML
        const parsed = parseYaml(yamlContent) as ComposeData;

        // Render — resolve ${VAR} placeholders
        const renderResult = await renderStack({
          data: parsed,
          projectDir: repoRoot,
          repoRoot,
          strict: true,
        });

        for (const w of renderResult.warnings) {
          result.warnings.push(`[${stackName}] ${w}`);
        }

        // Deploy
        const tempFile = await Deno.makeTempFile({ suffix: ".yml" });
        try {
          const yaml = stringifyYaml(renderResult.data, {
            indent: 2,
            lineWidth: 120,
            noRefs: true,
          } as Record<string, unknown>);
          await Deno.writeTextFile(tempFile, yaml);

          const deployResult = await dockerStackDeploy(
            runner,
            stackName,
            tempFile,
            {
              prune: false,
              detach: false,
              resolveImage: "always",
            },
          );

          if (deployResult.success) {
            result.warnings.push(`Deployed stack: ${stackName}`);
          } else {
            result.errors.push(
              `Stack "${stackName}" deployment failed: ${deployResult.stderr || "unknown error"}`,
            );
          }
        } finally {
          // Clean up temp compose file
          try {
            await Deno.remove(tempFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch (err: unknown) {
        result.errors.push(
          `Stack "${stackName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err: unknown) {
    result.errors.push(
      `Pipeline error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ------------------------------------------------------------------
  // e. Clean up decrypted .env files
  // ------------------------------------------------------------------
  if (!dryRun && decryptedFiles.length > 0) {
    const cleanResult = await cleanDecryptedEnvFiles(decryptedFiles, false, runner);
    if (cleanResult.removedFiles.length > 0) {
      result.warnings.push(
        `Cleaned up ${cleanResult.removedFiles.length} decrypted .env file(s).`,
      );
    }
  } else if (dryRun) {
    result.warnings.push(
      `[dry-run] Would clean up ${decryptedFiles.length} decrypted .env file(s).`,
    );
  }

  return result;
}

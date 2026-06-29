/**
 * Secrets management: encrypt/decrypt/deploy/clean with SOPS + age.
 *
 * All external commands go through the ProcessRunner interface.
 * This enables dry-run, test faking, and graceful error handling
 * when sops or age are not installed.
 */
import { exists } from "@std/fs";
import { join } from "@std/path";
import { walk } from "@std/fs/walk";
import type { ProcessRunner } from "../process/types.ts";
import type { ResolvedConfig } from "../config/types.ts";
import type {
  CleanResult,
  DecryptResult,
  DeployResult,
  EncryptResult,
  ToolingStatus,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default encrypted dotenv file name. */
const DEFAULT_ENCRYPTED_FILE_NAME = ".env.enc";

/** Directories always skipped during secrets discovery. */
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  "stacks",
  "tools",
  "environments",
  "__pycache__",
  ".git",
  ".rendered",
]);

// ---------------------------------------------------------------------------
// Tooling checks
// ---------------------------------------------------------------------------

/**
 * Check whether sops and age are available on PATH.
 *
 * Gracefully returns `available: false` for each tool that cannot be found.
 * Attempts to extract version strings via `--version` when available.
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
// Age key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the age public key to use for sops encryption.
 *
 * Resolution order:
 *   1. Explicit `explicitKey` parameter (from --age-key CLI flag)
 *   2. `secrets.ageKeyFile` config value (reads file contents as the key)
 *   3. `$SOPS_AGE_KEY` environment variable
 *
 * Returns the resolved key string, or undefined if no key can be found.
 */
export async function resolveAgeKey(
  config: ResolvedConfig,
  explicitKey?: string,
): Promise<string | undefined> {
  // 1. Explicit key (passed as CLI argument)
  if (explicitKey) return explicitKey;

  // 2. Config: secrets.ageKeyFile (read the file for the key)
  if (config.base.secrets?.ageKeyFile) {
    const keyPath = config.base.secrets.ageKeyFile;
    try {
      if (await exists(keyPath)) {
        const content = await Deno.readTextFile(keyPath);
        const trimmed = content.trim();
        if (trimmed) return trimmed;
      }
    } catch {
      // File may not exist or be readable — fall through to env var
    }
  }

  // 3. $SOPS_AGE_KEY environment variable
  const envKey = Deno.env.get("SOPS_AGE_KEY");
  if (envKey) return envKey;

  return undefined;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Discover all encrypted files (matching `encryptedFileName` pattern)
 * under the repository root, skipping excluded directories.
 */
export async function discoverEncryptedFiles(
  config: ResolvedConfig,
): Promise<string[]> {
  const repoRoot = config.base.repoRoot ?? Deno.cwd();
  const encryptedFileName = config.base.secrets?.encryptedFileName ??
    DEFAULT_ENCRYPTED_FILE_NAME;
  const skipDirs = new Set([
    ...DEFAULT_SKIP_DIRS,
    ...(config.base.stack.skipDirectories ?? []),
  ]);

  const files: string[] = [];
  for await (
    const entry of walk(repoRoot, {
      includeDirs: false,
      includeFiles: true,
      skip: [/(^|\/)\.(git|rendered)$/],
    })
  ) {
    const name = entry.path.split("/").pop()!;
    if (name !== encryptedFileName) continue;

    // Skip if any ancestor directory is in the skip set
    if (hasSkipAncestor(entry.path, repoRoot, skipDirs)) continue;

    files.push(entry.path);
  }

  return files;
}

/**
 * Discover all plaintext files that can be encrypted (`.env` files that
 * may or may not have an `.env.enc` counterpart).
 *
 * Only returns files that do NOT already have the `.enc` suffix.
 */
export async function discoverDecryptedFiles(
  config: ResolvedConfig,
): Promise<string[]> {
  const repoRoot = config.base.repoRoot ?? Deno.cwd();
  const encryptedFileName = config.base.secrets?.encryptedFileName ??
    DEFAULT_ENCRYPTED_FILE_NAME;
  const skipDirs = new Set([
    ...DEFAULT_SKIP_DIRS,
    ...(config.base.stack.skipDirectories ?? []),
  ]);

  // Derive the plaintext counterpart pattern.
  // If encryptedFileName is ".env.enc", the plaintext counterpart is ".env".
  const plaintextName = encryptedFileName.replace(/\.enc$/, "");

  const files: string[] = [];
  for await (
    const entry of walk(repoRoot, {
      includeDirs: false,
      includeFiles: true,
      skip: [/(^|\/)\.(git|rendered)$/],
    })
  ) {
    const name = entry.path.split("/").pop()!;
    if (name !== plaintextName) continue;

    // Skip if any ancestor directory is in the skip set
    if (hasSkipAncestor(entry.path, repoRoot, skipDirs)) continue;

    files.push(entry.path);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a single plaintext file using sops + age.
 *
 * Writes the encrypted output alongside the original file with `.enc` suffix.
 *
 * Options:
 *   - dryRun: log the command that would execute but don't run it
 *   - ageKey: explicit age public key (overrides config/env resolution)
 */
export async function encryptFile(
  file: string,
  config: ResolvedConfig,
  runner: ProcessRunner,
  options?: { dryRun?: boolean; ageKey?: string },
): Promise<EncryptResult> {
  const ageKey = await resolveAgeKey(config, options?.ageKey);
  if (!ageKey) {
    return {
      file,
      success: false,
      error: "No age key configured. Set secrets.ageKeyFile or $SOPS_AGE_KEY.",
    };
  }

  if (options?.dryRun) {
    console.log(`[dry-run] would encrypt: ${file}`);
    return { file, success: true };
  }

  // Determine output path: <file>.enc
  const outputPath = file + ".enc";

  // Ensure the source file exists
  if (!(await exists(file))) {
    return {
      file,
      success: false,
      error: `File not found: ${file}`,
    };
  }

  const cmd = [
    "sops",
    "--encrypt",
    "--input-type=yaml",
    "--output-type=yaml",
    "--age",
    ageKey,
    "--output",
    outputPath,
    file,
  ];

  const result = await runner.run(cmd);

  if (!result.success) {
    return {
      file,
      success: false,
      error: result.stderr || "sops encrypt failed",
    };
  }

  return { file, success: true };
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypt a single `.env.enc` file using sops + age.
 *
 * By default writes the decrypted output alongside the encrypted file
 * (stripping the `.enc` suffix).  Provide `outputDir` to write all
 * decrypted files into a different directory.
 *
 * Options:
 *   - dryRun: log the command that would execute but don't run it
 *   - outputDir: directory to write decrypted files into
 *   - ageKey: explicit age key
 */
export async function decryptFile(
  file: string,
  config: ResolvedConfig,
  runner: ProcessRunner,
  options?: { dryRun?: boolean; outputDir?: string; ageKey?: string },
): Promise<DecryptResult> {
  const ageKey = await resolveAgeKey(config, options?.ageKey);

  if (options?.dryRun) {
    const outputPath = determineDecryptOutput(file, options?.outputDir);
    console.log(`[dry-run] would decrypt: ${file} -> ${outputPath}`);
    return { file, outputPath, success: true };
  }

  // Ensure the source file exists
  if (!(await exists(file))) {
    return {
      file,
      outputPath: "",
      success: false,
      error: `File not found: ${file}`,
    };
  }

  const outputPath = determineDecryptOutput(file, options?.outputDir);

  const cmd = [
    "sops",
    "--decrypt",
    "--input-type=yaml",
    "--output-type=yaml",
    "--output",
    outputPath,
  ];

  // Add age key if resolved
  if (ageKey) {
    cmd.push("--age", ageKey);
  }

  cmd.push(file);

  const result = await runner.run(cmd);

  if (!result.success) {
    return {
      file,
      outputPath,
      success: false,
      error: result.stderr || "sops decrypt failed",
    };
  }

  return { file, outputPath, success: true };
}

/** Determine the output path for a decrypted file. */
function determineDecryptOutput(
  encryptedFile: string,
  outputDir?: string,
): string {
  const baseName = encryptedFile.split("/").pop()!;
  // Strip .enc suffix: ".env.enc" -> ".env"
  const plainName = baseName.replace(/\.enc$/, "");

  if (outputDir) {
    return join(outputDir, plainName);
  }

  const parentDir = encryptedFile.substring(0, encryptedFile.lastIndexOf("/"));
  return join(parentDir, plainName);
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

/**
 * Decrypt secrets for a given stack and create Docker secrets from them.
 *
 * Workflow:
 *   1. Discover or use provided encrypted files for the stack
 *   2. Decrypt each file to a temp location
 *   3. For each decrypted file, create a Docker secret with the file name as secret name
 *   4. Clean up temp decrypted files
 *
 * Options:
 *   - dryRun: show what would be deployed without executing
 *   - encryptedFiles: explicit list of encrypted files (bypasses discovery)
 */
export async function deploySecrets(
  stack: string,
  config: ResolvedConfig,
  runner: ProcessRunner,
  options?: { dryRun?: boolean; encryptedFiles?: string[]; ageKey?: string },
): Promise<DeployResult> {
  const ageKey = await resolveAgeKey(config, options?.ageKey);
  if (!ageKey && !options?.dryRun) {
    return {
      stack,
      secrets: [],
      success: false,
      error: "No age key configured. Set secrets.ageKeyFile or $SOPS_AGE_KEY.",
    };
  }

  // Discover encrypted files for this stack
  const encFiles = options?.encryptedFiles ??
    await discoverEncryptedFiles(config);

  if (encFiles.length === 0) {
    if (options?.dryRun) {
      console.log(`[dry-run] no encrypted files found for stack: ${stack}`);
      return { stack, secrets: [], success: true };
    }
    return { stack, secrets: [], success: true };
  }

  if (options?.dryRun) {
    console.log(
      `[dry-run] would deploy ${encFiles.length} secrets for stack: ${stack}`,
    );
    for (const f of encFiles) {
      console.log(
        `[dry-run]   docker secret create ${secretNameFromPath(f)} <decrypted ${f}>`,
      );
    }
    return { stack, secrets: encFiles, success: true };
  }

  // Decrypt each file to a temp directory
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-secrets-" });
  const deployedSecrets: string[] = [];
  const errors: string[] = [];

  try {
    for (const encFile of encFiles) {
      const decryptResult = await decryptFile(encFile, config, runner, {
        outputDir: tmpDir,
        ageKey,
      });

      if (!decryptResult.success) {
        errors.push(`Failed to decrypt ${encFile}: ${decryptResult.error}`);
        continue;
      }

      const secretName = secretNameFromPath(encFile);

      // Create Docker secret
      const createResult = await runner.run([
        "docker",
        "secret",
        "create",
        secretName,
        decryptResult.outputPath,
      ]);

      if (createResult.success) {
        deployedSecrets.push(secretName);
      } else {
        errors.push(
          `Failed to create secret '${secretName}': ${createResult.stderr || "unknown error"}`,
        );
      }
    }
  } finally {
    // Clean up temp directory
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }

  if (errors.length > 0) {
    return {
      stack,
      secrets: deployedSecrets,
      success: false,
      error: errors.join("; "),
    };
  }

  return { stack, secrets: deployedSecrets, success: true };
}

/**
 * Derive a Docker secret name from the encrypted file path.
 * Strips `.env.enc` suffix and converts to a valid Docker secret name.
 */
function secretNameFromPath(filePath: string): string {
  const baseName = filePath.split("/").pop() ?? filePath;
  return baseName
    .replace(/\.env\.enc$/, "")
    .replace(/\.enc$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------

/**
 * Remove temporary and stray decrypted files from a secrets directory.
 *
 * Removes files matching these patterns:
 *   - `*.tmp` files
 *   - Plaintext `.env` files that have an encrypted `.env.enc` counterpart
 *     (stray decrypted files left from interrupted operations)
 *
 * Options:
 *   - dryRun: show what would be cleaned without removing
 */
export async function cleanTempFiles(
  secretsDir: string,
  _runner: ProcessRunner,
  options?: { dryRun?: boolean },
): Promise<CleanResult> {
  const removedFiles: string[] = [];

  if (!(await exists(secretsDir))) {
    return { removedFiles };
  }

  // Walk secretsDir looking for cleanable files
  const encryptedFileName = ".env.enc";

  for await (
    const entry of walk(secretsDir, {
      includeDirs: false,
      includeFiles: true,
    })
  ) {
    const name = entry.path.split("/").pop()!;
    let shouldRemove = false;

    // .tmp files
    if (name.endsWith(".tmp")) {
      shouldRemove = true;
    }

    // Stray plaintext .env files: if .env exists and .env.enc exists alongside
    if (name === ".env") {
      const parentDir = entry.path.substring(0, entry.path.lastIndexOf("/"));
      const encPath = join(parentDir, encryptedFileName);
      if (await exists(encPath)) {
        shouldRemove = true;
      }
    }

    if (shouldRemove) {
      removedFiles.push(entry.path);
    }
  }

  if (options?.dryRun) {
    for (const f of removedFiles) {
      console.log(`[dry-run] would remove: ${f}`);
    }
    return { removedFiles };
  }

  for (const f of removedFiles) {
    try {
      await Deno.remove(f);
    } catch {
      // Best-effort — some files may be locked or already deleted
    }
  }

  return { removedFiles };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if any ancestor directory of `filePath` (relative to `repoRoot`)
 * is in the skip set.
 */
function hasSkipAncestor(
  filePath: string,
  repoRoot: string,
  skipDirs: Set<string>,
): boolean {
  // Get the relative path from repoRoot to the parent dir of the file
  const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
  const relDir = parentDir.startsWith(repoRoot)
    ? parentDir.substring(repoRoot.length).replace(/^\//, "")
    : parentDir;

  const parts = relDir.split("/").filter(Boolean);
  for (const part of parts) {
    if (skipDirs.has(part)) return true;
  }
  return false;
}

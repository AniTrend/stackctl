/**
 * Types for the secrets management module.
 *
 * Defines the interfaces for encrypt/decrypt/clean pipeline operations
 * and tooling status checks.
 */

/** Result of the deploy pipeline. */
export interface DeployPipelineResult {
  warnings: string[];
  errors: string[];
}

/** Options for the deploy pipeline. */
export interface DeployPipelineOptions {
  /** Working directory (usually the repo root). */
  cwd: string;
  /** Active profile name. */
  profile?: string;
  /** Stack names to target (undefined = all). */
  stacks?: string[];
  /** Dry-run: show every step without mutation. */
  dryRun?: boolean;
  /** Process runner instance. */
  processRunner?: ProcessRunner;
}

import type { ProcessRunner } from "../process/types.ts";

/** Status of required external tooling (sops, age). */
export interface ToolingStatus {
  sops: { available: boolean; version?: string };
  age: { available: boolean; version?: string };
}

/** Result of encrypting a single file. */
export interface EncryptResult {
  file: string;
  outputPath: string;
  success: boolean;
  error?: string;
}

/** Result of decrypting a single file. */
export interface DecryptResult {
  file: string;
  outputPath: string;
  success: boolean;
  error?: string;
  warnings: string[];
}

/** Result of cleaning decrypted env files. */
export interface CleanResult {
  removedFiles: string[];
}

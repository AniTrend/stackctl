/**
 * Types for the secrets management module.
 *
 * Defines the interfaces for encrypt/decrypt/deploy/clean operations
 * and tooling status checks.
 */

/** Status of required external tooling (sops, age). */
export interface ToolingStatus {
  sops: { available: boolean; version?: string };
  age: { available: boolean; version?: string };
}

/** Result of encrypting a single file. */
export interface EncryptResult {
  file: string;
  success: boolean;
  error?: string;
}

/** Result of decrypting a single file. */
export interface DecryptResult {
  file: string;
  outputPath: string;
  success: boolean;
  error?: string;
}

/** Result of deploying secrets for a stack. */
export interface DeployResult {
  stack: string;
  secrets: string[];
  success: boolean;
  error?: string;
}

/** Result of cleaning temp files. */
export interface CleanResult {
  removedFiles: string[];
}

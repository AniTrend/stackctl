/**
 * Env module types - Issue #14
 *
 * Types for .env scaffolding and profile preset support.
 */

/** A discovered .env.example file with its status. */
export interface EnvExample {
  /** Human-readable service/directory name derived from path. */
  serviceName: string;
  /** Absolute path to the .env.example file. */
  examplePath: string;
  /** Absolute path to the corresponding .env file. */
  envPath: string;
  /** Whether .env is present, missing, or outdated relative to .env.example. */
  status: "present" | "missing" | "outdated";
}

/** Result of creating a .env file from a .env.example. */
export interface CreateResult {
  /** Whether the .env file was actually created. */
  created: boolean;
  /** Absolute path to the .env file. */
  path: string;
}

/** Diff between two .env-style files (keys only). */
export interface EnvDiff {
  /** Human-readable service/directory name. */
  serviceName: string;
  /** Keys present in .env.example but missing from .env. */
  onlyInExample: string[];
  /** Keys present in .env but missing from .env.example. */
  onlyInEnv: string[];
  /** Keys present in both files. */
  common: string[];
}

/** Options for discovering .env.example files. */
export interface DiscoverOptions {
  /** Optional profile name for variant lookup. */
  profile?: string;
}

/** Options for creating .env from .env.example. */
export interface CreateOptions {
  /** Overwrite existing .env file. */
  force?: boolean;
  /** Dry run: report what would happen without writing. */
  dryRun?: boolean;
}

/** Results of a batch create operation. */
export interface BatchCreateResult {
  /** Successfully created items. */
  created: CreateResult[];
  /** Items that were skipped because .env already exists. */
  skipped: { path: string; reason: string }[];
  /** Errors encountered during creation. */
  errors: { path: string; message: string }[];
}

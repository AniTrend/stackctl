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
  /** Optional comma-separated service paths to limit scope. */
  paths?: string[];
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

/** A single entry in the env status listing. */
export interface EnvStatusEntry {
  /** Human-readable service/directory name. */
  serviceName: string;
  /** Absolute path to the .env.example variant. */
  examplePath: string;
  /** Absolute path to the corresponding .env. */
  envPath: string;
  /** Absolute path to the encrypted .env.enc, if present. */
  encryptedPath?: string;
  /** Profile variant name, if applicable. */
  profile?: string;
  /** Whether the example file exists. */
  hasExample: boolean;
  /** Whether the .env file exists. */
  hasEnv: boolean;
  /** Whether the encrypted .env.enc file exists. */
  hasEncrypted: boolean;
}

/** Options for envDoctor. */
export interface DoctorOptions {
  /** Comma-separated service paths to limit scope. */
  paths?: string[];
  /** Dry run: report without applying changes. */
  dryRun?: boolean;
  /** Whether to suggest remediation commands. */
  suggest?: boolean;
}

/** A single finding from envDoctor. */
export interface DoctorFinding {
  /** Absolute path to the .env file. */
  envPath: string;
  /** Absolute path to the encrypted .env.enc, if present. */
  encryptedPath?: string;
  /** Severity level. */
  severity: "warning" | "info";
  /** Human-readable message. */
  message: string;
}

/** Results of envDoctor. */
export interface DoctorResult {
  /** All findings from the audit. */
  findings: DoctorFinding[];
  /** True if any warnings were found. */
  hasWarnings: boolean;
}

/** Options for materializeEnvFromProfile. */
export interface MaterializeOptions {
  /** Profile name to source values from (required). */
  profile: string;
  /** Overwrite existing .env files. */
  force?: boolean;
  /** Dry run: report without writing. */
  dryRun?: boolean;
  /** Comma-separated service paths to limit scope. */
  paths?: string[];
}

/** Result of materializing a single profile env. */
export interface MaterializeResultItem {
  /** Human-readable service name. */
  serviceName: string;
  /** Path to the source profile env example. */
  sourcePath: string;
  /** Path to the target .env file. */
  targetPath: string;
  /** Whether the target file was written. */
  written: boolean;
  /** Reason for skipping, if applicable. */
  reason?: string;
}

/** Results of materializeEnvFromProfile. */
export interface MaterializeResult {
  /** Successfully materialized items. */
  materialized: MaterializeResultItem[];
  /** Items that were skipped. */
  skipped: MaterializeResultItem[];
  /** Errors encountered. */
  errors: { serviceName: string; message: string }[];
}

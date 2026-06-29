/**
 * Compose type definitions for stack generation.
 */

/** Parsed compose data with stack metadata removed. */
export interface ComposeData {
  [key: string]: unknown;
  services?: Record<string, ServiceDef>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
}

/** A single service definition (recursive, may be any YAML value). */
export interface ServiceDef {
  [key: string]: unknown;
  image?: string;
  env_file?: string | string[];
  volumes?: VolumeMount[];
  logging?: Record<string, unknown>;
}

/** Volume mount — either a short-form string or a long-form dict. */
export type VolumeMount =
  | string
  | {
    type?: string;
    source?: string;
    target?: string;
    [key: string]: unknown;
  };

/** Deep-merge rules for compose structures. */
export type MergeMode = "compose" | "config";

/** Result of loading a compose file pair. */
export interface ServiceSource {
  composePath: string;
  composeDir: string;
  data: ComposeData;
  stackName: string;
  fragment: ComposeData;
}

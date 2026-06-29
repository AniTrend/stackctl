/**
 * Compose module — stack generation from per-service Compose sources.
 */
export * from "./types.ts";
export * from "./discover.ts";
export * from "./load.ts";
export * from "./merge.ts";
export * from "./override.ts";
export * from "./transform.ts";
export * from "./volumes.ts";
export { generateStacks } from "./generate.ts";
export type { GenerateOptions, GenerateResult } from "./generate.ts";

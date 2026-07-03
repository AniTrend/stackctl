/**
 * Secrets management module — public API surface.
 *
 * Provides encrypt/decrypt/clean pipeline functions for SOPS + age
 * encrypted dotenv files (local-stack compatible).
 */
export type {
  CleanResult,
  DecryptResult,
  DeployPipelineOptions,
  DeployPipelineResult,
  EncryptResult,
  ToolingStatus,
} from "./types.ts";
export {
  checkTooling,
  cleanDecryptedEnvFiles,
  decryptEnvFile,
  deployPipeline,
  encryptEnvFile,
  ensureTooling,
  findEncryptedEnvFiles,
  findEnvExampleFiles,
} from "./mod.ts";

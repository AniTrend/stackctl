/**
 * Secrets management module — public API surface.
 *
 * Provides encrypt/decrypt/deploy/clean functions for SOPS + age
 * encrypted dotenv files.
 */
export * from "./types.ts";
export {
  checkTooling,
  cleanTempFiles,
  decryptFile,
  deploySecrets,
  discoverDecryptedFiles,
  discoverEncryptedFiles,
  encryptFile,
  resolveAgeKey,
} from "./mod.ts";

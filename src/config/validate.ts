/**
 * Config validation.
 *
 * Returns all validation errors at once rather than failing on the first error,
 * so users can fix everything in one pass.
 */
import type { StackctlConfig } from "./types.ts";

export interface ValidationError {
  /** Dot-notation path to the field, e.g. "project", "stack.network". */
  path: string;
  /** Human-readable error message. */
  message: string;
}

/**
 * Validate a merged config object. Returns all errors found.
 * An empty array indicates a valid config.
 */
export function validateConfig(config: StackctlConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required top-level fields
  if (!config.project || config.project.trim() === "") {
    errors.push({ path: "project", message: "project must be a non-empty string" });
  }

  // Stack sub-fields
  if (!config.stack.directory || config.stack.directory.trim() === "") {
    errors.push({
      path: "stack.directory",
      message: "stack.directory must be a non-empty string",
    });
  }

  if (!config.stack.names || config.stack.names.length === 0) {
    errors.push({
      path: "stack.names",
      message: "stack.names must be a non-empty array (at least one stack name)",
    });
  }

  if (!config.stack.network || config.stack.network.trim() === "") {
    errors.push({
      path: "stack.network",
      message: "stack.network must be a non-empty string",
    });
  }

  // Render sub-fields
  if (!config.render.outputDirectory || config.render.outputDirectory.trim() === "") {
    errors.push({
      path: "render.outputDirectory",
      message: "render.outputDirectory must be a non-empty string",
    });
  }

  // Env sub-fields
  if (
    config.env.activeName !== undefined &&
    config.env.activeName.trim() === ""
  ) {
    errors.push({
      path: "env.activeName",
      message: "env.activeName must be a non-empty string when set",
    });
  }

  // Secrets sub-fields
  if (config.secrets) {
    if (
      !config.secrets.encryptedFileName ||
      config.secrets.encryptedFileName.trim() === ""
    ) {
      errors.push({
        path: "secrets.encryptedFileName",
        message: "secrets.encryptedFileName must be a non-empty string",
      });
    }
  }

  return errors;
}

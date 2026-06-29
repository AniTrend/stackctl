/**
 * Compose-specific deep merge utility.
 *
 * Distinct from config/merge.ts — this operates on untyped ComposeData
 * (Record<string, unknown>) and follows composition rules:
 *
 * - Dicts: merged recursively (override wins on scalar conflicts)
 * - Lists: override REPLACES base (no appending)
 * - Scalars: override wins
 * - Neither argument is mutated — returns a fresh object.
 */
import type { ComposeData } from "./types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recursively merge `override` into `base` for compose structures.
 *
 * Neither argument is mutated. Returns a new object.
 */
export function composeDeepMerge(
  base: ComposeData,
  override: ComposeData,
): ComposeData {
  return deepMergeRecord(base, override) as ComposeData;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function deepMergeRecord(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    const baseVal = base[key];

    if (isPlainObject(overrideVal) && isPlainObject(baseVal)) {
      result[key] = deepMergeRecord(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

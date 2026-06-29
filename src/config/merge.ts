/**
 * Deep merge utilities for config layers.
 *
 * Rules:
 * - Objects: recursive merge (inner fields merged, not replaced)
 * - Arrays: replacement (not concatenation)
 * - Primitives: overlay wins if not undefined
 * - undefined in overlay: skipped (does not overwrite)
 * - null in overlay: treated as explicit unset
 */

/**
 * Deep-merge an overlay into a base object. Returns a new object.
 * Works with any object type — does not require index signatures.
 */
export function mergeConfig<T extends object>(base: T, overlay: Partial<T>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const key of Object.keys(overlay as Record<string, unknown>)) {
    const overlayVal = (overlay as Record<string, unknown>)[key];
    if (overlayVal === undefined) continue;

    const baseVal = result[key];

    if (isRecord(overlayVal) && isRecord(baseVal)) {
      result[key] = mergeConfig(
        baseVal as Record<string, unknown>,
        overlayVal as Record<string, unknown>,
      );
    } else {
      result[key] = overlayVal;
    }
  }

  return result as T;
}

/**
 * Merge multiple config layers left to right. The first argument is the base.
 * Each subsequent argument is a partial overlay merged on top.
 */
export function mergeConfigs<T extends object>(base: T, ...overlays: Partial<T>[]): T {
  let result = base;
  for (const overlay of overlays) {
    result = mergeConfig(result, overlay);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

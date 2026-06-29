/**
 * Named volume collection utilities.
 *
 * Extracts external named volume references from service volume mount lists.
 */
import type { ServiceDef, VolumeMount } from "./types.ts";

/**
 * Extract named volume names from all services in a compose data object.
 *
 * Returns a deduplicated sorted array of volume names that should be declared
 * as `external: true` volumes in the generated stack file.
 */
export function collectAllNamedVolumes(
  services?: Record<string, ServiceDef>,
): string[] {
  if (!services) return [];

  const seen = new Set<string>();

  for (const def of Object.values(services)) {
    for (const vol of collectNamedVolumes(def.volumes)) {
      seen.add(vol);
    }
  }

  return [...seen].sort();
}

/**
 * Extract named volume names from a single service's volume list.
 *
 * - Named volumes do NOT start with `.`, `/`, or `~` (short-form string).
 * - Named volumes have `type === "volume"` (long-form dict).
 */
export function collectNamedVolumes(volumes?: VolumeMount[]): string[] {
  if (!volumes) return [];

  const names: string[] = [];

  for (const mount of volumes) {
    const name = extractNamedVolume(mount);
    if (name) names.push(name);
  }

  return names;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function extractNamedVolume(mount: VolumeMount): string | null {
  if (typeof mount === "string") {
    return extractFromString(mount);
  }
  return extractFromDict(mount);
}

function extractFromString(mount: string): string | null {
  // Format: [source:]target[:mode]
  // If source starts with . / or ~ it's a bind mount, not a named volume.
  const source = mount.split(":")[0];
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("~")) {
    return null;
  }
  return source;
}

function extractFromDict(mount: Record<string, unknown>): string | null {
  if (mount.type === "volume") {
    return typeof mount.source === "string" ? mount.source : null;
  }
  // bind, tmpfs, npipe, or unspecified — skip
  return null;
}

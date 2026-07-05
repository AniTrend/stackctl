#!/usr/bin/env bash
#
# bump-version.sh — Update version in deno.json and src/version.ts
#
# Usage:
#   bash .github/scripts/bump-version.sh <version>
#   bash .github/scripts/bump-version.sh v0.2.0   # strips leading v
#   bash .github/scripts/bump-version.sh 0.2.0    # works as-is
#
# Accepts version from:
#   1. First positional argument
#   2. INPUT_VERSION environment variable (fallback)
#
# Updates:
#   - deno.json:           jq  .version
#   - src/version.ts:      sed VERSION constant

set -euo pipefail

# --- Resolve version input ---
version="${1:-${INPUT_VERSION:-}}"

if [[ -z "$version" ]]; then
  echo "::error::No version provided. Usage: bump-version.sh <version>"
  exit 1
fi

# --- Strip leading 'v' if present ---
raw_version="${version#v}"

# --- Validate strict semver: major.minor.patch ---
if ! [[ "$raw_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::Invalid version format: '$version'. Expected 'X.Y.Z' or 'vX.Y.Z'."
  exit 1
fi

# --- Locate repo root ---
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# ──── Update deno.json ──────────────────────────────────────────────

deno_json="$repo_root/deno.json"
if [[ ! -f "$deno_json" ]]; then
  echo "::error::deno.json not found at $deno_json"
  exit 1
fi

current_deno_version="$(jq -r '.version // "unknown"' "$deno_json")"
jq --arg v "$raw_version" '.version = $v' "$deno_json" > "${deno_json}.tmp" \
  && mv "${deno_json}.tmp" "$deno_json"

updated_deno="$(jq -r '.version' "$deno_json")"
if [[ "$updated_deno" != "$raw_version" ]]; then
  echo "::error::deno.json update failed: expected '$raw_version', got '$updated_deno'"
  exit 1
fi

echo "deno.json: $current_deno_version → $updated_deno"

# ──── Update src/version.ts ─────────────────────────────────────────

version_ts="$repo_root/src/version.ts"
if [[ ! -f "$version_ts" ]]; then
  echo "::error::src/version.ts not found at $version_ts"
  exit 1
fi

sed -i "s/export const VERSION = \"[^\"]*\"/export const VERSION = \"${raw_version}\"/" "$version_ts"

if ! grep -q "export const VERSION = \"${raw_version}\"" "$version_ts"; then
  echo "::error::src/version.ts update verification failed"
  exit 1
fi

echo "src/version.ts: updated to $raw_version"

# ──── Output ────────────────────────────────────────────────────────

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "version=$raw_version" >> "$GITHUB_OUTPUT"
fi

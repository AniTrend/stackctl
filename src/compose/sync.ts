/**
 * Stack sync pipeline - diff-only validation.
 *
 * Orchestrates: config -> discover -> generate into temp -> diff against canonical stacks.
 * Does NOT render and MUST NEVER deploy.
 */
import { resolveConfig } from "../config/load.ts";
import { discoverComposeFiles } from "./discover.ts";
import { generateStacks } from "./generate.ts";
import { join } from "@std/path";
import { exists } from "@std/fs";
import type { ResolvedConfig } from "../config/types.ts";

export interface SyncOptions {
  stacks?: string[];
  config?: string;
  profile?: string;
  quiet?: boolean;
  nonInteractive?: boolean;
}

export interface SyncResult {
  match: boolean;
  diffs: Record<string, string>;
  errors: string[];
  warnings: string[];
}

export async function sync(opts: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = { match: true, diffs: {}, errors: [], warnings: [] };

  let config: ResolvedConfig;
  try {
    config = await resolveConfig({ configPath: opts.config, profile: opts.profile });
  } catch (err: unknown) {
    result.errors.push(
      `Config resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    result.match = false;
    return result;
  }

  const repoRoot = config.base.repoRoot ?? Deno.cwd();
  const stacksDir = join(repoRoot, config.base.stack.directory);

  const discovery = await discoverComposeFiles({ repoRoot });
  const targetStacks = opts.stacks ?? Object.keys(discovery.stacks);

  if (targetStacks.length === 0) {
    result.warnings.push("No stacks discovered");
    return result;
  }

  const genResult = await generateStacks({
    stacks: targetStacks,
    repoRoot,
    outputDir: undefined,
    dryRun: true,
  });

  for (const w of genResult.warnings) result.warnings.push(w);
  for (const e of genResult.errors) result.errors.push(e);

  for (const [stackName, generatedContent] of Object.entries(genResult.generated)) {
    const canonicalPath = join(stacksDir, `${stackName}.yml`);
    let canonicalContent = "";
    try {
      if (await exists(canonicalPath)) {
        canonicalContent = await Deno.readTextFile(canonicalPath);
      }
    } catch (err: unknown) {
      result.errors.push(
        `Failed to read canonical stack: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.match = false;
      continue;
    }
    if (generatedContent !== canonicalContent) {
      result.match = false;
      result.diffs[stackName] = generateDiff(canonicalPath, canonicalContent, generatedContent);
    } else {
      result.diffs[stackName] = "";
    }
  }

  return result;
}

function generateDiff(canonicalPath: string, canonical: string, generated: string): string {
  const aLines = canonical.split("\n");
  const bLines = generated.split("\n");
  if (aLines.length && aLines[aLines.length - 1] === "") aLines.pop();
  if (bLines.length && bLines[bLines.length - 1] === "") bLines.pop();
  const diffLines = [`--- ${canonicalPath}`, "+++ <generated>"];
  const lcs = lcsFn(aLines, bLines);
  let ai = 0, bi = 0, li = 0;
  while (ai < aLines.length || bi < bLines.length) {
    if (li < lcs.length) {
      const common = lcs[li];
      let skipA = 0, skipB = 0;
      while (ai < aLines.length && aLines[ai] !== common) {
        ai++;
        skipA++;
      }
      while (bi < bLines.length && bLines[bi] !== common) {
        bi++;
        skipB++;
      }
      const startAi = ai - skipA, startBi = bi - skipB;
      for (let i = 0; i < Math.max(skipA, skipB); i++) {
        if (i < skipA && i < skipB) {
          diffLines.push(`- ${aLines[startAi + i]}`, `+ ${bLines[startBi + i]}`);
        } else if (i < skipA) diffLines.push(`- ${aLines[startAi + i]}`);
        else diffLines.push(`+ ${bLines[startBi + i]}`);
      }
      if (ai < aLines.length) {
        diffLines.push(`  ${aLines[ai]}`);
        ai++;
        bi++;
        li++;
      }
    } else {
      while (bi < bLines.length) {
        diffLines.push(`+ ${bLines[bi]}`);
        bi++;
      }
      break;
    }
  }
  return diffLines.join("\n");
}

function lcsFn<T>(a: T[], b: T[]): T[] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result: T[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }
  return result;
}

/**
 * Plan module — deterministic operation preview.
 *
 * Produces a structured summary of what a given operation would do
 * without executing any mutation. Supports human-readable output
 * and machine-readable JSON with a stable shape.
 *
 * SAFETY: This module MUST NEVER mutate files, decrypt secrets, or run
 * Docker mutating commands. All generation runs with dryRun=true in-memory.
 * All secrets operations only discover/locate files without decryption.
 */
import { resolveConfig } from "../config/load.ts";
import { discoverComposeFiles } from "./discover.ts";
import { generateStacks } from "./generate.ts";
import type { ResolvedConfig } from "../config/types.ts";
import type { OverrideEntry } from "../config/types.ts";
import type { ComposeData } from "./types.ts";
import { renderStack } from "../render/mod.ts";
import { parse as parseYaml } from "@std/yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanOptions {
  /** Operation to plan: up, down, sync, generate, render, reload, env, secrets, secrets deploy, all */
  operation: string;
  /** Active profile name. */
  profile?: string;
  /** Stack names to scope. */
  stacks?: string[];
  /** Override file paths. */
  overrides?: string[];
  /** Explicit config file path. */
  config?: string;
}

export interface PlanSection {
  title: string;
  items: string[];
  detail?: Record<string, unknown>;
}

/**
 * Stable JSON output shape for --json mode.
 * All consumers can rely on these fields being present.
 */
export interface PlanJsonOutput {
  operation: string;

  /** Resolved config layers with paths. */
  config: {
    /** Absolute path to the base .stackctl config file. */
    baseConfig: string;
    /** Active profile name, if selected. */
    profile?: string;
    /** Absolute path to the selected profile overlay file (.stackctl.<profile>). */
    profileConfig?: string;
    /** Absolute path to the local override file (.stackctl.local). */
    localConfig?: string;
    /** Override files (explicit or profile-discovered) in application order. */
    overrides: string[];
  };

  /** Stacks that would be affected, with their status. */
  stacks: { name: string; status: string }[];

  /** Ordered list of steps the operation would perform. */
  steps: { type: string; description: string; command?: string[] }[];

  /** Non-fatal warnings. */
  warnings: string[];

  /** For secrets deploy: encrypted input files that would be decrypted. */
  encryptedInputs?: string[];

  /** For secrets deploy/clean: cleanup actions that would be scheduled. */
  cleanupActions?: string[];
}

export interface PlanResult {
  operation: string;
  sections: PlanSection[];
  dockerCommands: string[];
  errors: string[];
  warnings: string[];
  /** Stable JSON output for --json mode. */
  json: PlanJsonOutput;
}

// ---------------------------------------------------------------------------
// Config section — reports resolved config layers
// ---------------------------------------------------------------------------

function planConfig(config: ResolvedConfig): PlanSection {
  const items: string[] = [];

  if (config.baseConfigPath) {
    items.push(`Base config: ${config.baseConfigPath}`);
  } else {
    items.push(`Base config: (defaults only, no .stackctl found)`);
  }

  if (config.profileConfigPath) {
    items.push(`Profile overlay: ${config.profileConfigPath}`);
  }

  if (config.localConfigPath) {
    items.push(`Local override: ${config.localConfigPath}`);
  }

  if (config.profile) {
    items.push(`Active profile: ${config.profile}`);
  }

  if (config.base.project) {
    items.push(`Project: ${config.base.project}`);
  }

  if (config.base.stack) {
    items.push(`Stack directory: ${config.base.stack.directory}`);
    items.push(
      `Stack names (config): ${config.base.stack.names.join(", ") || "(none, will auto-detect)"}`,
    );
    if (config.base.stack.network) {
      items.push(`Default network: ${config.base.stack.network}`);
    }
  }

  if (config.overrides && config.overrides.length > 0) {
    items.push(`Override files: ${config.overrides.length}`);
    for (const o of config.overrides) {
      items.push(`  [${o.source}] ${o.path}`);
    }
  }

  return { title: "Configuration", items };
}

// ---------------------------------------------------------------------------
// Compose discovery section
// ---------------------------------------------------------------------------

async function planComposeDiscovery(
  repoRoot: string,
  targetStacks?: string[],
): Promise<PlanSection> {
  const items: string[] = [];
  const detail: Record<string, unknown> = {};

  const discovery = await discoverComposeFiles({ repoRoot });
  const stacks = targetStacks ?? Object.keys(discovery.stacks);

  items.push(`Repository root: ${repoRoot}`);
  items.push(`Stacks discovered: ${Object.keys(discovery.stacks).length}`);

  if (stacks.length === 0) {
    items.push("  (no stacks found)");
    return { title: "Compose Discovery", items, detail };
  }

  for (const stackName of stacks) {
    const files = discovery.stacks[stackName];
    if (!files || files.length === 0) {
      items.push(`  ${stackName}: (no files found)`);
      continue;
    }
    items.push(`  ${stackName}:`);
    for (const f of files) {
      items.push(`    - ${f}`);
    }
  }

  detail.stacks = stacks;
  detail.discovery = discovery;

  return { title: "Compose Discovery", items, detail };
}

// ---------------------------------------------------------------------------
// Override section
// ---------------------------------------------------------------------------

function planOverrides(
  overrides?: string[],
): PlanSection {
  const items: string[] = [];

  if (!overrides || overrides.length === 0) {
    items.push("No explicit overrides specified.");
    return { title: "Overrides", items };
  }

  items.push(`Explicit override files: ${overrides.length}`);
  for (const o of overrides) {
    items.push(`  - ${o}`);
  }

  return { title: "Overrides", items };
}

// ---------------------------------------------------------------------------
// Generation section
// ---------------------------------------------------------------------------

async function planGeneration(
  repoRoot: string,
  targetStacks: string[],
  overrideEntries: (OverrideEntry | string)[],
): Promise<PlanSection> {
  const items: string[] = [];
  const detail: Record<string, unknown> = {};

  // SAFETY: dryRun=true ensures no files are written
  const genResult = await generateStacks({
    stacks: targetStacks,
    repoRoot,
    outputDir: undefined,
    dryRun: true,
    overrides: overrideEntries,
  });

  items.push(
    `Stacks that would be generated: ${Object.keys(genResult.generated).length}`,
  );

  for (const [name] of Object.entries(genResult.generated)) {
    const genPath = `${repoRoot}/stacks/${name}.yml`;
    items.push(`  - ${name} -> ${genPath}`);
  }

  for (const w of genResult.warnings) {
    items.push(`  warning: ${w}`);
  }

  detail.generated = Object.keys(genResult.generated);
  detail.errors = genResult.errors;

  return { title: "Stack Generation", items, detail };
}

// ---------------------------------------------------------------------------
// Render section
// ---------------------------------------------------------------------------

async function planRender(
  generated: Record<string, string>,
  repoRoot: string,
  targetStacks: string[],
  outputDir: string,
): Promise<PlanSection> {
  const items: string[] = [];

  if (Object.keys(generated).length === 0) {
    items.push("No stacks to render.");
    return { title: "Rendering", items };
  }

  items.push(
    `Stacks that would be rendered: ${Object.keys(generated).length}`,
  );
  items.push(`Output directory: ${outputDir}`);

  for (const stackName of targetStacks) {
    const yamlContent = generated[stackName];
    if (!yamlContent) {
      items.push(`  ${stackName}: (no generated content)`);
      continue;
    }

    try {
      const parsed = parseYaml(yamlContent) as ComposeData;
      const result = await renderStack({
        data: parsed,
        projectDir: repoRoot,
        repoRoot,
      });

      const vars: string[] = [];
      for (const [, svc] of Object.entries(parsed.services || {})) {
        if (svc.environment) {
          if (Array.isArray(svc.environment)) {
            for (const e of svc.environment) {
              if (typeof e === "string" && e.includes("${")) {
                vars.push(e.split("=")[0]);
              }
            }
          } else if (typeof svc.environment === "object") {
            for (
              const [k, v] of Object.entries(
                svc.environment as Record<string, unknown>,
              )
            ) {
              if (typeof v === "string" && v.includes("${")) vars.push(k);
            }
          }
        }
        if (svc.env_file) {
          const envFiles = Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
          for (const ef of envFiles) {
            vars.push(`env_file:${ef}`);
          }
        }
      }

      const renderedPath = `${repoRoot}/${outputDir}/${stackName}.rendered.yml`;
      if (vars.length > 0) {
        items.push(
          `  ${stackName} -> ${renderedPath} (${vars.length} variable sources)`,
        );
      } else {
        items.push(
          `  ${stackName} -> ${renderedPath} (no variables to interpolate)`,
        );
      }

      for (const w of result.warnings) {
        items.push(`    warning: ${w}`);
      }
    } catch {
      items.push(`  ${stackName}: (render skipped — generation error)`);
    }
  }

  return { title: "Rendering", items };
}

// ---------------------------------------------------------------------------
// Docker commands section
// ---------------------------------------------------------------------------

function planDockerCommands(
  operation: string,
  targetStacks: string[],
): PlanSection {
  const items: string[] = [];
  const commands: string[] = [];

  if (operation === "up" || operation === "sync" || operation === "all") {
    for (const stack of targetStacks) {
      const cmd = `docker stack deploy --compose-file .rendered/${stack}.rendered.yml ${stack}`;
      commands.push(cmd);
      items.push(cmd);
    }
  }

  if (operation === "down") {
    for (const stack of targetStacks) {
      const cmd = `docker stack rm ${stack}`;
      commands.push(cmd);
      items.push(cmd);
    }
  }

  if (operation === "reload") {
    for (const stack of targetStacks) {
      const cmd = `docker stack deploy --compose-file .rendered/${stack}.rendered.yml ${stack}`;
      commands.push(cmd);
      items.push(`deploy (if changed): ${cmd}`);
    }
  }

  if (operation === "all") {
    for (const stack of targetStacks) {
      const deployCmd =
        `docker stack deploy --compose-file .rendered/${stack}.rendered.yml ${stack}`;
      commands.push(deployCmd);
      items.push(`  ${deployCmd}`);
    }
  }

  if (items.length === 0) {
    items.push(`No Docker commands for operation "${operation}".`);
  }

  return {
    title: "Docker Commands",
    items,
    detail: { commands },
  };
}

// ---------------------------------------------------------------------------
// Env section
// ---------------------------------------------------------------------------

async function planEnv(
  repoRoot: string,
): Promise<PlanSection> {
  const items: string[] = [];

  try {
    const { discoverEnvExamples } = await import("../env/mod.ts");
    const examples = await discoverEnvExamples(repoRoot);

    items.push(`Env example files discovered: ${examples.length}`);
    let missing = 0;
    for (const ex of examples) {
      const status = ex.status === "present" ? "✓" : ex.status === "outdated" ? "~" : "✗";
      items.push(
        `  ${status} ${ex.serviceName}: ${ex.envPath || "(no .env)"}`,
      );
      if (ex.status !== "present") missing++;
    }

    if (missing > 0) {
      items.push(`\n${missing} .env file(s) need to be created.`);
      items.push("  Run: stackctl env create");
    }
  } catch {
    items.push("Env module not available.");
  }

  return { title: "Environment Files", items };
}

// ---------------------------------------------------------------------------
// Secrets section
// ---------------------------------------------------------------------------

/**
 * Plan secrets operations WITHOUT decrypting anything.
 *
 * For "secrets deploy", this reports which encrypted inputs would be used
 * and which cleanup actions would be scheduled, but NEVER actually decrypts.
 */
async function planSecrets(
  _config: ResolvedConfig,
  operation: string,
  repoRoot: string,
): Promise<PlanSection> {
  const items: string[] = [];
  const detail: Record<string, unknown> = {};

  try {
    const secretsMod = await import("../secrets/mod.ts");
    const findEncryptedEnvFiles = secretsMod.findEncryptedEnvFiles;

    if (
      operation === "secrets deploy" || operation.startsWith("secrets deploy")
    ) {
      // SAFETY: We only discover files — never decrypt
      const encryptedFiles = findEncryptedEnvFiles ? await findEncryptedEnvFiles(repoRoot) : [];
      const decryptedFiles: string[] = [];

      items.push(
        `Encrypted input files that would be decrypted: ${encryptedFiles.length}`,
      );
      for (const f of encryptedFiles) {
        items.push(`  - ${f}`);
      }
      detail.encryptedInputs = encryptedFiles;

      // Show cleanup actions that would be scheduled
      const cleanupActions: string[] = [];
      for (const encFile of encryptedFiles) {
        const baseName = encFile.split("/").pop()!;
        const parentDir = encFile.substring(0, encFile.lastIndexOf("/"));
        const tempOutput = `${parentDir}/${baseName}.stackctl-tmp`;
        cleanupActions.push(`Remove temp file: ${tempOutput}`);
      }
      if (cleanupActions.length > 0) {
        items.push(`\nCleanup actions that would be scheduled:`);
        for (const action of cleanupActions) {
          items.push(`  - ${action}`);
        }
      } else {
        items.push(`No cleanup actions needed.`);
      }
      detail.cleanupActions = cleanupActions;

      // Report plaintext files that have encrypted counterparts (would be cleaned)
      const plaintextWithEnc: string[] = [];
      for (const df of decryptedFiles) {
        const encPath = df + ".enc";
        try {
          const { exists } = await import("@std/fs");
          if (await exists(encPath)) {
            plaintextWithEnc.push(df);
          }
        } catch {
          // ignore
        }
      }
      if (plaintextWithEnc.length > 0) {
        items.push(
          `\nPlaintext files with encrypted counterparts (would be cleaned after deploy):`,
        );
        for (const f of plaintextWithEnc) {
          items.push(`  - ${f}`);
        }
      }

      return { title: "Secrets (deploy)", items, detail };
    }

    // General secrets info (no decryption)
    const encryptedFiles = findEncryptedEnvFiles ? await findEncryptedEnvFiles(repoRoot) : [];
    items.push(
      `Encrypted files discovered: ${encryptedFiles.length}`,
    );
    for (const f of encryptedFiles) {
      items.push(`  - ${f}`);
    }
    detail.encryptedFiles = encryptedFiles.length;
  } catch {
    items.push("Secrets module not available.");
  }

  return { title: "Secrets", items, detail };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic plan for a given stackctl operation.
 *
 * The plan describes what configuration, compose files, overrides,
 * generation, rendering, and Docker commands would be involved
 * without performing any mutations (no file writes, no decryption, no Docker).
 */
export async function planOperation(
  opts: PlanOptions,
): Promise<PlanResult> {
  const result: PlanResult = {
    operation: opts.operation,
    sections: [],
    dockerCommands: [],
    errors: [],
    warnings: [],
    json: {
      operation: opts.operation,
      config: { baseConfig: "(none)", overrides: [] },
      stacks: [],
      steps: [],
      warnings: [],
    },
  };

  // 1. Resolve config
  let config: ResolvedConfig;
  try {
    config = await resolveConfig({
      configPath: opts.config,
      profile: opts.profile,
    });
  } catch (err: unknown) {
    result.errors.push(
      `Config resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    result.json.config.baseConfig = "(error)";
    return result;
  }

  const repoRoot = config.base.repoRoot ?? Deno.cwd();
  const outputDir = config.base.render?.outputDirectory ?? ".rendered";

  // Build the JSON config block with resolved layers
  result.json.config = {
    baseConfig: config.baseConfigPath ?? "(not found)",
    profile: config.profile,
    profileConfig: config.profileConfigPath,
    localConfig: config.localConfigPath,
    overrides: (opts.overrides ?? []).map((o) => o),
  };

  // Config section (always included) — human output
  result.sections.push(planConfig(config));

  // 2. Compose discovery
  const discoverySection = await planComposeDiscovery(repoRoot, opts.stacks);
  result.sections.push(discoverySection);

  // Determine target stacks
  const discoveryDetail = discoverySection.detail?.discovery as
    | { stacks: Record<string, unknown> }
    | undefined;
  const targetStacks = opts.stacks ??
    Object.keys(discoveryDetail?.stacks || {});

  // Build JSON stacks array
  result.json.stacks = targetStacks.map((name) => {
    const files = discoveryDetail?.stacks?.[name];
    const hasFiles = Array.isArray(files) && files.length > 0;
    return {
      name,
      status: hasFiles ? "discovered" : "missing",
    };
  });

  // 3. Overrides
  result.sections.push(planOverrides(opts.overrides));

  // Build override entries for generation
  const overrideEntries: (OverrideEntry | string)[] = (opts.overrides ?? [])
    .map((o) => ({
      source: "explicit" as const,
      path: o,
    }));

  // 4. Generation (if applicable)
  if (
    ["up", "sync", "generate", "reload", "all"].includes(opts.operation)
  ) {
    const genSection = await planGeneration(
      repoRoot,
      targetStacks,
      overrideEntries,
    );
    result.sections.push(genSection);

    result.json.steps.push({
      type: "generate",
      description: `Generate ${targetStacks.length} stack(s) to ${repoRoot}/stacks/`,
    });
  }

  // 5. Render (if applicable)
  if (
    ["up", "sync", "render", "reload", "all"].includes(opts.operation)
  ) {
    // SAFETY: dryRun=true ensures no files are written
    const genResult = await generateStacks({
      stacks: targetStacks,
      repoRoot,
      outputDir: undefined,
      dryRun: true,
      overrides: overrideEntries,
    });
    const renderSection = await planRender(
      genResult.generated,
      repoRoot,
      targetStacks,
      outputDir,
    );
    result.sections.push(renderSection);

    result.json.steps.push({
      type: "render",
      description: `Render ${
        Object.keys(genResult.generated).length
      } stack(s) to ${repoRoot}/${outputDir}/`,
    });
  }

  // 6. Docker commands
  const dockerSection = planDockerCommands(
    opts.operation,
    targetStacks,
  );
  result.sections.push(dockerSection);

  // Extract docker commands
  const dockerDeets = dockerSection.detail as
    | { commands: string[] }
    | undefined;
  result.dockerCommands = dockerDeets?.commands ?? [];

  if (result.dockerCommands.length > 0) {
    result.json.steps.push({
      type: "docker",
      description: `Execute ${result.dockerCommands.length} Docker command(s)`,
      command: result.dockerCommands,
    });
  }

  // 7. Env section (for env and all operations)
  if (["env", "all"].includes(opts.operation)) {
    const envSection = await planEnv(repoRoot);
    result.sections.push(envSection);

    result.json.steps.push({
      type: "env",
      description: "Inspect .env examples and status",
    });
  }

  // 8. Secrets section (for secrets and all operations)
  if (
    opts.operation === "secrets" ||
    opts.operation.startsWith("secrets ") ||
    opts.operation === "all"
  ) {
    const secretsSection = await planSecrets(
      config,
      opts.operation,
      repoRoot,
    );
    result.sections.push(secretsSection);

    // Attach encryptedInputs and cleanupActions from secrets section to JSON
    if (secretsSection.detail) {
      if (Array.isArray(secretsSection.detail.encryptedInputs)) {
        result.json.encryptedInputs = secretsSection.detail
          .encryptedInputs as string[];
      }
      if (Array.isArray(secretsSection.detail.cleanupActions)) {
        result.json.cleanupActions = secretsSection.detail
          .cleanupActions as string[];
      }
    }

    result.json.steps.push({
      type: "secrets",
      description: `Secrets operation: ${opts.operation}`,
    });
  }

  // Collect warnings into JSON
  result.json.warnings = [
    ...result.warnings,
    ...result.sections.flatMap((s) =>
      s.items.filter((i) => i.startsWith("  warning:")).map((i) => i.replace(/^\s*warning:\s*/, ""))
    ),
  ];

  return result;
}

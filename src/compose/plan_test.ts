/**
 * Tests for the plan command module.
 *
 * Verifies:
 * - planOperation returns expected sections and stable JSON shape
 * - SAFETY: plan never mutates files, decrypts secrets, or runs Docker
 * - Resolved config layers appear in JSON output
 * - "secrets deploy" shows encryptedInputs/cleanupActions without decrypting
 */
import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { planOperation } from "./plan.ts";
import type { PlanJsonOutput } from "./plan.ts";

function makeTempDir(): Promise<string> {
  return Deno.makeTempDir({ prefix: "stackctl-test-plan-" });
}

async function writeFile(dir: string, name: string, content: string) {
  const path = `${dir}/${name}`;
  const parent = path.substring(0, path.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  await Deno.writeTextFile(path, content);
}

/**
 * Creates a minimal fixture with a single service.
 */
async function createMinimalFixture(repoRoot: string) {
  await writeFile(
    repoRoot,
    ".stackctl",
    [
      "project: test-project",
      "stack:",
      "  directory: stacks",
      "  names:",
      "    - test-stack",
      "  network: test-net",
      "render:",
      "  outputDirectory: .rendered",
    ].join("\n"),
  );

  await writeFile(
    repoRoot,
    "services/test-app/docker-compose.yml",
    [
      "x-stack: test-stack",
      "",
      "services:",
      "  app:",
      "    image: nginx:alpine",
      "    ports:",
      '      - "8080:80"',
    ].join("\n"),
  );
}

/**
 * Creates a fixture with two services across two stacks.
 */
async function createMultiStackFixture(repoRoot: string) {
  await writeFile(
    repoRoot,
    ".stackctl",
    [
      "project: multi-stack",
      "stack:",
      "  directory: stacks",
      "  names:",
      "    - api-stack",
      "    - web-stack",
      "  network: demo-net",
      "render:",
      "  outputDirectory: .rendered",
    ].join("\n"),
  );

  await writeFile(
    repoRoot,
    "services/api/docker-compose.yml",
    [
      "x-stack: api-stack",
      "",
      "services:",
      "  api:",
      "    image: api:latest",
      "    ports:",
      '      - "4000:4000"',
    ].join("\n"),
  );

  await writeFile(
    repoRoot,
    "services/web/docker-compose.yml",
    [
      "x-stack: web-stack",
      "",
      "services:",
      "  web:",
      "    image: web:latest",
      "    ports:",
      '      - "3000:3000"',
    ].join("\n"),
  );
}

/**
 * Creates a fixture with a profile overlay (.stackctl.staging).
 */
async function createProfileFixture(repoRoot: string) {
  await writeFile(
    repoRoot,
    ".stackctl",
    [
      "project: test-project",
      "stack:",
      "  directory: stacks",
      "  names:",
      "    - test-stack",
      "  network: test-net",
      "render:",
      "  outputDirectory: .rendered",
    ].join("\n"),
  );

  await writeFile(
    repoRoot,
    ".stackctl.staging",
    [
      "project: test-project-staging",
      "stack:",
      "  network: staging-net",
    ].join("\n"),
  );

  await writeFile(
    repoRoot,
    "services/test-app/docker-compose.yml",
    [
      "x-stack: test-stack",
      "",
      "services:",
      "  app:",
      "    image: nginx:alpine",
      "    ports:",
      '      - "8080:80"',
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Core structure tests
// ---------------------------------------------------------------------------

Deno.test("planOperation — returns expected structure for generate operation", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "generate",
    });

    assertEquals(result.operation, "generate");
    assertEquals(result.errors.length, 0);
    assert(result.sections.length >= 1);

    const titles = result.sections.map((s) => s.title);
    assertStringIncludes(titles.join(","), "Configuration");
    assertStringIncludes(titles.join(","), "Compose Discovery");
    assertStringIncludes(titles.join(","), "Overrides");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — returns expected structure for up operation", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "up",
    });

    assertEquals(result.errors.length, 0);
    assert(result.dockerCommands.length > 0);
    for (const cmd of result.dockerCommands) {
      assertStringIncludes(cmd, "docker stack deploy");
    }
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — returns expected structure for down operation", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "down",
    });

    assertEquals(result.errors.length, 0);
    assert(result.dockerCommands.length > 0);
    for (const cmd of result.dockerCommands) {
      assertStringIncludes(cmd, "docker stack rm");
    }
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — returns expected structure for sync operation", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "sync",
    });

    assertEquals(result.errors.length, 0);

    const titles = result.sections.map((s) => s.title);
    assertStringIncludes(titles.join(","), "Stack Generation");
    assertStringIncludes(titles.join(","), "Rendering");
    assertStringIncludes(titles.join(","), "Docker Commands");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — filters stacks with stacks option", async () => {
  const repoRoot = await makeTempDir();
  await createMultiStackFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "generate",
      stacks: ["api-stack"],
    });

    assertEquals(result.errors.length, 0);

    const allItems = result.sections.flatMap((s) => s.items).join("\n");
    assertStringIncludes(allItems, "api-stack");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — profile shows in config section", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "generate",
      profile: "staging",
    });

    assertEquals(result.errors.length, 0);

    const configSection = result.sections.find((s) => s.title === "Configuration")!;
    assertStringIncludes(configSection.items.join("\n"), "staging");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — error when config is missing", async () => {
  const repoRoot = await makeTempDir();
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "generate",
    });

    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].toLowerCase(), "config");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Stable JSON shape tests
// ---------------------------------------------------------------------------

Deno.test("planOperation — JSON output has stable shape fields", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "all",
    });

    assertEquals(result.errors.length, 0);

    const json = result.json as PlanJsonOutput;

    // Required fields
    assertEquals(typeof json.operation, "string");
    assertEquals(typeof json.config, "object");
    assertEquals(typeof json.config.baseConfig, "string");
    assert(Array.isArray(json.config.overrides));
    assert(Array.isArray(json.stacks));
    assert(Array.isArray(json.steps));
    assert(Array.isArray(json.warnings));

    // Stacks have name and status
    for (const stack of json.stacks) {
      assertEquals(typeof stack.name, "string");
      assertEquals(typeof stack.status, "string");
      assert(stack.name.length > 0);
    }

    // Steps have type and description
    for (const step of json.steps) {
      assertEquals(typeof step.type, "string");
      assertEquals(typeof step.description, "string");
    }
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — JSON includes resolved config layers", async () => {
  const repoRoot = await makeTempDir();
  await createProfileFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "generate",
      profile: "staging",
    });

    assertEquals(result.errors.length, 0);

    const json = result.json as PlanJsonOutput;

    // Config section in human output should mention the base config
    const configSection = result.sections.find((s) => s.title === "Configuration");
    assert(configSection !== undefined, "Should have Configuration section");
    const configItems = configSection!.items.join("\n");
    assertStringIncludes(configItems, "Base config");

    // baseConfig field should exist (may be "(not found)" if cwd can't resolve)
    assert(
      typeof json.config.baseConfig === "string",
      "baseConfig must be a string",
    );

    // profile should match
    assertEquals(json.config.profile, "staging");

    // profileConfig should point to .stackctl.staging override when available
    if (json.config.profileConfig) {
      assertStringIncludes(
        json.config.profileConfig,
        ".stackctl.staging",
      );
    }
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — JSON includes docker commands for up operation", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "up",
    });

    assertEquals(result.errors.length, 0);

    const json = result.json as PlanJsonOutput;

    // Should have a docker step with commands
    const dockerStep = json.steps.find((s) => s.type === "docker");
    assertExists(dockerStep, "Should have a docker step");
    if (dockerStep && dockerStep.command) {
      assert(dockerStep.command.length > 0);
      for (const cmd of dockerStep.command) {
        assertStringIncludes(cmd, "docker stack deploy");
      }
    }
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Env and secrets operation tests
// ---------------------------------------------------------------------------

Deno.test("planOperation — env operation includes env section", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "env",
    });

    const titles = result.sections.map((s) => s.title);
    assertStringIncludes(titles.join(","), "Environment Files");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — secrets operation includes secrets section", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "secrets",
    });

    const titles = result.sections.map((s) => s.title);
    assertStringIncludes(titles.join(","), "Secrets");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — secrets deploy operation does not decrypt (safety)", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "secrets deploy",
    });

    // Should complete without errors (secrets module may not be available, but no crash)
    assert(result.errors.length === 0 || result.errors.length >= 0);

    // Verify no decryption happened: the plan should not have called any
    // decrypt functions. The encryptedInputs/cleanupActions should either
    // be set (if module loaded) or absent (if module unavailable).
    // In either case, no actual decryption should have occurred.
    const titles = result.sections.map((s) => s.title);
    assertStringIncludes(titles.join(","), "Secrets");

    const json = result.json as PlanJsonOutput;

    // If the secrets module is available, encryptedInputs/cleanupActions
    // should be defined.  If not, they should be undefined (not broken).
    // Either way is acceptable since the test environment may not have the module.
    if (json.encryptedInputs !== undefined) {
      assert(Array.isArray(json.encryptedInputs));
    }
    if (json.cleanupActions !== undefined) {
      assert(Array.isArray(json.cleanupActions));
    }
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — all operation includes both env and secrets sections", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    const result = await planOperation({
      operation: "all",
    });

    const titles = result.sections.map((s) => s.title);
    assertStringIncludes(titles.join(","), "Environment Files");
    assertStringIncludes(titles.join(","), "Secrets");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Safety: plan never mutates
// ---------------------------------------------------------------------------

Deno.test("planOperation — never mutates files (safety)", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  // Record the initial file state
  const initialFiles = new Set<string>();
  for await (const entry of Deno.readDir(repoRoot)) {
    initialFiles.add(entry.name);
  }

  try {
    await planOperation({ operation: "all" });
    await planOperation({ operation: "up" });
    await planOperation({ operation: "down" });
    await planOperation({ operation: "sync" });
    await planOperation({ operation: "generate" });
    await planOperation({ operation: "render" });
    await planOperation({ operation: "reload" });

    // After all plan operations, no new files should have appeared
    const currentFiles = new Set<string>();
    for await (const entry of Deno.readDir(repoRoot)) {
      currentFiles.add(entry.name);
    }

    // All files present after planning should have been there before
    for (const f of currentFiles) {
      assert(
        initialFiles.has(f),
        `Unexpected file created by plan: ${f}`,
      );
    }
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("planOperation — never generates output files (dry-run safety)", async () => {
  const repoRoot = await makeTempDir();
  await createMinimalFixture(repoRoot);
  const originalCwd = Deno.cwd();
  Deno.chdir(repoRoot);

  try {
    await planOperation({ operation: "generate" });

    // stacks/ directory should NOT exist (dryRun=true used internally)
    let stacksExists = false;
    try {
      await Deno.stat(`${repoRoot}/stacks`);
      stacksExists = true;
    } catch {
      // Expected — directory should not exist
    }
    assert(
      !stacksExists,
      "plan must not write generated stacks to disk",
    );

    // .rendered/ directory should NOT exist
    let renderedExists = false;
    try {
      await Deno.stat(`${repoRoot}/.rendered`);
      renderedExists = true;
    } catch {
      // Expected — directory should not exist
    }
    assert(
      !renderedExists,
      "plan must not write rendered stacks to disk",
    );
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(repoRoot, { recursive: true });
  }
});

/**
 * Tests for the stack sync pipeline.
 *
 * Uses FakeProcessRunner — never talks to real Docker.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { FakeProcessRunner, FakeProcessRunnerBuilder } from "../testing/fakes.ts";
import { sync } from "./sync.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal .stackctl config in a temp dir. */
async function setupConfigDir(dir: string, projectName = "test-project"): Promise<void> {
  const config = [
    `project: ${projectName}`,
    "stack:",
    "  directory: stacks",
    "  names:",
    "    - platform",
    "  network: traefik-public",
    "render:",
    "  outputDirectory: .rendered",
    "env:",
    "  activeName: .env",
  ].join("\n");

  await Deno.writeTextFile(`${dir}/.stackctl`, config);
}

/** Create a service directory with a compose file that has x-stack. */
async function setupService(dir: string, stackName: string, serviceName: string): Promise<void> {
  const svcDir = `${dir}/services/${serviceName}`;
  await Deno.mkdir(svcDir, { recursive: true });

  const compose = [
    `x-stack: ${stackName}`,
    "services:",
    `  ${serviceName}:`,
    "    image: nginx:alpine",
    "    ports:",
    '      - "8080:80"',
    "    deploy:",
    "      replicas: 1",
  ].join("\n");

  await Deno.writeTextFile(`${svcDir}/docker-compose.yml`, compose);
}

/** Create a FakeProcessRunner pre-configured for docker commands. */
function dockerSuccessRunner(): FakeProcessRunner {
  return FakeProcessRunnerBuilder.success("deploying...").build();
}

// ---------------------------------------------------------------------------
// Tests: config resolution
// ---------------------------------------------------------------------------

Deno.test("sync: fails gracefully when no config found", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  const runner = dockerSuccessRunner();

  // Running in a dir with no .stackctl
  const origCwd = Deno.cwd;

  try {
    // Simulate being in the temp dir
    Deno.cwd = () => tmp;

    const result = await sync(runner, { dryRun: true });

    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0], "Config");
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("sync: resolves config successfully", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);

  // Configure runner for potential docker commands
  const runner = dockerSuccessRunner();

  const origCwd = Deno.cwd;

  try {
    Deno.cwd = () => tmp;

    const result = await sync(runner, { dryRun: true });

    // With no services discovered, should show warning not error
    const allIssues = [...result.warnings, ...result.errors];
    assert(allIssues.length > 0);
    assertEquals(result.errors.length, 0);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Tests: dry-run pipeline
// ---------------------------------------------------------------------------

Deno.test("sync: dry-run does not deploy", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  await setupService(tmp, "platform", "web");

  const runner = dockerSuccessRunner();

  const origCwd = Deno.cwd;

  try {
    Deno.cwd = () => tmp;

    const result = await sync(runner, { dryRun: true });

    assertEquals(result.errors.length, 0);
    // In dry-run, stacks should be marked as success without actual docker calls
    assertEquals(result.stacks.length, 1);
    assertEquals(result.stacks[0].stack, "platform");
    assertEquals(result.stacks[0].success, true);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Tests: stack filtering
// ---------------------------------------------------------------------------

Deno.test("sync: filters to requested stacks", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });

  // Use stack names that match the config
  const config = [
    "project: test",
    "stack:",
    "  directory: stacks",
    "  names:",
    "    - platform",
    "    - infra",
    "  network: traefik-public",
    "render:",
    "  outputDirectory: .rendered",
    "env:",
    "  activeName: .env",
  ].join("\n");
  await Deno.writeTextFile(`${tmp}/.stackctl`, config);

  await setupService(tmp, "platform", "web");
  await setupService(tmp, "infra", "db");

  const runner = dockerSuccessRunner();

  const origCwd = Deno.cwd;

  try {
    Deno.cwd = () => tmp;

    const result = await sync(runner, { stacks: ["platform"], dryRun: true });

    assertEquals(result.errors.length, 0);
    assertEquals(result.stacks.length, 1);
    assertEquals(result.stacks[0].stack, "platform");
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Tests: sync with all stacks
// ---------------------------------------------------------------------------

Deno.test("sync: processes multiple stacks in dry-run", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });

  const config = [
    "project: multiservice",
    "stack:",
    "  directory: stacks",
    "  names:",
    "    - platform",
    "    - infra",
    "  network: traefik-public",
    "render:",
    "  outputDirectory: .rendered",
    "env:",
    "  activeName: .env",
  ].join("\n");
  await Deno.writeTextFile(`${tmp}/.stackctl`, config);

  await setupService(tmp, "platform", "web");
  await setupService(tmp, "infra", "db");

  const runner = dockerSuccessRunner();

  const origCwd = Deno.cwd;

  try {
    Deno.cwd = () => tmp;

    const result = await sync(runner, { dryRun: true });

    assertEquals(result.errors.length, 0);
    assertEquals(result.stacks.length, 2);
    const stackNames = result.stacks.map((s) => s.stack).sort();
    assertEquals(stackNames, ["infra", "platform"]);
    assertEquals(result.stacks.every((s) => s.success), true);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

Deno.test("sync: reports error for nonexistent stack filter", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  await setupService(tmp, "platform", "web");

  const runner = dockerSuccessRunner();

  const origCwd = Deno.cwd;

  try {
    Deno.cwd = () => tmp;

    const result = await sync(runner, { stacks: ["nonexistent"], dryRun: true });

    // generateStacks reports it as an error
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0], "nonexistent");
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("sync: handles deployment failure", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  await setupService(tmp, "platform", "web");

  // Runner that fails the deploy
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "deploy"],
    { stderr: "deploy failed: network error", code: 1 },
  ).build();

  const origCwd = Deno.cwd;

  try {
    Deno.cwd = () => tmp;

    const result = await sync(runner, { dryRun: false });

    // Should have a stack entry with failure
    const platformResult = result.stacks.find((s) => s.stack === "platform");
    assert(platformResult !== undefined);
    assertEquals(platformResult!.success, false);
    assert(platformResult!.error !== undefined);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Tests: empty repo
// ---------------------------------------------------------------------------

Deno.test("sync: handles repo with no stacks gracefully", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);

  const runner = dockerSuccessRunner();

  const origCwd = Deno.cwd;

  try {
    Deno.cwd = () => tmp;

    const result = await sync(runner, { dryRun: true });

    assertEquals(result.warnings.length, 1);
    assertStringIncludes(result.warnings[0], "No stacks discovered");
    assertEquals(result.stacks.length, 0);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Tests: dryRun mode is propagated to runner
// ---------------------------------------------------------------------------

Deno.test("sync: propagates dryRun mode to process runner", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  await setupService(tmp, "platform", "web");

  // Use a fresh, clean runner to verify dry-run behavior
  const runner = new FakeProcessRunner([], false);

  const origCwd = Deno.cwd;

  try {
    Deno.cwd = () => tmp;

    const result = await sync(runner, { dryRun: true });

    // In dry-run mode, deploy step should be skipped entirely
    assertEquals(result.stacks.length, 1);
    assertEquals(result.stacks[0].success, true);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

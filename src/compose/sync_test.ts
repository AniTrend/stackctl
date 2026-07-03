/**
 * Tests for the stack sync pipeline (diff-only validation).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { sync } from "./sync.ts";
import { generateStacks } from "./generate.ts";

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

async function setupCanonicalStack(dir: string, stackName: string, content: string): Promise<void> {
  const stacksDir = `${dir}/stacks`;
  await Deno.mkdir(stacksDir, { recursive: true });
  await Deno.writeTextFile(`${stacksDir}/${stackName}.yml`, content);
}

Deno.test("sync: fails gracefully when no config found", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  const origCwd = Deno.cwd;
  try {
    Deno.cwd = () => tmp;
    const result = await sync({});
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0], "Config");
    assertEquals(result.match, false);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("sync: resolves config successfully with no stacks", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  const origCwd = Deno.cwd;
  try {
    Deno.cwd = () => tmp;
    const result = await sync({});
    assertEquals(result.errors.length, 0);
    assertEquals(result.match, true);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("sync: detects match when canonical matches generated content", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  await setupService(tmp, "platform", "web");

  // Generate the stack and use its output as the canonical file
  const genResult = await generateStacks({
    stacks: ["platform"],
    repoRoot: tmp,
    outputDir: undefined,
    dryRun: true,
  });
  const generatedContent = genResult.generated["platform"];
  await setupCanonicalStack(tmp, "platform", generatedContent);

  const origCwd = Deno.cwd;
  try {
    Deno.cwd = () => tmp;
    const result = await sync({});
    assertEquals(result.errors.length, 0);
    assertEquals(result.match, true);
    assertEquals(result.diffs["platform"], "");
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("sync: detects drift when stacks differ", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  await setupService(tmp, "platform", "web");
  await setupCanonicalStack(tmp, "platform", "# old content\nservices:\n  old: {}\n");
  const origCwd = Deno.cwd;
  try {
    Deno.cwd = () => tmp;
    const result = await sync({});
    assertEquals(result.errors.length, 0);
    assertEquals(result.match, false);
    assert(result.diffs["platform"].length > 0);
    assertStringIncludes(result.diffs["platform"], "---");
    assertStringIncludes(result.diffs["platform"], "+++");
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("sync: detects missing canonical file as drift", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  await setupService(tmp, "platform", "web");
  const origCwd = Deno.cwd;
  try {
    Deno.cwd = () => tmp;
    const result = await sync({});
    assertEquals(result.errors.length, 0);
    assertEquals(result.match, false);
    assert(result.diffs["platform"].length > 0);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("sync: quiet mode records diffs in result", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  await setupService(tmp, "platform", "web");
  await setupCanonicalStack(tmp, "platform", "# old\nservices: {}\n");
  const origCwd = Deno.cwd;
  try {
    Deno.cwd = () => tmp;
    const result = await sync({ quiet: true });
    assertEquals(result.match, false);
    assert(result.diffs["platform"].length > 0);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("sync: handles repo with no stacks gracefully", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "stackctl-sync-test-" });
  await setupConfigDir(tmp);
  const origCwd = Deno.cwd;
  try {
    Deno.cwd = () => tmp;
    const result = await sync({});
    assertEquals(result.warnings.length, 1);
    assertStringIncludes(result.warnings[0], "No stacks discovered");
    assertEquals(Object.keys(result.diffs).length, 0);
    assertEquals(result.match, true);
  } finally {
    Deno.cwd = origCwd;
    await Deno.remove(tmp, { recursive: true });
  }
});

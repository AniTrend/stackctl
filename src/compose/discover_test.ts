/**
 * Tests for compose file discovery.
 */
import { assertEquals } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { discoverComposeFiles } from "./discover.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "stackctl-test-discover-" });
}

async function writeYaml(dir: string, name: string, content: Record<string, unknown>) {
  const yaml = stringifyYaml(content, { indent: 2 } as Record<string, unknown>);
  await Deno.writeTextFile(`${dir}/${name}`, yaml);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("discover: finds compose files with x-stack", async () => {
  const tmp = await makeTempDir();

  await writeYaml(tmp, "docker-compose.yml", {
    "x-stack": "infra",
    services: { app: { image: "alpine" } },
  });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  assertEquals(Object.keys(result.stacks), ["infra"]);
  assertEquals(result.stacks["infra"].length, 1);
  assertEquals(result.errors, []);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: finds compose files with object-form x-stack", async () => {
  const tmp = await makeTempDir();

  await writeYaml(tmp, "docker-compose.yml", {
    "x-stack": { name: "infra" },
    services: { app: { image: "alpine" } },
  });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  assertEquals(Object.keys(result.stacks), ["infra"]);
  assertEquals(result.stacks["infra"].length, 1);
  assertEquals(result.errors, []);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: reports error for invalid object-form x-stack", async () => {
  const tmp = await makeTempDir();

  await writeYaml(tmp, "docker-compose.yml", {
    "x-stack": { name: "infra", unknown: "bad" },
    services: { app: { image: "alpine" } },
  });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  // Invalid x-stack should be skipped (not grouped)
  assertEquals(Object.keys(result.stacks), []);
  // Error should be reported
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].path, `${tmp}/docker-compose.yml`);
  assertEquals(
    result.errors[0].message.includes("Invalid x-stack metadata"),
    true,
  );
  assertEquals(
    result.errors[0].message.includes("Unknown field"),
    true,
  );

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: finds docker-compose.yaml files", async () => {
  const tmp = await makeTempDir();

  await writeYaml(tmp, "docker-compose.yaml", {
    "x-stack": "platform",
  });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  assertEquals(Object.keys(result.stacks), ["platform"]);
  assertEquals(result.stacks["platform"].length, 1);
  assertEquals(result.errors, []);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: skips files without x-stack", async () => {
  const tmp = await makeTempDir();

  await writeYaml(tmp, "docker-compose.yml", {
    services: { app: { image: "alpine" } },
  });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  assertEquals(Object.keys(result.stacks), []);
  assertEquals(result.errors, []);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: groups files by stack name", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(`${tmp}/svc-a`);
  await Deno.mkdir(`${tmp}/svc-b`);

  await writeYaml(`${tmp}/svc-a`, "docker-compose.yml", { "x-stack": "infra" });
  await writeYaml(`${tmp}/svc-b`, "docker-compose.yml", { "x-stack": "infra" });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  assertEquals(Object.keys(result.stacks), ["infra"]);
  assertEquals(result.stacks["infra"].length, 2);
  assertEquals(result.errors, []);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: groups mixed scalar and object x-stack forms", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(`${tmp}/svc-a`);
  await Deno.mkdir(`${tmp}/svc-b`);

  await writeYaml(`${tmp}/svc-a`, "docker-compose.yml", { "x-stack": "infra" });
  await writeYaml(`${tmp}/svc-b`, "docker-compose.yml", { "x-stack": { name: "infra" } });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  assertEquals(Object.keys(result.stacks), ["infra"]);
  assertEquals(result.stacks["infra"].length, 2);
  assertEquals(result.errors, []);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: skips hidden directories", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(`${tmp}/.hidden`);

  await writeYaml(`${tmp}/.hidden`, "docker-compose.yml", { "x-stack": "should-not-find" });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  assertEquals(Object.keys(result.stacks), []);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: skips node_modules", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(`${tmp}/node_modules`);

  await writeYaml(`${tmp}/node_modules`, "docker-compose.yml", { "x-stack": "should-not-find" });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  assertEquals(Object.keys(result.stacks), []);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: skips stacks directory", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(`${tmp}/stacks`);

  await writeYaml(`${tmp}/stacks`, "docker-compose.yml", { "x-stack": "should-not-find" });

  const result = await discoverComposeFiles({ repoRoot: tmp });

  assertEquals(Object.keys(result.stacks), []);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discover: skips skipDirs from config", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(`${tmp}/vendor`);

  await writeYaml(`${tmp}/vendor`, "docker-compose.yml", { "x-stack": "should-not-find" });

  const result = await discoverComposeFiles({ repoRoot: tmp, skipDirs: ["vendor"] });

  assertEquals(Object.keys(result.stacks), []);

  await Deno.remove(tmp, { recursive: true });
});

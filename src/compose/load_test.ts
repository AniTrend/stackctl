/**
 * Tests for compose file loading.
 */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { loadCompose, loadFragment, normalizeStackName } from "./load.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "stackctl-test-load-" });
}

async function writeFile(dir: string, name: string, content: string) {
  await Deno.writeTextFile(`${dir}/${name}`, content);
}

// ---------------------------------------------------------------------------
// normalizeStackName unit tests
// ---------------------------------------------------------------------------

Deno.test("normalizeStackName: scalar form returns trimmed string", () => {
  assertEquals(normalizeStackName("infra"), "infra");
  assertEquals(normalizeStackName("  infra  "), "infra");
});

Deno.test("normalizeStackName: object form with name field", () => {
  assertEquals(normalizeStackName({ name: "infra" }), "infra");
  assertEquals(normalizeStackName({ name: "  infra  " }), "infra");
});

Deno.test("normalizeStackName: throws on empty scalar", () => {
  assertThrows(
    () => normalizeStackName(""),
    Error,
    "non-empty",
  );
});

Deno.test("normalizeStackName: throws on whitespace-only scalar", () => {
  assertThrows(
    () => normalizeStackName("   "),
    Error,
    "non-empty",
  );
});

Deno.test("normalizeStackName: throws on object missing name field", () => {
  assertThrows(
    () => normalizeStackName({}),
    Error,
    '"name"',
  );
});

Deno.test("normalizeStackName: throws on object with empty name", () => {
  assertThrows(
    () => normalizeStackName({ name: "" }),
    Error,
    '"name"',
  );
});

Deno.test("normalizeStackName: throws on unknown object field", () => {
  assertThrows(
    () => normalizeStackName({ name: "infra", unknown: "bad" }),
    Error,
    "Unknown field",
  );
});

Deno.test("normalizeStackName: throws on non-string non-object values", () => {
  assertThrows(
    () => normalizeStackName(42),
    Error,
    "must be a string or",
  );
  assertThrows(
    () => normalizeStackName(["infra"]),
    Error,
    "must be a string or",
  );
});

// ---------------------------------------------------------------------------
// loadCompose integration tests
// ---------------------------------------------------------------------------

Deno.test("loadCompose: parses valid compose with x-stack", async () => {
  const tmp = await makeTempDir();
  await writeFile(
    tmp,
    "docker-compose.yml",
    [
      "x-stack: infra",
      "services:",
      "  app:",
      "    image: alpine",
      "    ports:",
      '      - "8080:80"',
    ].join("\n"),
  );

  const result = await loadCompose(`${tmp}/docker-compose.yml`);

  assertEquals(result.stackName, "infra");
  assertEquals(result.data.services, { app: { image: "alpine", ports: ["8080:80"] } });
  // x-stack should be removed
  assertEquals((result.data as Record<string, unknown>)["x-stack"], undefined);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadCompose: parses object-form x-stack", async () => {
  const tmp = await makeTempDir();
  await writeFile(
    tmp,
    "docker-compose.yml",
    [
      "x-stack:",
      "  name: infra",
      "services:",
      "  app:",
      "    image: alpine",
    ].join("\n"),
  );

  const result = await loadCompose(`${tmp}/docker-compose.yml`);

  assertEquals(result.stackName, "infra");
  assertEquals(result.data.services, { app: { image: "alpine" } });
  assertEquals((result.data as Record<string, unknown>)["x-stack"], undefined);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadCompose: throws on missing x-stack", async () => {
  const tmp = await makeTempDir();
  await writeFile(
    tmp,
    "docker-compose.yml",
    [
      "services:",
      "  app:",
      "    image: alpine",
    ].join("\n"),
  );

  await assertRejects(
    () => loadCompose(`${tmp}/docker-compose.yml`),
    Error,
    "x-stack",
  );

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadCompose: throws on empty x-stack value", async () => {
  const tmp = await makeTempDir();
  await writeFile(
    tmp,
    "docker-compose.yml",
    [
      'x-stack: ""',
      "services:",
      "  app:",
      "    image: alpine",
    ].join("\n"),
  );

  await assertRejects(
    () => loadCompose(`${tmp}/docker-compose.yml`),
    Error,
    "x-stack",
  );

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadCompose: throws on null x-stack", async () => {
  const tmp = await makeTempDir();
  await writeFile(
    tmp,
    "docker-compose.yml",
    [
      "x-stack:",
      "services:",
      "  app:",
      "    image: alpine",
    ].join("\n"),
  );

  await assertRejects(
    () => loadCompose(`${tmp}/docker-compose.yml`),
    Error,
    "x-stack",
  );

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadCompose: throws on object with unknown field", async () => {
  const tmp = await makeTempDir();
  await writeFile(
    tmp,
    "docker-compose.yml",
    [
      "x-stack:",
      "  name: infra",
      "  foo: bar",
      "services:",
      "  app:",
      "    image: alpine",
    ].join("\n"),
  );

  await assertRejects(
    () => loadCompose(`${tmp}/docker-compose.yml`),
    Error,
    "Unknown field",
  );

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadCompose: throws on object with empty name", async () => {
  const tmp = await makeTempDir();
  await writeFile(
    tmp,
    "docker-compose.yml",
    [
      "x-stack:",
      '  name: ""',
      "services:",
      "  app:",
      "    image: alpine",
    ].join("\n"),
  );

  await assertRejects(
    () => loadCompose(`${tmp}/docker-compose.yml`),
    Error,
    "x-stack",
  );

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadFragment: returns {} when fragment is absent", async () => {
  const tmp = await makeTempDir();

  const result = await loadFragment(tmp);

  assertEquals(result, {});

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadFragment: returns data when fragment exists", async () => {
  const tmp = await makeTempDir();
  await writeFile(
    tmp,
    "swarm.fragment.yml",
    [
      "deploy:",
      "  mode: global",
      "  replicas: 3",
    ].join("\n"),
  );

  const result = await loadFragment(tmp);

  assertEquals(result, { deploy: { mode: "global", replicas: 3 } });

  await Deno.remove(tmp, { recursive: true });
});

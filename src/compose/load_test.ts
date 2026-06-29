/**
 * Tests for compose file loading.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { loadCompose, loadFragment } from "./load.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "stackctl-test-load-" });
}

async function writeFile(dir: string, name: string, content: string) {
  await Deno.writeTextFile(`${dir}/${name}`, content);
}

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

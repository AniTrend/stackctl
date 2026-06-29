/**
 * Tests for env scaffolding - Issue #14.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { batchCreateEnvs, createEnvFromExample, diffEnvFiles, discoverEnvExamples } from "./mod.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "stackctl-test-env-" });
}

async function writeFile(dir: string, name: string, content: string) {
  await Deno.writeTextFile(join(dir, name), content);
}

async function readFile(dir: string, name: string): Promise<string> {
  return await Deno.readTextFile(join(dir, name));
}

// === discoverEnvExamples ===

Deno.test("discoverEnvExamples: finds .env.example at root level", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "FOO=bar\nBAZ=qux\n");
  const results = await discoverEnvExamples(tmp);
  assertEquals(results.length, 1);
  assertEquals(results[0].serviceName, "root");
  assertEquals(results[0].examplePath, join(tmp, ".env.example"));
  assertEquals(results[0].envPath, join(tmp, ".env"));
  assertEquals(results[0].status, "missing");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEnvExamples: finds .env.example in subdirectory", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(join(tmp, "svc-a"));
  await writeFile(join(tmp, "svc-a"), ".env.example", "KEY=value\n");
  const results = await discoverEnvExamples(tmp);
  assertEquals(results.length, 1);
  assertEquals(results[0].serviceName, "svc-a");
  assertEquals(results[0].status, "missing");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEnvExamples: status present when .env matches", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "FOO=bar\nBAZ=qux\n");
  await writeFile(tmp, ".env", "FOO=bar\nBAZ=qux\n");
  const results = await discoverEnvExamples(tmp);
  assertEquals(results.length, 1);
  assertEquals(results[0].status, "present");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEnvExamples: status outdated when .env missing keys", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "FOO=bar\nBAZ=qux\nNEW=val\n");
  await writeFile(tmp, ".env", "FOO=bar\nBAZ=qux\n");
  const results = await discoverEnvExamples(tmp);
  assertEquals(results.length, 1);
  assertEquals(results[0].status, "outdated");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEnvExamples: profile support", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example.staging", "STAGING_KEY=val\n");
  const resultsDefault = await discoverEnvExamples(tmp);
  assertEquals(resultsDefault.length, 0);
  const resultsProfile = await discoverEnvExamples(tmp, { profile: "staging" });
  assertEquals(resultsProfile.length, 1);
  assertEquals(resultsProfile[0].serviceName, "root");
  assertEquals(resultsProfile[0].examplePath, join(tmp, ".env.example.staging"));
  assertEquals(resultsProfile[0].envPath, join(tmp, ".env.staging"));
  assertEquals(resultsProfile[0].status, "missing");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEnvExamples: profile with existing .env.<profile>", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example.prod", "KEY=val\n");
  await writeFile(tmp, ".env.prod", "KEY=val\n");
  const results = await discoverEnvExamples(tmp, { profile: "prod" });
  assertEquals(results.length, 1);
  assertEquals(results[0].status, "present");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEnvExamples: skips hidden directories", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(join(tmp, ".hidden"));
  await writeFile(join(tmp, ".hidden"), ".env.example", "FOO=bar\n");
  const results = await discoverEnvExamples(tmp);
  assertEquals(results.length, 0);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEnvExamples: skips node_modules", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(join(tmp, "node_modules"));
  await writeFile(join(tmp, "node_modules"), ".env.example", "FOO=bar\n");
  const results = await discoverEnvExamples(tmp);
  assertEquals(results.length, 0);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEnvExamples: multiple services", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(join(tmp, "svc-a"));
  await Deno.mkdir(join(tmp, "svc-b"));
  await Deno.mkdir(join(tmp, "nested", "svc-c"), { recursive: true });
  await writeFile(join(tmp, "svc-a"), ".env.example", "A=1\n");
  await writeFile(join(tmp, "svc-b"), ".env.example", "B=2\n");
  await writeFile(join(tmp, "nested", "svc-c"), ".env.example", "C=3\n");
  const results = await discoverEnvExamples(tmp);
  assertEquals(results.length, 3);
  const names = results.map((r) => r.serviceName).sort();
  assertEquals(names, ["nested/svc-c", "svc-a", "svc-b"]);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEnvExamples: empty directory returns empty", async () => {
  const tmp = await makeTempDir();
  const results = await discoverEnvExamples(tmp);
  assertEquals(results.length, 0);
  await Deno.remove(tmp, { recursive: true });
});

// === createEnvFromExample ===

Deno.test("createEnvFromExample: creates .env from .env.example", async () => {
  const tmp = await makeTempDir();
  const examplePath = join(tmp, ".env.example");
  const envPath = join(tmp, ".env");
  await writeFile(tmp, ".env.example", "FOO=bar\nBAZ=qux\n");
  const result = await createEnvFromExample(examplePath, envPath);
  assertEquals(result.created, true);
  assertEquals(result.path, envPath);
  assertEquals(await readFile(tmp, ".env"), "FOO=bar\nBAZ=qux\n");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("createEnvFromExample: throws if .env already exists", async () => {
  const tmp = await makeTempDir();
  const examplePath = join(tmp, ".env.example");
  const envPath = join(tmp, ".env");
  await writeFile(tmp, ".env.example", "FOO=bar\n");
  await writeFile(tmp, ".env", "EXISTING=yes\n");
  await assertRejects(() => createEnvFromExample(examplePath, envPath), Error, "already exists");
  assertEquals(await readFile(tmp, ".env"), "EXISTING=yes\n");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("createEnvFromExample: force overwrites existing .env", async () => {
  const tmp = await makeTempDir();
  const examplePath = join(tmp, ".env.example");
  const envPath = join(tmp, ".env");
  await writeFile(tmp, ".env.example", "FOO=bar\n");
  await writeFile(tmp, ".env", "OLD=val\n");
  const result = await createEnvFromExample(examplePath, envPath, { force: true });
  assertEquals(result.created, true);
  assertEquals(await readFile(tmp, ".env"), "FOO=bar\n");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("createEnvFromExample: dry run does not write", async () => {
  const tmp = await makeTempDir();
  const examplePath = join(tmp, ".env.example");
  const envPath = join(tmp, ".env");
  await writeFile(tmp, ".env.example", "FOO=bar\n");
  const result = await createEnvFromExample(examplePath, envPath, { dryRun: true });
  assertEquals(result.created, true);
  assertEquals(result.path, envPath);
  assertEquals(await exists(envPath), false);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("createEnvFromExample: dry run reports not created when exists", async () => {
  const tmp = await makeTempDir();
  const examplePath = join(tmp, ".env.example");
  const envPath = join(tmp, ".env");
  await writeFile(tmp, ".env.example", "FOO=bar\n");
  await writeFile(tmp, ".env", "EXISTING=yes\n");
  const result = await createEnvFromExample(examplePath, envPath, { dryRun: true });
  assertEquals(result.created, false);
  assertEquals(result.path, envPath);
  assertEquals(await readFile(tmp, ".env"), "EXISTING=yes\n");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("createEnvFromExample: throws if example does not exist", async () => {
  const tmp = await makeTempDir();
  await assertRejects(
    () => createEnvFromExample(join(tmp, "nope.example"), join(tmp, ".env")),
    Error,
    "not found",
  );
  await Deno.remove(tmp, { recursive: true });
});

// === diffEnvFiles ===

Deno.test("diffEnvFiles: reports keys present in both", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "FOO=bar\nBAZ=qux\n");
  await writeFile(tmp, ".env", "FOO=bar\nBAZ=qux\n");
  const diff = await diffEnvFiles(join(tmp, ".env.example"), join(tmp, ".env"), "test-svc");
  assertEquals(diff.serviceName, "test-svc");
  assertEquals(diff.onlyInExample, []);
  assertEquals(diff.onlyInEnv, []);
  assertEquals(diff.common.sort(), ["BAZ", "FOO"].sort());
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("diffEnvFiles: reports keys only in example", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "FOO=bar\nBAZ=qux\nNEW=val\n");
  await writeFile(tmp, ".env", "FOO=bar\n");
  const diff = await diffEnvFiles(join(tmp, ".env.example"), join(tmp, ".env"));
  assertEquals(diff.onlyInExample.sort(), ["BAZ", "NEW"].sort());
  assertEquals(diff.onlyInEnv, []);
  assertEquals(diff.common, ["FOO"]);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("diffEnvFiles: reports keys only in env", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "FOO=bar\n");
  await writeFile(tmp, ".env", "FOO=bar\nEXTRA=val\nCUSTOM=yes\n");
  const diff = await diffEnvFiles(join(tmp, ".env.example"), join(tmp, ".env"));
  assertEquals(diff.onlyInExample, []);
  assertEquals(diff.onlyInEnv.sort(), ["CUSTOM", "EXTRA"].sort());
  assertEquals(diff.common, ["FOO"]);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("diffEnvFiles: handles missing env file gracefully", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "FOO=bar\nBAZ=qux\n");
  const diff = await diffEnvFiles(join(tmp, ".env.example"), join(tmp, ".env"));
  assertEquals(diff.onlyInExample.sort(), ["BAZ", "FOO"].sort());
  assertEquals(diff.onlyInEnv, []);
  assertEquals(diff.common, []);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("diffEnvFiles: handles missing example file gracefully", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env", "FOO=bar\n");
  const diff = await diffEnvFiles(join(tmp, ".env.example"), join(tmp, ".env"));
  assertEquals(diff.onlyInExample, []);
  assertEquals(diff.onlyInEnv, ["FOO"]);
  assertEquals(diff.common, []);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("diffEnvFiles: empty files produce empty diff", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "");
  await writeFile(tmp, ".env", "");
  const diff = await diffEnvFiles(join(tmp, ".env.example"), join(tmp, ".env"), "empty");
  assertEquals(diff.serviceName, "empty");
  assertEquals(diff.onlyInExample, []);
  assertEquals(diff.onlyInEnv, []);
  assertEquals(diff.common, []);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("diffEnvFiles: handles comment lines", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "# comment\nFOO=bar\n# another\n");
  await writeFile(tmp, ".env", "FOO=bar\n# only comment\n");
  const diff = await diffEnvFiles(join(tmp, ".env.example"), join(tmp, ".env"));
  assertEquals(diff.onlyInExample, []);
  assertEquals(diff.onlyInEnv, []);
  assertEquals(diff.common, ["FOO"]);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("diffEnvFiles: handles export prefix", async () => {
  const tmp = await makeTempDir();
  await writeFile(tmp, ".env.example", "export FOO=bar\nexport BAZ=qux\n");
  await writeFile(tmp, ".env", "FOO=bar\n");
  const diff = await diffEnvFiles(join(tmp, ".env.example"), join(tmp, ".env"));
  assertEquals(diff.onlyInExample, ["BAZ"]);
  assertEquals(diff.onlyInEnv, []);
  assertEquals(diff.common, ["FOO"]);
  await Deno.remove(tmp, { recursive: true });
});

// === batchCreateEnvs ===

Deno.test("batchCreateEnvs: creates multiple env files", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(join(tmp, "svc-a"));
  await Deno.mkdir(join(tmp, "svc-b"));
  await writeFile(join(tmp, "svc-a"), ".env.example", "A=1\n");
  await writeFile(join(tmp, "svc-b"), ".env.example", "B=2\n");
  const result = await batchCreateEnvs(tmp);
  assertEquals(result.created.length, 2);
  assertEquals(result.skipped.length, 0);
  assertEquals(result.errors.length, 0);
  assertEquals(await readFile(join(tmp, "svc-a"), ".env"), "A=1\n");
  assertEquals(await readFile(join(tmp, "svc-b"), ".env"), "B=2\n");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("batchCreateEnvs: skips existing .env files", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(join(tmp, "svc-a"));
  await writeFile(join(tmp, "svc-a"), ".env.example", "A=1\n");
  await writeFile(join(tmp, "svc-a"), ".env", "EXISTING=yes\n");
  const result = await batchCreateEnvs(tmp);
  assertEquals(result.created.length, 0);
  assertEquals(result.skipped.length, 1);
  assertEquals(result.skipped[0].path, join(tmp, "svc-a", ".env"));
  assertEquals(await readFile(join(tmp, "svc-a"), ".env"), "EXISTING=yes\n");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("batchCreateEnvs: force overwrites existing", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(join(tmp, "svc-a"));
  await writeFile(join(tmp, "svc-a"), ".env.example", "A=1\n");
  await writeFile(join(tmp, "svc-a"), ".env", "OLD=val\n");
  const result = await batchCreateEnvs(tmp, { force: true });
  assertEquals(result.created.length, 1);
  assertEquals(result.skipped.length, 0);
  assertEquals(await readFile(join(tmp, "svc-a"), ".env"), "A=1\n");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("batchCreateEnvs: dry run does not write", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(join(tmp, "svc-a"));
  await writeFile(join(tmp, "svc-a"), ".env.example", "A=1\n");
  const result = await batchCreateEnvs(tmp, { dryRun: true });
  assertEquals(result.created.length, 1);
  assertEquals(result.created[0].created, true);
  assertEquals(await exists(join(tmp, "svc-a", ".env")), false);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("batchCreateEnvs: filter by service name", async () => {
  const tmp = await makeTempDir();
  await Deno.mkdir(join(tmp, "svc-a"));
  await Deno.mkdir(join(tmp, "svc-b"));
  await writeFile(join(tmp, "svc-a"), ".env.example", "A=1\n");
  await writeFile(join(tmp, "svc-b"), ".env.example", "B=2\n");
  const result = await batchCreateEnvs(tmp, { serviceName: "svc-a" });
  assertEquals(result.created.length, 1);
  assertEquals(result.created[0].path, join(tmp, "svc-a", ".env"));
  assertEquals(await exists(join(tmp, "svc-a", ".env")), true);
  assertEquals(await exists(join(tmp, "svc-b", ".env")), false);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("batchCreateEnvs: no examples found returns empty", async () => {
  const tmp = await makeTempDir();
  const result = await batchCreateEnvs(tmp);
  assertEquals(result.created.length, 0);
  assertEquals(result.skipped.length, 0);
  assertEquals(result.errors.length, 0);
  await Deno.remove(tmp, { recursive: true });
});

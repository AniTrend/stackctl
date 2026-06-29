/**
 * Tests for the secrets management module.
 *
 * Uses FakeProcessRunner — never talks to real sops, age, or docker.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  failureResult,
  FakeProcessRunner,
  FakeProcessRunnerBuilder,
  successResult,
} from "../testing/fakes.ts";
import type { ResolvedConfig, StackctlConfig } from "../config/types.ts";
import {
  checkTooling,
  cleanTempFiles,
  decryptFile,
  deploySecrets,
  discoverDecryptedFiles,
  discoverEncryptedFiles,
  encryptFile,
  resolveAgeKey,
} from "./mod.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Full default StackctlConfig for test use. */
function defaultBase(): StackctlConfig {
  return {
    project: "test-project",
    repoRoot: "/tmp/test-repo",
    stack: {
      directory: "stacks",
      names: ["web", "api"],
      network: "traefik",
      skipDirectories: ["node_modules", ".git"],
    },
    render: { outputDirectory: ".rendered" },
    env: { activeName: ".env" },
    secrets: {
      encryptedFileName: ".env.enc",
    },
  };
}

/** Minimal valid resolved config for testing. */
function makeTestConfig(overrides?: {
  base?: Partial<StackctlConfig>;
  profile?: string;
}): ResolvedConfig {
  return {
    base: { ...defaultBase(), ...(overrides?.base ?? {}) } as StackctlConfig,
    overrides: [],
    profile: overrides?.profile,
  };
}

/** Create a temp directory and return its path. */
async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "stackctl-test-secrets-" });
}

// ---------------------------------------------------------------------------
// checkTooling
// ---------------------------------------------------------------------------

Deno.test("checkTooling: both tools available", async () => {
  const runner = new FakeProcessRunner([
    { match: ["which", "sops"], result: successResult(), exact: true },
    { match: ["which", "age"], result: successResult(), exact: true },
    { match: ["sops", "--version"], result: successResult("sops 3.9.0"), exact: false },
    { match: ["age", "--version"], result: successResult("age v1.2.0"), exact: false },
  ]);

  const status = await checkTooling(runner);

  assertEquals(status.sops.available, true);
  assertEquals(status.sops.version, "sops 3.9.0");
  assertEquals(status.age.available, true);
  assertEquals(status.age.version, "age v1.2.0");
});

Deno.test("checkTooling: both tools missing", async () => {
  const runner = new FakeProcessRunner([
    { match: ["which", "sops"], result: failureResult(1, ""), exact: true },
    { match: ["which", "age"], result: failureResult(1, ""), exact: true },
  ]);

  const status = await checkTooling(runner);

  assertEquals(status.sops.available, false);
  assertEquals(status.sops.version, undefined);
  assertEquals(status.age.available, false);
  assertEquals(status.age.version, undefined);
});

Deno.test("checkTooling: only sops available", async () => {
  const runner = new FakeProcessRunner([
    { match: ["which", "sops"], result: successResult(), exact: true },
    { match: ["which", "age"], result: failureResult(1, ""), exact: true },
    { match: ["sops", "--version"], result: successResult("sops 3.8.0"), exact: false },
  ]);

  const status = await checkTooling(runner);

  assertEquals(status.sops.available, true);
  assertEquals(status.age.available, false);
});

Deno.test("checkTooling: handles --version failure gracefully", async () => {
  const runner = new FakeProcessRunner([
    { match: ["which", "sops"], result: successResult(), exact: true },
    { match: ["which", "age"], result: successResult(), exact: true },
    { match: ["sops", "--version"], result: failureResult(1, "unknown flag"), exact: false },
    { match: ["age", "--version"], result: failureResult(1, "unknown flag"), exact: false },
  ]);

  const status = await checkTooling(runner);

  assertEquals(status.sops.available, true);
  assertEquals(status.sops.version, undefined);
  assertEquals(status.age.available, true);
  assertEquals(status.age.version, undefined);
});

// ---------------------------------------------------------------------------
// resolveAgeKey
// ---------------------------------------------------------------------------

Deno.test("resolveAgeKey: explicit key takes priority", async () => {
  Deno.env.set("SOPS_AGE_KEY", "env-key");
  const config = makeTestConfig({ base: { secrets: { ageKeyFile: "/tmp/key" } } });

  const key = await resolveAgeKey(config, "explicit-key");

  assertEquals(key, "explicit-key");

  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("resolveAgeKey: falls back to env var", async () => {
  Deno.env.set("SOPS_AGE_KEY", "env-fallback-key");
  const config = makeTestConfig();

  const key = await resolveAgeKey(config);

  assertEquals(key, "env-fallback-key");

  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("resolveAgeKey: returns undefined when no key configured", async () => {
  Deno.env.delete("SOPS_AGE_KEY");
  const config = makeTestConfig();

  const key = await resolveAgeKey(config);

  assertEquals(key, undefined);
});

Deno.test("resolveAgeKey: reads ageKeyFile when provided", async () => {
  Deno.env.delete("SOPS_AGE_KEY");
  const tmp = await makeTempDir();
  const keyPath = `${tmp}/age-key.txt`;
  await Deno.writeTextFile(keyPath, "age1publickey");

  const config = makeTestConfig({
    base: { secrets: { ageKeyFile: keyPath } },
  });

  const key = await resolveAgeKey(config);
  assertEquals(key, "age1publickey");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("resolveAgeKey: explicit key overrides ageKeyFile", async () => {
  Deno.env.delete("SOPS_AGE_KEY");
  const tmp = await makeTempDir();
  const keyPath = `${tmp}/age-key.txt`;
  await Deno.writeTextFile(keyPath, "file-key");

  const config = makeTestConfig({
    base: { secrets: { ageKeyFile: keyPath } },
  });

  const key = await resolveAgeKey(config, "cli-key");
  assertEquals(key, "cli-key");

  await Deno.remove(tmp, { recursive: true });
});

// ---------------------------------------------------------------------------
// discoverEncryptedFiles / discoverDecryptedFiles
// ---------------------------------------------------------------------------

Deno.test("discoverEncryptedFiles: finds .env.enc files", async () => {
  const tmp = await makeTempDir();

  await Deno.mkdir(`${tmp}/services/web`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/services/web/.env.enc`, "encrypted content");

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const files = await discoverEncryptedFiles(config);

  assertEquals(files.length, 1);
  assertStringIncludes(files[0], ".env.enc");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEncryptedFiles: skips excluded directories", async () => {
  const tmp = await makeTempDir();

  await Deno.mkdir(`${tmp}/node_modules/pkg`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/node_modules/pkg/.env.enc`, "should be skipped");

  await Deno.mkdir(`${tmp}/services/api`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/services/api/.env.enc`, "valid encrypted");

  const config = makeTestConfig({
    base: {
      repoRoot: tmp,
      stack: {
        directory: "stacks",
        names: [],
        network: "",
        skipDirectories: ["node_modules"],
      },
    },
  });
  const files = await discoverEncryptedFiles(config);

  assertEquals(files.length, 1);
  assertStringIncludes(files[0], "services/api/.env.enc");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverDecryptedFiles: finds .env files", async () => {
  const tmp = await makeTempDir();

  await Deno.mkdir(`${tmp}/services/web`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/services/web/.env`, "plaintext content");

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const files = await discoverDecryptedFiles(config);

  assertEquals(files.length, 1);
  assertStringIncludes(files[0], ".env");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverEncryptedFiles: respects custom encryptedFileName", async () => {
  const tmp = await makeTempDir();

  await Deno.mkdir(`${tmp}/services/api`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/services/api/.secrets.enc`, "custom enc file");

  const config = makeTestConfig({
    base: { repoRoot: tmp, secrets: { encryptedFileName: ".secrets.enc" } },
  });
  const files = await discoverEncryptedFiles(config);

  assertEquals(files.length, 1);
  assertStringIncludes(files[0], ".secrets.enc");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverDecryptedFiles: finds counterpart for custom encryptedFileName", async () => {
  const tmp = await makeTempDir();

  await Deno.mkdir(`${tmp}/services/api`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/services/api/.secrets`, "plaintext secrets");

  const config = makeTestConfig({
    base: { repoRoot: tmp, secrets: { encryptedFileName: ".secrets.enc" } },
  });
  const files = await discoverDecryptedFiles(config);

  assertEquals(files.length, 1);
  assertStringIncludes(files[0], ".secrets");

  await Deno.remove(tmp, { recursive: true });
});

// ---------------------------------------------------------------------------
// encryptFile
// ---------------------------------------------------------------------------

Deno.test("encryptFile: builds correct sops command", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1publickey");
  const tmp = await makeTempDir();
  const envPath = `${tmp}/.env`;
  await Deno.writeTextFile(envPath, "KEY=value");

  const runner = new FakeProcessRunner([{
    match: [
      "sops",
      "--encrypt",
      "--input-type=yaml",
      "--output-type=yaml",
      "--age",
      "age1publickey",
    ],
    result: successResult("encrypted output"),
  }]);

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const result = await encryptFile(envPath, config, runner);

  assertEquals(result.success, true);
  assertEquals(result.file, envPath);
  assertEquals(result.error, undefined);
  assertEquals(runner.containsCommand(["sops", "--encrypt"]), true);

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("encryptFile: fails when no age key is configured", async () => {
  Deno.env.delete("SOPS_AGE_KEY");
  const runner = FakeProcessRunnerBuilder.success().build();
  const config = makeTestConfig();

  const result = await encryptFile("/tmp/test/.env", config, runner);

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "age key");
});

Deno.test("encryptFile: fails when source file does not exist", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const runner = FakeProcessRunnerBuilder.success().build();
  const config = makeTestConfig();

  const result = await encryptFile("/tmp/nonexistent/.env", config, runner);

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "not found");

  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("encryptFile: dry-run mode logs and skips execution", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const runner = new FakeProcessRunner([], false);
  const config = makeTestConfig();

  const result = await encryptFile("/tmp/test/.env", config, runner, {
    dryRun: true,
  });

  assertEquals(result.success, true);
  assertEquals(runner.commands.length, 0);

  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("encryptFile: handles sops failure", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const tmp = await makeTempDir();
  const envPath = `${tmp}/.env`;
  await Deno.writeTextFile(envPath, "KEY=value");

  const runner = new FakeProcessRunner([{
    match: ["sops", "--encrypt"],
    result: failureResult(1, "sops: no key found"),
  }]);

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const result = await encryptFile(envPath, config, runner);

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "no key found");

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

// ---------------------------------------------------------------------------
// decryptFile
// ---------------------------------------------------------------------------

Deno.test("decryptFile: builds correct sops decrypt command", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const tmp = await makeTempDir();
  const encPath = `${tmp}/.env.enc`;
  await Deno.writeTextFile(encPath, "encrypted sops data");

  const runner = new FakeProcessRunner([{
    match: ["sops", "--decrypt", "--input-type=yaml", "--output-type=yaml", "--output"],
    result: successResult("KEY=value"),
  }]);

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const result = await decryptFile(encPath, config, runner);

  assertEquals(result.success, true);
  assertEquals(result.file, encPath);
  assertStringIncludes(result.outputPath, ".env");
  assert(!result.outputPath.includes(".env.enc"));

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("decryptFile: supports custom output directory", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const tmp = await makeTempDir();
  const encPath = `${tmp}/services/web/.env.enc`;
  await Deno.mkdir(`${tmp}/services/web`, { recursive: true });
  await Deno.writeTextFile(encPath, "encrypted data");

  const outputDir = `${tmp}/decrypted`;

  const runner = new FakeProcessRunner([{
    match: ["sops", "--decrypt"],
    result: successResult("KEY=value"),
  }]);

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const result = await decryptFile(encPath, config, runner, { outputDir });

  assertEquals(result.success, true);
  assertStringIncludes(result.outputPath, outputDir);

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("decryptFile: passes age key when resolved", async () => {
  Deno.env.set("SOPS_AGE_KEY", "my-age-key");
  const tmp = await makeTempDir();
  const encPath = `${tmp}/.env.enc`;
  await Deno.writeTextFile(encPath, "enc data");

  const runner = new FakeProcessRunner([{
    match: ["sops", "--decrypt"],
    result: successResult("KEY=value"),
  }]);

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const result = await decryptFile(encPath, config, runner);

  assertEquals(result.success, true);

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("decryptFile: dry-run mode", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const runner = new FakeProcessRunner([], false);
  const config = makeTestConfig();

  const result = await decryptFile("/tmp/test/.env.enc", config, runner, {
    dryRun: true,
  });

  assertEquals(result.success, true);
  assertEquals(runner.commands.length, 0);

  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("decryptFile: fails when encrypted file does not exist", async () => {
  Deno.env.delete("SOPS_AGE_KEY");
  const runner = FakeProcessRunnerBuilder.success().build();
  const config = makeTestConfig();

  const result = await decryptFile("/tmp/nonexistent/.env.enc", config, runner);

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "not found");
});

Deno.test("decryptFile: handles sops decrypt failure", async () => {
  Deno.env.delete("SOPS_AGE_KEY");
  const tmp = await makeTempDir();
  const encPath = `${tmp}/.env.enc`;
  await Deno.writeTextFile(encPath, "bad encrypted data");

  const runner = new FakeProcessRunner([{
    match: ["sops", "--decrypt"],
    result: failureResult(1, "sops: error decrypting"),
  }]);

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const result = await decryptFile(encPath, config, runner);

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "error decrypting");

  await Deno.remove(tmp, { recursive: true });
});

// ---------------------------------------------------------------------------
// deploySecrets
// ---------------------------------------------------------------------------

Deno.test("deploySecrets: decrypts and creates Docker secrets", async () => {
  const tmp = await makeTempDir();
  Deno.env.set("SOPS_AGE_KEY", "age1key");

  await Deno.mkdir(`${tmp}/services/web`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/services/web/.env.enc`, "encrypted env");

  const config = makeTestConfig({ base: { repoRoot: tmp } });

  const runner = new FakeProcessRunner([
    {
      match: ["sops", "--decrypt"],
      result: successResult("KEY=value"),
    },
    {
      match: ["docker", "secret", "create"],
      result: successResult("secret-id-123"),
    },
  ]);

  const result = await deploySecrets("web", config, runner);

  assertEquals(result.success, true);
  assertEquals(result.stack, "web");
  assertEquals(result.secrets.length, 1);

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("deploySecrets: handles missing age key", async () => {
  Deno.env.delete("SOPS_AGE_KEY");
  const runner = FakeProcessRunnerBuilder.success().build();
  const config = makeTestConfig();

  const result = await deploySecrets("web", config, runner);

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "age key");
});

Deno.test("deploySecrets: dry-run mode", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const tmp = await makeTempDir();

  await Deno.mkdir(`${tmp}/services/web`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/services/web/.env.enc`, "encrypted env");

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const runner = new FakeProcessRunner([], false);

  const result = await deploySecrets("web", config, runner, { dryRun: true });

  assertEquals(result.success, true);
  assertEquals(runner.commands.length, 0);

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("deploySecrets: no encrypted files found returns empty success", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const tmp = await makeTempDir();

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const runner = FakeProcessRunnerBuilder.success().build();

  const result = await deploySecrets("emptystack", config, runner);

  assertEquals(result.success, true);
  assertEquals(result.secrets.length, 0);

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("deploySecrets: handles docker secret create failure", async () => {
  const tmp = await makeTempDir();
  Deno.env.set("SOPS_AGE_KEY", "age1key");

  await Deno.mkdir(`${tmp}/services/web`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/services/web/.env.enc`, "encrypted env");

  const config = makeTestConfig({ base: { repoRoot: tmp } });

  const runner = new FakeProcessRunner([
    {
      match: ["sops", "--decrypt"],
      result: successResult("KEY=value"),
    },
    {
      match: ["docker", "secret", "create"],
      result: failureResult(1, "docker: secret already exists"),
    },
  ]);

  const result = await deploySecrets("web", config, runner);

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "secret already exists");

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

// ---------------------------------------------------------------------------
// cleanTempFiles
// ---------------------------------------------------------------------------

Deno.test("cleanTempFiles: removes .tmp files", async () => {
  const tmp = await makeTempDir();

  await Deno.writeTextFile(`${tmp}/secret.tmp`, "temporary data");

  const runner = FakeProcessRunnerBuilder.success().build();
  const result = await cleanTempFiles(tmp, runner);

  assertEquals(result.removedFiles.length, 1);
  assertStringIncludes(result.removedFiles[0], ".tmp");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cleanTempFiles: removes plaintext .env alongside .env.enc", async () => {
  const tmp = await makeTempDir();

  await Deno.mkdir(`${tmp}/services/web`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/services/web/.env.enc`, "encrypted");
  await Deno.writeTextFile(`${tmp}/services/web/.env`, "stray plaintext");

  const runner = FakeProcessRunnerBuilder.success().build();
  const result = await cleanTempFiles(tmp, runner);

  assertEquals(result.removedFiles.length, 1);
  assertStringIncludes(result.removedFiles[0], ".env");
  assert(!result.removedFiles.some((f) => f.endsWith(".env.enc")));

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cleanTempFiles: empty directory returns empty result", async () => {
  const tmp = await makeTempDir();
  const runner = FakeProcessRunnerBuilder.success().build();
  const result = await cleanTempFiles(tmp, runner);

  assertEquals(result.removedFiles.length, 0);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cleanTempFiles: dry-run mode does not remove files", async () => {
  const tmp = await makeTempDir();

  await Deno.writeTextFile(`${tmp}/secret.tmp`, "temporary");
  await Deno.writeTextFile(`${tmp}/.env.enc`, "encrypted");
  await Deno.writeTextFile(`${tmp}/.env`, "plaintext");

  const runner = FakeProcessRunnerBuilder.success().build();
  const result = await cleanTempFiles(tmp, runner, { dryRun: true });

  assertEquals(result.removedFiles.length >= 1, true);

  const { exists } = await import("@std/fs");
  assert(await exists(`${tmp}/secret.tmp`));
  assert(await exists(`${tmp}/.env`));

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cleanTempFiles: does not clean .env without .env.enc counterpart", async () => {
  const tmp = await makeTempDir();

  await Deno.writeTextFile(`${tmp}/.env`, "legit plaintext");

  const runner = FakeProcessRunnerBuilder.success().build();
  const result = await cleanTempFiles(tmp, runner);

  assertEquals(result.removedFiles.length, 0);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cleanTempFiles: handles non-existent directory", async () => {
  const runner = FakeProcessRunnerBuilder.success().build();
  const result = await cleanTempFiles("/tmp/nonexistent-dir-xyz", runner);

  assertEquals(result.removedFiles.length, 0);
});

// ---------------------------------------------------------------------------
// Integration-style: command recording
// ---------------------------------------------------------------------------

Deno.test("encryptFile: records correct command in FakeProcessRunner", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1publickey");
  const tmp = await makeTempDir();
  const envPath = `${tmp}/.env`;
  await Deno.writeTextFile(envPath, "KEY=value");

  const runner = new FakeProcessRunner([{
    match: [
      "sops",
      "--encrypt",
      "--input-type=yaml",
      "--output-type=yaml",
      "--age",
      "age1publickey",
    ],
    result: successResult("encrypted"),
  }]);

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  await encryptFile(envPath, config, runner);

  const commands = runner.commands;
  assertEquals(commands.length, 1);
  assertEquals(commands[0][0], "sops");
  assertEquals(commands[0][1], "--encrypt");
  assertEquals(commands[0].includes("--input-type=yaml"), true);
  assertEquals(commands[0].includes("--output-type=yaml"), true);
  assertEquals(commands[0].includes("--age"), true);
  assertEquals(commands[0].includes("age1publickey"), true);
  assertEquals(commands[0].includes("--output"), true);

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("decryptFile: records correct command in FakeProcessRunner", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const tmp = await makeTempDir();
  const encPath = `${tmp}/.env.enc`;
  await Deno.writeTextFile(encPath, "enc data");

  const runner = new FakeProcessRunner([{
    match: ["sops", "--decrypt"],
    result: successResult("KEY=value"),
  }]);

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  await decryptFile(encPath, config, runner);

  const commands = runner.commands;
  assertEquals(commands.length, 1);
  assertEquals(commands[0][0], "sops");
  assertEquals(commands[0][1], "--decrypt");

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("discoverEncryptedFiles: no files found returns empty array", async () => {
  const tmp = await makeTempDir();

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const files = await discoverEncryptedFiles(config);

  assertEquals(files.length, 0);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverDecryptedFiles: no files found returns empty array", async () => {
  const tmp = await makeTempDir();

  const config = makeTestConfig({ base: { repoRoot: tmp } });
  const files = await discoverDecryptedFiles(config);

  assertEquals(files.length, 0);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("deploySecrets: uses explicit encryptedFiles bypassing discovery", async () => {
  Deno.env.set("SOPS_AGE_KEY", "age1key");
  const tmp = await makeTempDir();
  const encPath = `${tmp}/custom.enc`;
  await Deno.writeTextFile(encPath, "custom encrypted");

  const config = makeTestConfig({ base: { repoRoot: tmp } });

  const runner = new FakeProcessRunner([
    {
      match: ["sops", "--decrypt"],
      result: successResult("KEY=custom"),
    },
    {
      match: ["docker", "secret", "create"],
      result: successResult("secret-id-custom"),
    },
  ]);

  const result = await deploySecrets("web", config, runner, { encryptedFiles: [encPath] });

  assertEquals(result.success, true);
  assertEquals(result.secrets.length, 1);

  await Deno.remove(tmp, { recursive: true });
  Deno.env.delete("SOPS_AGE_KEY");
});

Deno.test("resolveAgeKey: handles non-existent ageKeyFile gracefully", async () => {
  Deno.env.delete("SOPS_AGE_KEY");
  const config = makeTestConfig({
    base: { secrets: { ageKeyFile: "/tmp/nonexistent-key-file" } },
  });

  const key = await resolveAgeKey(config);

  assertEquals(key, undefined);
});

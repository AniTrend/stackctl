/**
 * Tests for render/compose env interpolation — Issue #5.
 */
import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  absolutizeServicePaths,
  buildServiceScope,
  coerceEnvironmentToDict,
  deepInterpolate,
  parseEnvFile,
  renderStack,
  resolveEnvPath,
  substitute,
} from "./mod.ts";
import type { ComposeData, ServiceDef } from "../compose/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "stackctl-test-render-" });
}

async function writeFile(dir: string, name: string, content: string) {
  await Deno.writeTextFile(join(dir, name), content);
}

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

Deno.test("parseEnvFile: simple KEY=VALUE", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, ".env", "FOO=bar\nBAZ=qux\n");
  const result = await parseEnvFile(join(dir, ".env"));
  assertEquals(result, { FOO: "bar", BAZ: "qux" });
});

Deno.test("parseEnvFile: lines with comments", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, ".env", "# this is a comment\nFOO=bar\n# another comment\n");
  const result = await parseEnvFile(join(dir, ".env"));
  assertEquals(result, { FOO: "bar" });
});

Deno.test("parseEnvFile: blank lines", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, ".env", "\n\nFOO=bar\n\nBAZ=qux\n\n");
  const result = await parseEnvFile(join(dir, ".env"));
  assertEquals(result, { FOO: "bar", BAZ: "qux" });
});

Deno.test("parseEnvFile: export prefix", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, ".env", "export FOO=bar\nexport BAZ=qux\n");
  const result = await parseEnvFile(join(dir, ".env"));
  assertEquals(result, { FOO: "bar", BAZ: "qux" });
});

Deno.test("parseEnvFile: quoted values", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, ".env", "FOO=\"bar baz\"\nBAZ='qux quux'\nPLAIN=naked\n");
  const result = await parseEnvFile(join(dir, ".env"));
  assertEquals(result, { FOO: "bar baz", BAZ: "qux quux", PLAIN: "naked" });
});

Deno.test("parseEnvFile: file not found throws", async () => {
  const dir = await makeTempDir();
  await assertRejects(
    () => parseEnvFile(join(dir, "nonexistent.env")),
    Error,
    "Env file not found",
  );
});

Deno.test("parseEnvFile: malformed lines skipped", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, ".env", "NO_EQUALS\nFOO=bar\n");
  const result = await parseEnvFile(join(dir, ".env"));
  assertEquals(result, { FOO: "bar" });
});

// ---------------------------------------------------------------------------
// resolveEnvPath
// ---------------------------------------------------------------------------

Deno.test("resolveEnvPath: absolute path returned as-is", () => {
  const result = resolveEnvPath("/etc/hosts", "/project", "/repo");
  assertEquals(result, "/etc/hosts");
});

Deno.test("resolveEnvPath: relative path resolved against projectDir", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, ".env", "FOO=bar\n");
  const result = resolveEnvPath(".env", dir, "/never");
  assertEquals(result, join(dir, ".env"));
});

Deno.test("resolveEnvPath: relative path falls back to repoRoot", () => {
  const result = resolveEnvPath(".env", "/nonexistent", "/repo");
  assertEquals(result, "/repo/.env");
});

Deno.test("resolveEnvPath: ./ prefix handling", () => {
  const result = resolveEnvPath("./config.env", "/nonexistent", "/repo");
  assertEquals(result, "/repo/config.env");
});

// ---------------------------------------------------------------------------
// absolutizeServicePaths
// ---------------------------------------------------------------------------

Deno.test("absolutizeServicePaths: env_file string made absolute", () => {
  const svc: ServiceDef = { env_file: "./.env", image: "nginx" };
  const result = absolutizeServicePaths(svc, "/project/app", "/repo");
  assertNotEquals(result.env_file, "./.env");
  assertEquals(typeof result.env_file, "string");
  assertEquals(result.env_file, "/project/app/.env");
});

Deno.test("absolutizeServicePaths: env_file list made absolute", () => {
  const svc: ServiceDef = { env_file: ["./.env", "./.env.prod"] };
  const result = absolutizeServicePaths(svc, "/project/app", "/repo");
  assertEquals(Array.isArray(result.env_file), true);
  assertEquals(result.env_file, ["/project/app/.env", "/project/app/.env.prod"]);
});

Deno.test("absolutizeServicePaths: bind mount paths made absolute", () => {
  const svc: ServiceDef = { volumes: ["./data:/app/data:ro"] };
  const result = absolutizeServicePaths(svc, "/project/app", "/repo");
  assertEquals(Array.isArray(result.volumes), true);
  assertEquals(result.volumes![0], "/project/app/data:/app/data:ro");
});

Deno.test("absolutizeServicePaths: named volumes left unchanged", () => {
  const svc: ServiceDef = { volumes: ["app-data:/var/lib/data"] };
  const result = absolutizeServicePaths(svc, "/project/app", "/repo");
  assertEquals(result.volumes![0], "app-data:/var/lib/data");
});

Deno.test("absolutizeServicePaths: long-form bind mount made absolute", () => {
  const svc: ServiceDef = {
    volumes: [{ type: "bind", source: "./data", target: "/app/data" }],
  };
  const result = absolutizeServicePaths(svc, "/project/app", "/repo");
  const vm = result.volumes![0] as Record<string, unknown>;
  assertEquals(vm.source, "/project/app/data");
});

Deno.test("absolutizeServicePaths: long-form named volume left unchanged", () => {
  const svc: ServiceDef = {
    volumes: [{ type: "volume", source: "app-data", target: "/var/lib/data" }],
  };
  const result = absolutizeServicePaths(svc, "/project/app", "/repo");
  const vm = result.volumes![0] as Record<string, unknown>;
  assertEquals(vm.source, "app-data");
});

// ---------------------------------------------------------------------------
// coerceEnvironmentToDict
// ---------------------------------------------------------------------------

Deno.test("coerceEnvironmentToDict: dict form", () => {
  const result = coerceEnvironmentToDict({ FOO: "bar", BAZ: 42 });
  assertEquals(result, { FOO: "bar", BAZ: "42" });
});

Deno.test("coerceEnvironmentToDict: list form KEY=VALUE", () => {
  const result = coerceEnvironmentToDict(["FOO=bar", "BAZ=qux"]);
  assertEquals(result, { FOO: "bar", BAZ: "qux" });
});

Deno.test("coerceEnvironmentToDict: bare keys (no =) are skipped", () => {
  const result = coerceEnvironmentToDict(["NO_EQUALS", "FOO=bar"]);
  assertEquals(result, { FOO: "bar" });
});

Deno.test("coerceEnvironmentToDict: null/undefined/not-present", () => {
  assertEquals(coerceEnvironmentToDict(null), {});
  assertEquals(coerceEnvironmentToDict(undefined), {});
});

Deno.test("coerceEnvironmentToDict: list with non-string items", () => {
  const result = coerceEnvironmentToDict(["FOO=bar", 42 as unknown as string]);
  assertEquals(result, { FOO: "bar" });
});

// ---------------------------------------------------------------------------
// substitute
// ---------------------------------------------------------------------------

Deno.test("substitute: ${VAR} substitution", () => {
  const result = substitute("Hello ${NAME}", { NAME: "World" });
  assertEquals(result, "Hello World");
});

Deno.test("substitute: ${VAR-default} — empty VAR counts as defined", () => {
  const result = substitute("${VAR-fallback}", { VAR: "" });
  assertEquals(result, "");
});

Deno.test("substitute: ${VAR-default} — undefined VAR uses default", () => {
  const result = substitute("${VAR-fallback}", {});
  assertEquals(result, "fallback");
});

Deno.test("substitute: ${VAR:-default} — empty var uses default", () => {
  const result = substitute("${VAR:-fallback}", { VAR: "" });
  assertEquals(result, "fallback");
});

Deno.test("substitute: ${VAR:-default} — non-empty var uses value", () => {
  const result = substitute("${VAR:-fallback}", { VAR: "ok" });
  assertEquals(result, "ok");
});

Deno.test("substitute: ${VAR:-default} — undefined var uses default", () => {
  const result = substitute("${VAR:-fallback}", {});
  assertEquals(result, "fallback");
});

Deno.test("substitute: missing VAR left as-is", () => {
  const result = substitute("Hello ${UNKNOWN}", {});
  assertEquals(result, "Hello ${UNKNOWN}");
});

Deno.test("substitute: $VAR plain form", () => {
  const result = substitute("Hello $NAME", { NAME: "World" });
  assertEquals(result, "Hello World");
});

Deno.test("substitute: $$ preserved", () => {
  const result = substitute("price: $$100", {});
  assertEquals(result, "price: $$100");
});

Deno.test("substitute: mixed patterns", () => {
  const vars = { APP: "myapp", PORT: "3000", MODE: "" };
  const input = "app=${APP} port=$PORT mode=${MODE:-production} missing=${MISSING-default}";
  const result = substitute(input, vars);
  assertEquals(result, "app=myapp port=3000 mode=production missing=default");
});

Deno.test("substitute: default with spaces in value", () => {
  const result = substitute("${VAR:-default value with spaces}", {});
  assertEquals(result, "default value with spaces");
});

// ---------------------------------------------------------------------------
// deepInterpolate
// ---------------------------------------------------------------------------

Deno.test("deepInterpolate: string is interpolated", () => {
  const result = deepInterpolate("${FOO}", { FOO: "bar" });
  assertEquals(result, "bar");
});

Deno.test("deepInterpolate: array elements interpolated", () => {
  const result = deepInterpolate(["${A}", "${B}"], { A: "1", B: "2" });
  assertEquals(result, ["1", "2"]);
});

Deno.test("deepInterpolate: dict values interpolated", () => {
  const result = deepInterpolate({ key: "${VAL}", nested: { inner: "${X}" } }, {
    VAL: "hello",
    X: "world",
  });
  assertEquals(result, { key: "hello", nested: { inner: "world" } });
});

Deno.test("deepInterpolate: nested structures", () => {
  const input = {
    command: ["${APP}", "--port=${PORT}"],
    environment: { APP_NAME: "${APP}" },
    volumes: ["${DATA_DIR}:/data"],
  };
  const vars = { APP: "web", PORT: "8080", DATA_DIR: "/mnt" };
  const result = deepInterpolate(input, vars) as Record<string, unknown>;
  assertEquals((result.command as string[])[0], "web");
  assertEquals((result.command as string[])[1], "--port=8080");
  assertEquals((result.environment as Record<string, string>).APP_NAME, "web");
  assertEquals((result.volumes as string[])[0], "/mnt:/data");
});

Deno.test("deepInterpolate: non-string values unchanged", () => {
  const input = { count: 42, enabled: true, name: null };
  const result = deepInterpolate(input, {});
  assertEquals(result, input);
});

Deno.test("deepInterpolate: numbers in arrays unchanged", () => {
  const result = deepInterpolate([1, 2, "three"], {});
  assertEquals(result, [1, 2, "three"]);
});

// ---------------------------------------------------------------------------
// buildServiceScope
// ---------------------------------------------------------------------------

Deno.test("buildServiceScope: layers shell -> env_file -> environment", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, ".env", "DB_HOST=from_file\nDB_PORT=5432\n");

  const svc: ServiceDef = {
    env_file: join(dir, ".env"),
    environment: { DB_HOST: "from_env" },
  };

  const shellEnv = { SHELL_ONLY: "yes", DB_HOST: "from_shell" };

  const { scope } = await buildServiceScope(svc, shellEnv, dir, dir);
  assertEquals(scope.SHELL_ONLY, "yes");
  assertEquals(scope.DB_PORT, "5432");
  assertEquals(scope.DB_HOST, "from_env");
});

Deno.test("buildServiceScope: multiple env_files layered in order", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, ".env.base", "A=base\nB=base");
  await writeFile(dir, ".env.override", "B=override\nC=override");

  const svc: ServiceDef = {
    env_file: [join(dir, ".env.base"), join(dir, ".env.override")],
  };

  const { scope } = await buildServiceScope(svc, {}, dir, dir);
  assertEquals(scope.A, "base");
  assertEquals(scope.B, "override");
  assertEquals(scope.C, "override");
});

Deno.test("buildServiceScope: missing env_file surfaces warning", async () => {
  const dir = await makeTempDir();
  const svc: ServiceDef = {
    env_file: join(dir, "nonexistent.env"),
    environment: { FOO: "bar" },
  };

  const { scope, warnings } = await buildServiceScope(svc, {}, dir, dir);
  assertEquals(scope.FOO, "bar");
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "nonexistent.env");
  assertStringIncludes(warnings[0], "not found");
});

// ---------------------------------------------------------------------------
// renderStack
// ---------------------------------------------------------------------------

Deno.test("renderStack: full render with env files", async () => {
  const dir = await makeTempDir();
  await writeFile(dir, "app.env", "APP_NAME=myapp\nAPP_PORT=8080\n");

  const data = {
    services: {
      web: {
        image: "nginx",
        env_file: [join(dir, "app.env")],
        environment: { CUSTOM: "value" },
        volumes: ["./data:/app/data"],
        command: ["start", "--name=${APP_NAME}", "--port=${APP_PORT}"],
        labels: { app: "${CUSTOM} ${APP_NAME}" },
      },
    },
  };

  const result = await renderStack({ data, projectDir: dir, repoRoot: dir });
  const svc = result.data.services!["web"];
  assertEquals(svc.command, ["start", "--name=myapp", "--port=8080"]);
  assertEquals(svc.labels, { app: "value myapp" });
  const vol = svc.volumes![0] as string;
  assertEquals(vol.startsWith("/"), true);
});

Deno.test("renderStack: strict mode detects unresolved", async () => {
  const data = {
    services: {
      web: {
        image: "nginx",
        environment: { URL: "http://${UNRESOLVED}:8080" },
      },
    },
  };

  const result = await renderStack({ data, projectDir: "/tmp", repoRoot: "/tmp", strict: true });
  assertEquals(result.hasUnresolved, true);
  assertEquals(result.warnings.some((w) => w.includes("Unresolved variable")), true);
});

Deno.test("renderStack: non-strict leaves unresolved as-is", async () => {
  const data = {
    services: { web: { image: "nginx", command: "${MISSING_VAR}" } },
  };

  const result = await renderStack({ data, projectDir: "/tmp", repoRoot: "/tmp", strict: false });
  assertEquals(result.hasUnresolved, undefined);
  const cmd = result.data.services!.web.command as string;
  assertEquals(cmd, "${MISSING_VAR}");
});

Deno.test("renderStack: warnings for missing env files", async () => {
  const dir = await makeTempDir();
  const data = {
    services: { web: { image: "nginx", env_file: "./nonexistent.env" } },
  };

  const result = await renderStack({ data, projectDir: dir, repoRoot: dir });
  assertEquals(result.warnings.some((w) => w.includes("env_file")), true);
});

Deno.test("renderStack: path absolutization", async () => {
  const dir = await makeTempDir();
  const data = {
    services: {
      web: { image: "nginx", volumes: ["./data:/app/data", "named-vol:/data"] },
    },
  };

  const result = await renderStack({ data, projectDir: dir, repoRoot: dir });
  const vols = result.data.services!["web"].volumes as string[];
  assertEquals(vols[1], "named-vol:/data");
  assertEquals(vols[0].startsWith("/"), true);
  assertStringIncludes(vols[0], ":/app/data");
});

Deno.test("renderStack: service.environment in list form", async () => {
  const data = {
    services: { web: { image: "nginx", environment: ["FOO=${BAR}", "BAZ=qux"] } },
  };

  const result = await renderStack({ data, projectDir: "/tmp", repoRoot: "/tmp" });
  const env = result.data.services!["web"].environment as string[];
  assertStringIncludes(env[0], "FOO=");
});

Deno.test("renderStack: does not mutate input", async () => {
  const data = {
    services: {
      web: { image: "nginx", environment: { URL: "${SCHEME}://example.com" } },
    },
  };

  const originalEnv = (data.services.web.environment as Record<string, string>).URL;
  await renderStack({ data, projectDir: "/tmp", repoRoot: "/tmp" });
  assertEquals((data.services.web.environment as Record<string, string>).URL, originalEnv);
});

// ---------------------------------------------------------------------------
// Strict mode covers plain $VAR (Issue #3)
// ---------------------------------------------------------------------------

Deno.test("renderStack: strict mode detects plain $VAR", async () => {
  const data = {
    services: { web: { image: "nginx", command: "start $UNRESOLVED_PLAIN" } },
  };

  const result = await renderStack({ data, projectDir: "/tmp", repoRoot: "/tmp", strict: true });
  assertEquals(result.hasUnresolved, true);
  assertEquals(result.warnings.some((w) => w.includes("$UNRESOLVED_PLAIN")), true);
});

Deno.test("renderStack: non-strict warns about plain $VAR", async () => {
  const data = {
    services: { web: { image: "nginx", command: "start $MISSING" } },
  };

  const result = await renderStack({ data, projectDir: "/tmp", repoRoot: "/tmp", strict: false });
  assertEquals(result.warnings.some((w) => w.includes("$MISSING")), true);
});

// ---------------------------------------------------------------------------
// AbsolutizeVolumeMount handles repo-relative paths (Issue #4)
// ---------------------------------------------------------------------------

Deno.test("absolutizeServicePaths: repo-relative bind mount (data/logs) made absolute", () => {
  const svc: ServiceDef = { volumes: ["data/logs:/app/logs:ro"] };
  const result = absolutizeServicePaths(svc, "/project/app", "/repo");
  assertEquals(result.volumes![0], "/project/app/data/logs:/app/logs:ro");
});

Deno.test("absolutizeServicePaths: long-form repo-relative bind mount made absolute", () => {
  const svc: ServiceDef = {
    volumes: [{ type: "bind", source: "data/logs", target: "/app/logs" }],
  };
  const result = absolutizeServicePaths(svc, "/project/app", "/repo");
  const vm = result.volumes![0] as Record<string, unknown>;
  assertEquals(vm.source, "/project/app/data/logs");
});

Deno.test("absolutizeServicePaths: named volumes with no slash left unchanged", () => {
  const svc: ServiceDef = { volumes: ["data:/app/data"] };
  const result = absolutizeServicePaths(svc, "/project/app", "/repo");
  assertEquals(result.volumes![0], "data:/app/data");
});

// ---------------------------------------------------------------------------
// Full stack-file render pipeline test (Issue #5)
// ---------------------------------------------------------------------------

Deno.test("renderStack: full pipeline - YAML input to rendered output file", async () => {
  const dir = await makeTempDir();

  const stackYaml = stringifyYaml({
    services: {
      app: {
        image: "nginx:${APP_VERSION}",
        command: "${CMD_PREFIX} --port=${APP_PORT}",
        environment: { UNRESOLVED: "${MISSING_VAR}" },
        volumes: ["./data:/app/data"],
      },
    },
  });
  await writeFile(dir, "stack.yml", stackYaml);

  await writeFile(
    dir,
    "app.env",
    "APP_VERSION=1.0\nCMD_PREFIX=serve\nAPP_PORT=3000\nAPP_NAME=testapp\n",
  );

  const data: ComposeData = {
    services: {
      app: {
        image: "nginx:${APP_VERSION}",
        command: "${CMD_PREFIX} --port=${APP_PORT}",
        env_file: [join(dir, "app.env")],
        environment: { UNRESOLVED: "${MISSING_VAR}" },
        volumes: ["./data:/app/data"],
      },
    },
  };

  const result = await renderStack({ data, projectDir: dir, repoRoot: dir });
  const svc = result.data.services!["app"];

  assertEquals(svc.image, "nginx:1.0");
  assertEquals(svc.command, "serve --port=3000");

  const env = svc.environment as Record<string, string>;
  assertEquals(env.UNRESOLVED, "${MISSING_VAR}");

  const vol = svc.volumes![0] as string;
  assertEquals(vol.startsWith("/"), true);

  const outputYaml = stringifyYaml(result.data);
  const outPath = join(dir, ".rendered", "stack.rendered.yml");
  await Deno.mkdir(join(dir, ".rendered"), { recursive: true });
  await Deno.writeTextFile(outPath, outputYaml);
  const written = await Deno.readTextFile(outPath);

  assertEquals(written.length > 0, true);
  assertStringIncludes(written, "nginx:1.0");
  assertStringIncludes(written, "serve --port=3000");
  assertStringIncludes(written, "${MISSING_VAR}");
});

import { assertEquals, assertStringIncludes } from "@std/assert";
import { discoverConfigFiles, loadConfig, resolveConfig } from "./load.ts";
import { join } from "@std/path";

Deno.test("loadConfig: loads and parses a YAML file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-load-test-" });
  try {
    const configPath = join(tmpDir, ".stackctl");
    await Deno.writeTextFile(
      configPath,
      `
project: test-project
stack:
  directory: my-stacks
  names:
    - web
    - api
  network: my-net
render:
  outputDirectory: .out
`,
    );

    const config = await loadConfig(configPath);
    assertEquals(config.project, "test-project");
    assertEquals(config.stack?.directory, "my-stacks");
    assertEquals(config.stack?.names, ["web", "api"]);
    assertEquals(config.stack?.network, "my-net");
    assertEquals(config.render?.outputDirectory, ".out");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("loadConfig: empty file returns empty object", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-load-test-" });
  try {
    const configPath = join(tmpDir, ".stackctl");
    await Deno.writeTextFile(configPath, "");

    const config = await loadConfig(configPath);
    assertEquals(typeof config, "object");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("loadConfig: invalid YAML throws", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-load-test-" });
  try {
    const configPath = join(tmpDir, ".stackctl");
    await Deno.writeTextFile(configPath, "{{ invalid: yaml: :");

    try {
      await loadConfig(configPath);
      assertEquals(true, false, "should have thrown");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      assertStringIncludes(msg, "Failed to parse YAML");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("discoverConfigFiles: finds .stackctl in cwd", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-discover-test-" });
  try {
    const configPath = join(tmpDir, ".stackctl");
    await Deno.writeTextFile(configPath, "project: test");

    const result = await discoverConfigFiles({ cwd: tmpDir });
    assertEquals(result !== null, true);
    if (result) {
      assertEquals(result.configPath, configPath);
      assertEquals(result.repoRoot, tmpDir);
      assertEquals(result.profilePath, undefined);
      assertEquals(result.localPath, undefined);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("discoverConfigFiles: returns null when no .stackctl found", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-discover-test-" });
  try {
    const result = await discoverConfigFiles({ cwd: tmpDir });
    assertEquals(result, null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("discoverConfigFiles: walks up directory tree", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-discover-test-" });
  try {
    // Place .stackctl in parent, cwd in subdir
    const basePath = join(tmpDir, ".stackctl");
    await Deno.writeTextFile(basePath, "project: parent");
    const subDir = join(tmpDir, "subdir", "deep");
    await Deno.mkdir(subDir, { recursive: true });

    const result = await discoverConfigFiles({ cwd: subDir });
    assertEquals(result !== null, true);
    if (result) {
      assertEquals(result.configPath, basePath);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("discoverConfigFiles: finds profile and local files", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-discover-test-" });
  try {
    await Deno.writeTextFile(join(tmpDir, ".stackctl"), "project: test");
    await Deno.writeTextFile(join(tmpDir, ".stackctl.dev"), "project: dev-override");
    await Deno.writeTextFile(join(tmpDir, ".stackctl.local"), "render:\n  outputDirectory: .local");

    const result = await discoverConfigFiles({ cwd: tmpDir, profile: "dev" });
    assertEquals(result !== null, true);
    if (result) {
      assertEquals(result.profilePath, join(tmpDir, ".stackctl.dev"));
      assertEquals(result.localPath, join(tmpDir, ".stackctl.local"));
      assertEquals(result.localProfilePath, undefined); // no .stackctl.local.dev
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("discoverConfigFiles: finds local profile file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-discover-test-" });
  try {
    await Deno.writeTextFile(join(tmpDir, ".stackctl"), "project: test");
    await Deno.writeTextFile(join(tmpDir, ".stackctl.local.staging"), "project: staging");

    const result = await discoverConfigFiles({ cwd: tmpDir, profile: "staging" });
    assertEquals(result !== null, true);
    if (result) {
      assertEquals(result.localProfilePath, join(tmpDir, ".stackctl.local.staging"));
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveConfig: full resolution chain with valid config", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-resolve-test-" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, ".stackctl"),
      `
project: myproject
stack:
  directory: stacks
  names:
    - web
  network: prod-net
render:
  outputDirectory: .rendered
`,
    );

    await Deno.writeTextFile(
      join(tmpDir, ".stackctl.dev"),
      `
project: myproject-dev
`,
    );

    await Deno.writeTextFile(
      join(tmpDir, ".stackctl.local"),
      `
stack:
  network: local-net
`,
    );

    const resolved = await resolveConfig({ cwd: tmpDir, profile: "dev" });
    assertEquals(resolved.profile, "dev");
    assertEquals(resolved.base.project, "myproject-dev"); // profile overrides base
    assertEquals(resolved.base.stack.network, "local-net"); // local overrides profile
    assertEquals(resolved.base.stack.names, ["web"]);
    assertEquals(resolved.base.render.outputDirectory, ".rendered");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveConfig: explicit configPath works", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-resolve-test-" });
  try {
    const configPath = join(tmpDir, "custom.yaml");
    await Deno.writeTextFile(
      configPath,
      `
project: explicit
stack:
  directory: out
  names:
    - svc
  network: explicit-net
render:
  outputDirectory: .rendered
`,
    );

    const resolved = await resolveConfig({ configPath, cwd: tmpDir });
    assertEquals(resolved.base.project, "explicit");
    assertEquals(resolved.base.stack.network, "explicit-net");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveConfig: throws on validation failure", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-resolve-test-" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, ".stackctl"),
      `
project: ""
stack:
  directory: ""
  names: []
  network: ""
render:
  outputDirectory: ""
`,
    );

    try {
      await resolveConfig({ cwd: tmpDir });
      assertEquals(true, false, "should have thrown validation error");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      assertStringIncludes(msg, "Config validation failed");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveConfig: uses STACKCTL_PROFILE env var", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "stackctl-resolve-test-" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, ".stackctl"),
      `
project: test
stack:
  directory: dir
  names:
    - app
  network: net
render:
  outputDirectory: .rendered
`,
    );

    await Deno.writeTextFile(
      join(tmpDir, ".stackctl.staging"),
      `
project: staging-project
`,
    );

    Deno.env.set("STACKCTL_PROFILE", "staging");
    try {
      const resolved = await resolveConfig({ cwd: tmpDir });
      assertEquals(resolved.profile, "staging");
      assertEquals(resolved.base.project, "staging-project");
    } finally {
      Deno.env.delete("STACKCTL_PROFILE");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

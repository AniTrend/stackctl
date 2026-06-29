/**
 * Tests for Docker Compose override merge semantics.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { applyOverrides, composeOverrideMerge, loadOverrideFile } from "./override.ts";
import type { ComposeData } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "stackctl-test-override-" });
}

async function writeFile(dir: string, name: string, content: string) {
  await Deno.writeTextFile(`${dir}/${name}`, content);
}

// ---------------------------------------------------------------------------
// composeOverrideMerge — basic merge rules
// ---------------------------------------------------------------------------

Deno.test("composeOverrideMerge: scalar override", () => {
  const base: ComposeData = { a: 1, b: 2 };
  const result = composeOverrideMerge(base, { b: 99 });
  assertEquals(result, { a: 1, b: 99 });
});

Deno.test("composeOverrideMerge: dict recursive merge", () => {
  const base: ComposeData = { top: { a: 1, b: 2, deep: { x: 10 } } };
  const override: ComposeData = { top: { b: 99, c: 3, deep: { y: 20 } } };
  const result = composeOverrideMerge(base, override);
  assertEquals(result, {
    top: { a: 1, b: 99, c: 3, deep: { x: 10, y: 20 } },
  });
});

Deno.test("composeOverrideMerge: array append (not replace)", () => {
  const base: ComposeData = { items: [1, 2, 3] };
  const override: ComposeData = { items: [4, 5] };
  const result = composeOverrideMerge(base, override);
  // The key difference from fragment merge: arrays are APPENDED
  assertEquals(result, { items: [1, 2, 3, 4, 5] });
});

Deno.test("composeOverrideMerge: array from override only (no base array)", () => {
  const base: ComposeData = {};
  const override: ComposeData = { items: [4, 5] };
  const result = composeOverrideMerge(base, override);
  assertEquals(result, { items: [4, 5] });
});

Deno.test("composeOverrideMerge: empty override leaves base unchanged", () => {
  const base: ComposeData = { a: 1, b: { c: 2 } };
  const result = composeOverrideMerge(base, {});
  assertEquals(result, { a: 1, b: { c: 2 } });
});

Deno.test("composeOverrideMerge: empty base filled by override", () => {
  const base: ComposeData = {};
  const result = composeOverrideMerge(base, { a: 1, b: [2, 3] });
  assertEquals(result, { a: 1, b: [2, 3] });
});

Deno.test("composeOverrideMerge: adds new keys from override", () => {
  const base: ComposeData = { existing: true };
  const result = composeOverrideMerge(base, { newKey: "hello" });
  assertEquals(result, { existing: true, newKey: "hello" });
});

Deno.test("composeOverrideMerge: does not mutate base", () => {
  const base: ComposeData = { a: 1 };
  const override: ComposeData = { b: 2 };
  composeOverrideMerge(base, override);
  assertEquals(base, { a: 1 }); // base unchanged
});

Deno.test("composeOverrideMerge: does not mutate override", () => {
  const base: ComposeData = { a: 1 };
  const override: ComposeData = { b: 2 };
  composeOverrideMerge(base, override);
  assertEquals(override, { b: 2 }); // override unchanged
});

Deno.test("composeOverrideMerge: deeply nested with arrays appended", () => {
  const base: ComposeData = {
    a: { b: { names: ["old"], network: "old-net" } },
  };
  const override: ComposeData = {
    a: { b: { names: ["new1", "new2"] } },
  };
  const result = composeOverrideMerge(base, override);
  assertEquals(result, {
    a: { b: { names: ["old", "new1", "new2"], network: "old-net" } },
  });
});

// ---------------------------------------------------------------------------
// composeOverrideMerge — compose-specific top-level keys
// ---------------------------------------------------------------------------

Deno.test("composeOverrideMerge: service merge by name (new service added)", () => {
  const base: ComposeData = {
    services: {
      app: { image: "nginx", ports: ["8080:80"] },
    },
  };
  const override: ComposeData = {
    services: {
      cache: { image: "redis", ports: ["6379:6379"] },
    },
  };
  const result = composeOverrideMerge(base, override);
  assertEquals(result, {
    services: {
      app: { image: "nginx", ports: ["8080:80"] },
      cache: { image: "redis", ports: ["6379:6379"] },
    },
  });
});

Deno.test("composeOverrideMerge: service merge by name (existing service extended)", () => {
  const base: ComposeData = {
    services: {
      app: { image: "nginx", ports: ["8080:80"] },
    },
  };
  const override: ComposeData = {
    services: {
      app: { image: "nginx:alpine", environment: { FOO: "bar" } },
    },
  };
  const result = composeOverrideMerge(base, override);
  assertEquals(result, {
    services: {
      app: {
        image: "nginx:alpine",
        ports: ["8080:80"],
        environment: { FOO: "bar" },
      },
    },
  });
});

Deno.test("composeOverrideMerge: service arrays are appended (ports, depends_on)", () => {
  const base: ComposeData = {
    services: {
      app: {
        image: "app",
        ports: ["8080:80"],
        depends_on: ["db"],
      },
    },
  };
  const override: ComposeData = {
    services: {
      app: {
        ports: ["8443:443"],
        depends_on: ["cache"],
      },
    },
  };
  const result = composeOverrideMerge(base, override);
  assertEquals(result, {
    services: {
      app: {
        image: "app",
        ports: ["8080:80", "8443:443"],
        depends_on: ["db", "cache"],
      },
    },
  });
});

Deno.test("composeOverrideMerge: volume merge by name", () => {
  const base: ComposeData = {
    volumes: {
      "app-data": { driver: "local" },
    },
  };
  const override: ComposeData = {
    volumes: {
      "cache-data": { driver: "local" },
    },
  };
  const result = composeOverrideMerge(base, override);
  assertEquals(result, {
    volumes: {
      "app-data": { driver: "local" },
      "cache-data": { driver: "local" },
    },
  });
});

Deno.test("composeOverrideMerge: network merge by name", () => {
  const base: ComposeData = {
    networks: {
      frontend: { driver: "overlay" },
    },
  };
  const override: ComposeData = {
    networks: {
      backend: { driver: "overlay" },
    },
  };
  const result = composeOverrideMerge(base, override);
  assertEquals(result, {
    networks: {
      frontend: { driver: "overlay" },
      backend: { driver: "overlay" },
    },
  });
});

Deno.test("composeOverrideMerge: null override value overwrites base", () => {
  const base: ComposeData = { a: 1 };
  const override: ComposeData = { a: null };
  const result = composeOverrideMerge(base, override);
  assertEquals(result, { a: null });
});

// ---------------------------------------------------------------------------
// loadOverrideFile
// ---------------------------------------------------------------------------

Deno.test("loadOverrideFile: relative path resolved against repoRoot", async () => {
  const tmpDir = await makeTempDir();
  try {
    const overridePath = "overrides/prod.yml";
    const fullDir = `${tmpDir}/overrides`;
    await Deno.mkdir(fullDir, { recursive: true });
    await writeFile(fullDir, "prod.yml", "services:\n  app:\n    image: prod-image\n");

    const result = await loadOverrideFile(overridePath, tmpDir);
    assertEquals(result, {
      services: { app: { image: "prod-image" } },
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("loadOverrideFile: absolute path used directly", async () => {
  const tmpDir = await makeTempDir();
  try {
    const absPath = `${tmpDir}/my-override.yml`;
    await writeFile(tmpDir, "my-override.yml", "version: '3'\n");

    const result = await loadOverrideFile(absPath, "/some/other/root");
    assertEquals(result, { version: "3" });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("loadOverrideFile: missing file throws helpful error", async () => {
  const tmpDir = await makeTempDir();
  try {
    await assertRejects(
      () => loadOverrideFile("nonexistent.yml", tmpDir),
      Error,
      "Override file not found",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("loadOverrideFile: empty file returns {}", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeFile(tmpDir, "empty.yml", "");

    const result = await loadOverrideFile("empty.yml", tmpDir);
    assertEquals(result, {});
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("loadOverrideFile: invalid YAML throws", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeFile(tmpDir, "bad.yml", "{{{invalid yaml!!!\n");

    await assertRejects(
      () => loadOverrideFile("bad.yml", tmpDir),
      Error,
      "Failed to parse override file",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// applyOverrides — integration
// ---------------------------------------------------------------------------

Deno.test("applyOverrides: single override file applied to base", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeFile(
      tmpDir,
      "override.yml",
      [
        "services:",
        "  app:",
        "    environment:",
        "      DEBUG: 'true'",
        "",
      ].join("\n"),
    );

    const base: ComposeData = {
      services: {
        app: { image: "nginx", ports: ["8080:80"] },
      },
    };

    const result = await applyOverrides(base, ["override.yml"], tmpDir);

    assertEquals(result, {
      services: {
        app: {
          image: "nginx",
          ports: ["8080:80"],
          environment: { DEBUG: "true" },
        },
      },
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("applyOverrides: multiple override files applied in order", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeFile(
      tmpDir,
      "first.yml",
      [
        "services:",
        "  app:",
        "    environment:",
        "      FOO: bar",
        "",
      ].join("\n"),
    );
    await writeFile(
      tmpDir,
      "second.yml",
      [
        "services:",
        "  app:",
        "    environment:",
        "      FOO: baz",
        "      BAZ: qux",
        "    ports:",
        '      - "8443:443"',
        "",
      ].join("\n"),
    );

    const base: ComposeData = {
      services: {
        app: { image: "app", ports: ["8080:80"] },
      },
    };

    const result = await applyOverrides(base, ["first.yml", "second.yml"], tmpDir);

    assertEquals(result, {
      services: {
        app: {
          image: "app",
          ports: ["8080:80", "8443:443"],
          environment: { FOO: "baz", BAZ: "qux" },
        },
      },
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("applyOverrides: OverrideEntry with explicit path", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeFile(
      tmpDir,
      "my-override.yml",
      [
        "services:",
        "  worker:",
        "    image: worker:latest",
        "",
      ].join("\n"),
    );

    const base: ComposeData = { services: {} };
    const result = await applyOverrides(
      base,
      [{ source: "explicit", path: `${tmpDir}/my-override.yml` }],
      tmpDir,
    );

    assertEquals(result, {
      services: {
        worker: { image: "worker:latest" },
      },
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("applyOverrides: missing override file throws", async () => {
  const tmpDir = await makeTempDir();
  try {
    await assertRejects(
      () => applyOverrides({}, ["missing.yml"], tmpDir),
      Error,
      "Override file not found",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("applyOverrides: empty overrides array returns base unchanged", async () => {
  const base: ComposeData = { a: 1 };
  const result = await applyOverrides(base, [], "/tmp");
  assertEquals(result, { a: 1 });
});

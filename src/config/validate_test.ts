import { assertEquals } from "@std/assert";
import { validateConfig } from "./validate.ts";
import type { StackctlConfig } from "./types.ts";

function makeConfig(overrides?: Partial<StackctlConfig>): StackctlConfig {
  const base: StackctlConfig = {
    project: "test-project",
    stack: {
      directory: "stacks",
      names: ["web", "api"],
      network: "test-net",
    },
    render: {
      outputDirectory: ".rendered",
    },
    env: {
      activeName: ".env",
    },
  };
  if (overrides) {
    // Simple shallow merge for test fixtures
    return {
      ...base,
      ...overrides,
      stack: { ...base.stack, ...(overrides.stack ?? {}) },
      render: { ...base.render, ...(overrides.render ?? {}) },
      env: { ...base.env, ...(overrides.env ?? {}) },
    };
  }
  return base;
}

Deno.test("validateConfig: valid config passes", () => {
  const config = makeConfig();
  const errors = validateConfig(config);
  assertEquals(errors.length, 0);
  assertEquals(errors, []);
});

Deno.test("validateConfig: missing project returns error", () => {
  const config = makeConfig({ project: "" });
  const errors = validateConfig(config);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].path, "project");
  assertEquals(errors[0].message.includes("project"), true);
});

Deno.test("validateConfig: whitespace-only project returns error", () => {
  const config = makeConfig({ project: "   " });
  const errors = validateConfig(config);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].path, "project");
});

Deno.test("validateConfig: missing stack.network returns error", () => {
  const config = makeConfig({ stack: { directory: "stacks", names: ["web"], network: "" } });
  const errors = validateConfig(config);
  assertEquals(errors.length >= 1, true);
  assertEquals(errors.some((e) => e.path === "stack.network"), true);
});

Deno.test("validateConfig: empty stack.names returns error", () => {
  const config = makeConfig({ stack: { directory: "stacks", names: [], network: "net" } });
  const errors = validateConfig(config);
  assertEquals(errors.length >= 1, true);
  assertEquals(errors.some((e) => e.path === "stack.names"), true);
});

Deno.test("validateConfig: missing stack.directory returns error", () => {
  const config = makeConfig({ stack: { directory: "", names: ["web"], network: "net" } });
  const errors = validateConfig(config);
  assertEquals(errors.some((e) => e.path === "stack.directory"), true);
});

Deno.test("validateConfig: missing render.outputDirectory returns error", () => {
  const config = makeConfig({ render: { outputDirectory: "" } });
  const errors = validateConfig(config);
  assertEquals(errors.some((e) => e.path === "render.outputDirectory"), true);
});

Deno.test("validateConfig: env.activeName empty returns error", () => {
  const config = makeConfig({ env: { activeName: "" } });
  const errors = validateConfig(config);
  assertEquals(errors.some((e) => e.path === "env.activeName"), true);
});

Deno.test("validateConfig: env.activeName unset is allowed", () => {
  const config = makeConfig({ env: {} });
  const errors = validateConfig(config);
  assertEquals(errors.some((e) => e.path === "env.activeName"), false);
});

Deno.test("validateConfig: secrets with empty encryptedFileName returns error", () => {
  const config = makeConfig({ secrets: { encryptedFileName: "" } });
  const errors = validateConfig(config);
  assertEquals(errors.some((e) => e.path === "secrets.encryptedFileName"), true);
});

Deno.test("validateConfig: secrets with valid encryptedFileName passes", () => {
  const config = makeConfig({ secrets: { encryptedFileName: ".env.enc" } });
  const errors = validateConfig(config);
  assertEquals(errors.some((e) => e.path === "secrets.encryptedFileName"), false);
});

Deno.test("validateConfig: multiple errors returned at once", () => {
  const config = makeConfig({
    project: "",
    stack: { directory: "", names: [], network: "" },
  });
  const errors = validateConfig(config);
  assertEquals(errors.length >= 3, true);
});

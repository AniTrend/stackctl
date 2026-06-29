/**
 * Tests for service transformation functions.
 */
import { assertEquals } from "@std/assert";
import {
  applyLoggingDefaults,
  rewriteBindMountPaths,
  rewriteEnvFile,
  stripComposeOnlyKeys,
} from "./transform.ts";
import type { ServiceDef } from "./types.ts";

// ---------------------------------------------------------------------------
// stripComposeOnlyKeys
// ---------------------------------------------------------------------------

Deno.test("stripComposeOnlyKeys: removes container_name, restart, build", () => {
  const svc: ServiceDef = {
    image: "alpine",
    container_name: "my-app",
    restart: "always",
    build: ".",
    ports: ["8080:80"],
  };
  const result = stripComposeOnlyKeys(svc);
  assertEquals(result, { image: "alpine", ports: ["8080:80"] });
});

Deno.test("stripComposeOnlyKeys: preserves other keys", () => {
  const svc: ServiceDef = {
    image: "alpine",
    deploy: { replicas: 3 },
    environment: { FOO: "bar" },
    volumes: ["data:/data"],
  };
  const result = stripComposeOnlyKeys(svc);
  assertEquals(result, svc);
});

Deno.test("stripComposeOnlyKeys: handles empty service", () => {
  const svc: ServiceDef = {};
  const result = stripComposeOnlyKeys(svc);
  assertEquals(result, {});
});

Deno.test("stripComposeOnlyKeys: does not mutate input", () => {
  const svc: ServiceDef = { image: "alpine", container_name: "app" };
  stripComposeOnlyKeys(svc);
  assertEquals(svc, { image: "alpine", container_name: "app" });
});

// ---------------------------------------------------------------------------
// applyLoggingDefaults
// ---------------------------------------------------------------------------

Deno.test("applyLoggingDefaults: adds logging when absent", () => {
  const svc: ServiceDef = { image: "alpine" };
  const result = applyLoggingDefaults(svc);
  assertEquals(result.logging, {
    driver: "local",
    options: { "max-size": "10m", "max-file": 3 },
  });
  assertEquals(result.image, "alpine");
});

Deno.test("applyLoggingDefaults: preserves existing logging", () => {
  const svc: ServiceDef = {
    image: "alpine",
    logging: { driver: "json-file" },
  };
  const result = applyLoggingDefaults(svc);
  assertEquals(result.logging, { driver: "json-file" });
});

Deno.test("applyLoggingDefaults: does not mutate input", () => {
  const svc: ServiceDef = { image: "alpine" };
  applyLoggingDefaults(svc);
  assertEquals(svc.logging, undefined);
});

// ---------------------------------------------------------------------------
// rewriteEnvFile
// ---------------------------------------------------------------------------

Deno.test("rewriteEnvFile: relative path — single string", () => {
  const svc: ServiceDef = { env_file: ".env" };
  const result = rewriteEnvFile(svc, "/project/services/web", "/project");
  const expected = ".env";
  const actual = result.env_file as string;
  assertEquals(actual.startsWith("./"), true);
  assertEquals(actual.endsWith(expected), true);
});

Deno.test("rewriteEnvFile: array of paths", () => {
  const svc: ServiceDef = { env_file: [".env", ".env.prod"] };
  const result = rewriteEnvFile(svc, "/project/services/web", "/project");
  const arr = result.env_file as string[];
  assertEquals(Array.isArray(arr), true);
  assertEquals(arr.length, 2);
  assertEquals(arr[0].startsWith("./"), true);
});

Deno.test("rewriteEnvFile: absolute path unchanged", () => {
  const svc: ServiceDef = { env_file: "/etc/env" };
  const result = rewriteEnvFile(svc, "/project/services/web", "/project");
  assertEquals(result.env_file, "/etc/env");
});

Deno.test("rewriteEnvFile: no env_file — unchanged", () => {
  const svc: ServiceDef = { image: "alpine" };
  const result = rewriteEnvFile(svc, "/a", "/b");
  assertEquals(result, svc);
  // Should return a different reference or same? Since we spread only when env_file exists,
  // we'll accept same reference since nothing changed.
});

// ---------------------------------------------------------------------------
// rewriteBindMountPaths
// ---------------------------------------------------------------------------

Deno.test("rewriteBindMountPaths: relative bind mount string", () => {
  const svc: ServiceDef = {
    volumes: ["./data:/app/data"],
  };
  const result = rewriteBindMountPaths(svc, "/project/services/web", "/project");
  const v = result.volumes?.[0] as string;
  assertEquals(v.startsWith("./"), true);
  assertEquals(v.includes(":"), true);
  assertEquals(v.split(":")[0].startsWith("./"), true);
});

Deno.test("rewriteBindMountPaths: absolute bind mount unchanged", () => {
  const svc: ServiceDef = {
    volumes: ["/etc/data:/app/data"],
  };
  const result = rewriteBindMountPaths(svc, "/project/services/web", "/project");
  assertEquals(result.volumes?.[0], "/etc/data:/app/data");
});

Deno.test("rewriteBindMountPaths: named volume unchanged", () => {
  const svc: ServiceDef = {
    volumes: ["data-volume:/app/data"],
  };
  const result = rewriteBindMountPaths(svc, "/project/services/web", "/project");
  assertEquals(result.volumes?.[0], "data-volume:/app/data");
});

Deno.test("rewriteBindMountPaths: long-form bind mount", () => {
  const svc: ServiceDef = {
    volumes: [{ type: "bind", source: "./data", target: "/app/data" }],
  };
  const result = rewriteBindMountPaths(svc, "/project/services/web", "/project");
  const v = result.volumes?.[0] as Record<string, unknown>;
  assertEquals((v.source as string).startsWith("./"), true);
  assertEquals((v.source as string).startsWith("./data"), false); // should be repo-relative
});

Deno.test("rewriteBindMountPaths: long-form named volume unchanged", () => {
  const svc: ServiceDef = {
    volumes: [{ type: "volume", source: "data", target: "/app/data" }],
  };
  const result = rewriteBindMountPaths(svc, "/project/services/web", "/project");
  const v = result.volumes?.[0] as Record<string, unknown>;
  assertEquals(v.source, "data");
});

Deno.test("rewriteBindMountPaths: no volumes — unchanged", () => {
  const svc: ServiceDef = { image: "alpine" };
  const result = rewriteBindMountPaths(svc, "/a", "/b");
  assertEquals(result, svc);
});

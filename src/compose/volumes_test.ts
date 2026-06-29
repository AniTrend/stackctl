/**
 * Tests for named volume collection.
 */
import { assertEquals } from "@std/assert";
import { collectAllNamedVolumes, collectNamedVolumes } from "./volumes.ts";
import type { ServiceDef, VolumeMount } from "./types.ts";

// ---------------------------------------------------------------------------
// collectNamedVolumes
// ---------------------------------------------------------------------------

Deno.test("collectNamedVolumes: short-form named volume", () => {
  const volumes: VolumeMount[] = ["data:/app/data"];
  const result = collectNamedVolumes(volumes);
  assertEquals(result, ["data"]);
});

Deno.test("collectNamedVolumes: short-form bind mount (relative path)", () => {
  const volumes: VolumeMount[] = ["./data:/app/data"];
  const result = collectNamedVolumes(volumes);
  assertEquals(result, []);
});

Deno.test("collectNamedVolumes: short-form bind mount (absolute path)", () => {
  const volumes: VolumeMount[] = ["/etc/config:/app/config"];
  const result = collectNamedVolumes(volumes);
  assertEquals(result, []);
});

Deno.test("collectNamedVolumes: short-form bind mount (home path)", () => {
  const volumes: VolumeMount[] = ["~/data:/app/data"];
  const result = collectNamedVolumes(volumes);
  assertEquals(result, []);
});

Deno.test("collectNamedVolumes: long-form named volume", () => {
  const volumes: VolumeMount[] = [{ type: "volume", source: "data", target: "/app/data" }];
  const result = collectNamedVolumes(volumes);
  assertEquals(result, ["data"]);
});

Deno.test("collectNamedVolumes: long-form bind mount skipped", () => {
  const volumes: VolumeMount[] = [{ type: "bind", source: "/host/path", target: "/app/data" }];
  const result = collectNamedVolumes(volumes);
  assertEquals(result, []);
});

Deno.test("collectNamedVolumes: mixed short-form volumes", () => {
  const volumes: VolumeMount[] = [
    "data:/app/data",
    "./config:/app/config",
    "logs:/var/log",
  ];
  const result = collectNamedVolumes(volumes);
  assertEquals(result, ["data", "logs"]);
});

Deno.test("collectNamedVolumes: empty list", () => {
  const result = collectNamedVolumes([]);
  assertEquals(result, []);
});

Deno.test("collectNamedVolumes: undefined input", () => {
  const result = collectNamedVolumes(undefined);
  assertEquals(result, []);
});

// ---------------------------------------------------------------------------
// collectAllNamedVolumes
// ---------------------------------------------------------------------------

Deno.test("collectAllNamedVolumes: aggregates across services", () => {
  const services: Record<string, ServiceDef> = {
    svc1: { volumes: ["data:/data"] },
    svc2: { volumes: ["logs:/logs", "data:/data"] },
  };
  const result = collectAllNamedVolumes(services);
  assertEquals(result, ["data", "logs"]);
});

Deno.test("collectAllNamedVolumes: undefined services", () => {
  const result = collectAllNamedVolumes(undefined);
  assertEquals(result, []);
});

Deno.test("collectAllNamedVolumes: empty services", () => {
  const result = collectAllNamedVolumes({});
  assertEquals(result, []);
});

/**
 * Tests for Swarm service lifecycle operations (shutdown).
 *
 * Uses FakeProcessRunner — never talks to real Docker.
 */
import { assertEquals } from "@std/assert";
import { FakeProcessRunnerBuilder } from "../testing/fakes.ts";
import { shutdownService } from "./service.ts";

Deno.test("shutdownService: scales an exact service name to zero", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "scale", "traefik_web=0"],
    { stdout: "traefik_web scaled to 0", code: 0 },
  ).build();

  const result = await shutdownService({
    runner,
    serviceName: "traefik_web",
  });

  assertEquals(result.action, "scaled");
  assertEquals(result.serviceName, "traefik_web");
  assertEquals(result.missing, undefined);
  assertEquals(result.error, undefined);
});

Deno.test("shutdownService: reports error when the target is missing", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "scale", "missing_svc=0"],
    { stderr: "No such service: missing_svc", code: 1 },
  ).build();

  const result = await shutdownService({
    runner,
    serviceName: "missing_svc",
  });

  assertEquals(result.action, "error");
  assertEquals(result.missing, true);
  assertEquals(result.error?.includes("No such service"), true);
});

Deno.test("shutdownService: reports error on failed scale", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "scale", "traefik_web=0"],
    { stderr: "not a Swarm manager", code: 1 },
  ).build();

  const result = await shutdownService({
    runner,
    serviceName: "traefik_web",
  });

  assertEquals(result.action, "error");
  assertEquals(result.missing, false);
  assertEquals(result.error?.includes("not a Swarm manager"), true);
});

Deno.test("shutdownService: dry-run never executes the scale command", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "scale", "traefik_web=0"],
    { code: 0 },
  ).build();

  const result = await shutdownService({
    runner,
    serviceName: "traefik_web",
    dryRun: true,
  });

  assertEquals(result.action, "would-scale");
  assertEquals(result.serviceName, "traefik_web");
  assertEquals(runner.recorded.length, 0);
});

Deno.test("shutdownService: trims surrounding whitespace", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "scale", "traefik_web=0"],
    { code: 0 },
  ).build();

  const result = await shutdownService({
    runner,
    serviceName: "  traefik_web  ",
  });

  assertEquals(result.action, "scaled");
  assertEquals(result.serviceName, "traefik_web");
});

Deno.test("shutdownService: rejects invalid service names", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "scale", "traefik_web=0"],
    { code: 0 },
  ).build();

  const invalid = ["", " ", "bad name", "-leading-dash", "traefik/web", "a=b"];

  for (const name of invalid) {
    const result = await shutdownService({ runner, serviceName: name });
    assertEquals(result.action, "invalid", `expected invalid for "${name}"`);
    assertEquals(result.error?.includes("Invalid service name"), true);
  }

  // No docker command should have been executed
  assertEquals(runner.recorded.length, 0);
});

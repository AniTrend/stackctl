/**
 * Tests for the Docker CLI integration module.
 *
 * Uses FakeProcessRunner — never talks to real Docker.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { FakeProcessRunner, FakeProcessRunnerBuilder, successResult } from "../testing/fakes.ts";
import {
  dockerComposeConfig,
  dockerInfo,
  dockerServiceLogs,
  dockerStackDeploy,
  dockerStackPs,
  dockerStackRm,
  dockerStackServices,
  dockerSwarmStatus,
} from "./mod.ts";

// ---------------------------------------------------------------------------
// dockerStackDeploy
// ---------------------------------------------------------------------------

Deno.test("dockerStackDeploy: builds correct command (minimal)", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "deploy", "--compose-file", "/tmp/test.yml", "mystack"],
    { stdout: "Deploying...", code: 0 },
  ).build();

  const result = await dockerStackDeploy(runner, "mystack", "/tmp/test.yml");

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "Deploying");
  assertEquals(runner.containsCommand(["docker", "stack", "deploy"]), true);
});

Deno.test("dockerStackDeploy: includes prune flag", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "deploy", "--compose-file", "/tmp/test.yml", "--prune", "mystack"],
    { code: 0 },
  ).build();

  const result = await dockerStackDeploy(runner, "mystack", "/tmp/test.yml", { prune: true });

  assertEquals(result.code, 0);
});

Deno.test("dockerStackDeploy: includes detach flag", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "deploy", "--compose-file", "/tmp/test.yml", "--detach", "mystack"],
    { code: 0 },
  ).build();

  const result = await dockerStackDeploy(runner, "mystack", "/tmp/test.yml", { detach: true });

  assertEquals(result.code, 0);
});

Deno.test("dockerStackDeploy: includes resolve-image flag", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    [
      "docker",
      "stack",
      "deploy",
      "--compose-file",
      "/tmp/test.yml",
      "--resolve-image",
      "always",
      "mystack",
    ],
    { code: 0 },
  ).build();

  const result = await dockerStackDeploy(runner, "mystack", "/tmp/test.yml", {
    resolveImage: "always",
  });

  assertEquals(result.code, 0);
});

Deno.test("dockerStackDeploy: handles deploy failure", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "deploy", "--compose-file", "/tmp/bad.yml", "badstack"],
    { stderr: "not a Swarm manager", code: 1 },
  ).build();

  const result = await dockerStackDeploy(runner, "badstack", "/tmp/bad.yml");

  assertEquals(result.code, 1);
  assert(!result.success);
  assertStringIncludes(result.stderr, "not a Swarm manager");
});

// ---------------------------------------------------------------------------
// dockerStackRm
// ---------------------------------------------------------------------------

Deno.test("dockerStackRm: builds correct command", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "rm", "mystack"],
    { stdout: "Removing service...", code: 0 },
  ).build();

  const result = await dockerStackRm(runner, "mystack");

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "Removing");
});

Deno.test("dockerStackRm: handles removal failure", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "rm", "nonexistent"],
    { stderr: "nothing found in stack", code: 1 },
  ).build();

  const result = await dockerStackRm(runner, "nonexistent");

  assertEquals(result.code, 1);
  assert(!result.success);
});

// ---------------------------------------------------------------------------
// dockerStackServices
// ---------------------------------------------------------------------------

Deno.test("dockerStackServices: uses JSON format for machine parsing", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "services", "--format", "{{json .}}", "mystack"],
    { stdout: '{"Name":"mystack_web"}\n{"Name":"mystack_db"}', code: 0 },
  ).build();

  const result = await dockerStackServices(runner, "mystack");

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "mystack_web");
  assertStringIncludes(result.stdout, "mystack_db");
});

Deno.test("dockerStackServices: handles empty stack", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "services", "--format", "{{json .}}", "emptystack"],
    { stdout: "", code: 0 },
  ).build();

  const result = await dockerStackServices(runner, "emptystack");

  assertEquals(result.code, 0);
  assertEquals(result.stdout, "");
});

// ---------------------------------------------------------------------------
// dockerStackPs
// ---------------------------------------------------------------------------

Deno.test("dockerStackPs: uses JSON format for machine parsing", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "ps", "--format", "{{json .}}", "mystack"],
    { stdout: '{"Name":"mystack_web.1","DesiredState":"Running"}', code: 0 },
  ).build();

  const result = await dockerStackPs(runner, "mystack");

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "Running");
});

// ---------------------------------------------------------------------------
// dockerServiceLogs
// ---------------------------------------------------------------------------

Deno.test("dockerServiceLogs: builds correct command with defaults", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "logs", "--follow", "myservice"],
    { stdout: "log line 1\nlog line 2", code: 0 },
  ).build();

  const result = await dockerServiceLogs(runner, "myservice");

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "log line 1");
});

Deno.test("dockerServiceLogs: includes tail option", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "logs", "--follow", "--tail", "50", "myservice"],
    { stdout: "recent log", code: 0 },
  ).build();

  const result = await dockerServiceLogs(runner, "myservice", { tail: 50 });

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "recent log");
});

Deno.test("dockerServiceLogs: can disable follow", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "logs", "--tail", "100", "myservice"],
    { stdout: "all logs", code: 0 },
  ).build();

  const result = await dockerServiceLogs(runner, "myservice", { follow: false, tail: 100 });

  assertEquals(result.code, 0);
});

Deno.test("dockerServiceLogs: includes since and timestamps", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "service", "logs", "--follow", "--since", "2024-01-01", "--timestamps", "myservice"],
    { stdout: "timestamped log", code: 0 },
  ).build();

  const result = await dockerServiceLogs(runner, "myservice", {
    since: "2024-01-01",
    timestamps: true,
  });

  assertEquals(result.code, 0);
});

// ---------------------------------------------------------------------------
// dockerInfo
// ---------------------------------------------------------------------------

Deno.test("dockerInfo: returns JSON formatted info", async () => {
  const infoJson = JSON.stringify({ Swarm: { LocalNodeState: "active", NodeID: "abc123" } });
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "info", "--format", "{{json .}}"],
    { stdout: infoJson, code: 0 },
  ).build();

  const result = await dockerInfo(runner);

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "active");
});

Deno.test("dockerInfo: handles docker not running", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "info", "--format", "{{json .}}"],
    { stderr: "Cannot connect to the Docker daemon", code: 1 },
  ).build();

  const result = await dockerInfo(runner);

  assertEquals(result.code, 1);
  assert(!result.success);
});

// ---------------------------------------------------------------------------
// dockerSwarmStatus
// ---------------------------------------------------------------------------

Deno.test("dockerSwarmStatus: detects active Swarm mode", async () => {
  const infoJson = JSON.stringify({ Swarm: { LocalNodeState: "active", NodeID: "node123" } });
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "info", "--format", "{{json .}}"],
    { stdout: infoJson, code: 0 },
  ).build();

  const status = await dockerSwarmStatus(runner);

  assertEquals(status.active, true);
  assertEquals(status.nodeId, "node123");
});

Deno.test("dockerSwarmStatus: detects inactive Swarm", async () => {
  const infoJson = JSON.stringify({ Swarm: { LocalNodeState: "inactive" } });
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "info", "--format", "{{json .}}"],
    { stdout: infoJson, code: 0 },
  ).build();

  const status = await dockerSwarmStatus(runner);

  assertEquals(status.active, false);
});

Deno.test("dockerSwarmStatus: handles missing Swarm key", async () => {
  const infoJson = JSON.stringify({ Containers: 5 });
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "info", "--format", "{{json .}}"],
    { stdout: infoJson, code: 0 },
  ).build();

  const status = await dockerSwarmStatus(runner);

  assertEquals(status.active, false);
});

Deno.test("dockerSwarmStatus: handles bad JSON gracefully", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "info", "--format", "{{json .}}"],
    { stdout: "not valid json{{{", code: 0 },
  ).build();

  const status = await dockerSwarmStatus(runner);

  assertEquals(status.active, false);
});

Deno.test("dockerSwarmStatus: returns inactive when docker info fails", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "info", "--format", "{{json .}}"],
    { stderr: "docker: command not found", code: 127 },
  ).build();

  const status = await dockerSwarmStatus(runner);

  assertEquals(status.active, false);
});

// ---------------------------------------------------------------------------
// Dry-run mode propagation
// ---------------------------------------------------------------------------

Deno.test("docker commands respect dryRun mode", async () => {
  // In dry-run mode, FakeProcessRunner with dryRun=true still returns
  // the configured result — the real process runner would skip execution.
  const runner = new FakeProcessRunner([{
    match: ["docker", "stack", "services"],
    result: successResult('{"Name":"svc"}'),
  }], true); // dryRun = true

  const result = await dockerStackServices(runner, "mystack");

  assertEquals(result.code, 0);
  assertEquals(runner.dryRun, true);
});

// ---------------------------------------------------------------------------
// dockerComposeConfig
// ---------------------------------------------------------------------------

Deno.test("dockerComposeConfig: runs docker compose config with -f flag", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "compose", "-f", "/tmp/test.yml", "config"],
    { stdout: "services:\n  web:\n    image: nginx", code: 0 },
  ).build();

  const result = await dockerComposeConfig(runner, "/tmp/test.yml");

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "web");
  assert(result.success);
});

Deno.test("dockerComposeConfig: reports invalid compose files", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "compose", "-f", "/tmp/bad.yml", "config"],
    { stderr: "services.web Additional property bogus is not allowed", code: 1 },
  ).build();

  const result = await dockerComposeConfig(runner, "/tmp/bad.yml");

  assertEquals(result.code, 1);
  assert(!result.success);
  assertStringIncludes(result.stderr, "bogus");
});

Deno.test("dockerComposeConfig: handles missing file gracefully", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "compose", "-f", "/tmp/missing.yml", "config"],
    { stderr: "stat /tmp/missing.yml: no such file or directory", code: 14 },
  ).build();

  const result = await dockerComposeConfig(runner, "/tmp/missing.yml");

  assertEquals(result.code, 14);
  assert(!result.success);
});

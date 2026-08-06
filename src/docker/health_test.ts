/**
 * Tests for deployed stack health evaluation.
 *
 * Uses FakeProcessRunner — never talks to real Docker.
 */
import { assertEquals } from "@std/assert";
import { FakeProcessRunner, FakeProcessRunnerBuilder } from "../testing/fakes.ts";
import { checkStackHealth } from "./health.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function serviceLine(name: string, replicas: string): string {
  return JSON.stringify({ Name: name, Replicas: replicas });
}

function taskLine(
  name: string,
  currentState: string,
  error?: string,
): string {
  const task: Record<string, unknown> = {
    Name: name,
    DesiredState: "Running",
    CurrentState: currentState,
  };
  if (error) task.Error = error;
  return JSON.stringify(task);
}

function runnerForStack(
  stack: string,
  servicesStdout: string,
  psStdout: string,
): FakeProcessRunner {
  return FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "services", "--format", "{{json .}}", stack],
    { stdout: servicesStdout, code: 0 },
  ).addResponse({
    match: ["docker", "stack", "ps", "--format", "{{json .}}", stack],
    exact: true,
    result: { stdout: psStdout, stderr: "", code: 0, success: true, command: [] },
  }).build();
}

// ---------------------------------------------------------------------------
// Replica evaluation
// ---------------------------------------------------------------------------

Deno.test("health: healthy stack with matching replicas", async () => {
  const runner = runnerForStack(
    "traefik",
    [
      serviceLine("traefik_web", "2/2"),
      serviceLine("traefik_db", "1/1"),
      serviceLine("traefik_worker", "0/0"), // scaled to zero is healthy
    ].join("\n") + "\n",
    taskLine("traefik_web.1", "Running 5 minutes ago") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.errors, []);
  assertEquals(result.unhealthy, false);
  assertEquals(result.stacks.length, 1);
  assertEquals(result.stacks[0].unhealthy, false);

  const services = result.stacks[0].services;
  assertEquals(services.length, 3);
  assertEquals(services[0].name, "traefik_web");
  assertEquals(services[0].running, 2);
  assertEquals(services[0].desired, 2);
  assertEquals(services[0].replicaMismatch, false);
  assertEquals(services[0].unhealthy, false);
  assertEquals(services[2].running, 0);
  assertEquals(services[2].desired, 0);
});

Deno.test("health: replica mismatch marks service unhealthy", async () => {
  const runner = runnerForStack(
    "traefik",
    serviceLine("traefik_api", "1/3") + "\n",
    taskLine("traefik_api.1", "Running 1 minute ago") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  const svc = result.stacks[0].services[0];
  assertEquals(svc.running, 1);
  assertEquals(svc.desired, 3);
  assertEquals(svc.replicaMismatch, true);
  assertEquals(svc.unhealthy, true);
  assertEquals(svc.reasons[0].includes("replicas 1/3"), true);
});

Deno.test("health: running above desired is a replica mismatch", async () => {
  const runner = runnerForStack(
    "traefik",
    serviceLine("traefik_api", "4/2") + "\n", // scale-down in progress
    taskLine("traefik_api.1", "Running 1 minute ago") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  const svc = result.stacks[0].services[0];
  assertEquals(svc.running, 4);
  assertEquals(svc.desired, 2);
  assertEquals(svc.replicaMismatch, true);
  assertEquals(svc.unhealthy, true);
  assertEquals(svc.reasons[0].includes("running above desired"), true);
});

// ---------------------------------------------------------------------------
// Task state evaluation
// ---------------------------------------------------------------------------

Deno.test("health: failed task marks service unhealthy", async () => {
  const runner = runnerForStack(
    "traefik",
    serviceLine("traefik_web", "1/1") + "\n",
    taskLine("traefik_web.2", "Failed 10 seconds ago", "task: non-zero exit (1)") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  const svc = result.stacks[0].services[0];
  assertEquals(svc.unhealthy, true);
  assertEquals(svc.failedTasks.length, 1);
  assertEquals(svc.failedTasks[0].name, "traefik_web.2");
  assertEquals(svc.failedTasks[0].error?.includes("non-zero exit"), true);
  assertEquals(svc.reasons[0].includes("task traefik_web.2 Failed"), true);
});

Deno.test("health: rejected task marks stack unhealthy", async () => {
  const runner = runnerForStack(
    "traefik",
    serviceLine("traefik_api", "1/1") + "\n",
    taskLine("traefik_api.1", "Rejected 2 minutes ago") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  assertEquals(result.stacks[0].unhealthy, true);
  assertEquals(result.stacks[0].services[0].failedTasks.length, 1);
});

Deno.test("health: shutdown and running task states are not failures", async () => {
  const runner = runnerForStack(
    "traefik",
    serviceLine("traefik_web", "1/1") + "\n",
    [
      taskLine("traefik_web.1", "Running 5 minutes ago"),
      taskLine("traefik_web.2", "Shutdown 1 minute ago"),
      taskLine("traefik_web.3", "Complete 2 hours ago"),
      taskLine("traefik_web.4", "Starting"),
    ].join("\n") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, false);
  assertEquals(result.stacks[0].services[0].failedTasks.length, 0);
});

Deno.test("health: failed task for unlisted service is reported", async () => {
  const runner = runnerForStack(
    "traefik",
    serviceLine("traefik_web", "1/1") + "\n",
    taskLine("ghost_svc.1", "Failed 3 minutes ago", "oom-killed") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  const services = result.stacks[0].services;
  assertEquals(services.length, 2);
  const ghost = services.find((s) => s.name === "ghost_svc");
  assertEquals(ghost !== undefined, true);
  assertEquals(ghost?.unhealthy, true);
  assertEquals(ghost?.failedTasks[0].error, "oom-killed");
});

// ---------------------------------------------------------------------------
// Query failures and robustness
// ---------------------------------------------------------------------------

Deno.test("health: service listing failure is reported as error", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "services", "--format", "{{json .}}", "traefik"],
    { stderr: "Cannot connect to the Docker daemon", code: 1 },
  ).addResponse({
    match: ["docker", "stack", "ps", "--format", "{{json .}}", "traefik"],
    exact: true,
    result: { stdout: "", stderr: "", code: 0, success: true, command: [] },
  }).build();

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].stack, "traefik");
  assertEquals(result.errors[0].message.includes("Cannot connect"), true);
  assertEquals(result.unhealthy, true);
  assertEquals(result.stacks[0].unhealthy, true);
});

Deno.test("health: task listing failure is reported as error", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "services", "--format", "{{json .}}", "traefik"],
    { stdout: serviceLine("traefik_web", "1/1") + "\n", code: 0 },
  ).addResponse({
    match: ["docker", "stack", "ps", "--format", "{{json .}}", "traefik"],
    exact: true,
    result: { stderr: "no such stack: traefik", code: 1, success: false, stdout: "", command: [] },
  }).build();

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.errors.length, 1);
  assertEquals(result.unhealthy, true);
  // Services were still evaluated
  assertEquals(result.stacks[0].services.length, 1);
});

Deno.test("health: malformed service JSON fails closed", async () => {
  const runner = runnerForStack(
    "traefik",
    "not valid json\n" + serviceLine("traefik_web", "1/1") + "\n",
    taskLine("traefik_web.1", "Running") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  assertEquals(result.stacks[0].unhealthy, true);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].stack, "traefik");
  assertEquals(result.errors[0].message.includes("malformed service JSON"), true);
  // Valid lines are still evaluated
  assertEquals(result.stacks[0].services.length, 1);
  assertEquals(result.stacks[0].services[0].name, "traefik_web");
});

Deno.test("health: non-object service JSON fails closed", async () => {
  const runner = runnerForStack(
    "traefik",
    '"just a string"\n',
    "",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].message.includes("malformed service JSON"), true);
});

Deno.test("health: malformed task JSON fails closed", async () => {
  const runner = runnerForStack(
    "traefik",
    serviceLine("traefik_web", "1/1") + "\n",
    "not valid json\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  assertEquals(result.stacks[0].unhealthy, true);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].message.includes("malformed task JSON"), true);
  // Service evaluation still happened
  assertEquals(result.stacks[0].services.length, 1);
});

Deno.test("health: unparseable Replicas fails closed", async () => {
  const runner = runnerForStack(
    "traefik",
    serviceLine("traefik_web", "n/a") + "\n",
    taskLine("traefik_web.1", "Running") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  assertEquals(result.stacks[0].unhealthy, true);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].stack, "traefik");
  assertEquals(result.errors[0].message.includes("unparseable Replicas value"), true);

  const svc = result.stacks[0].services[0];
  assertEquals(svc.name, "traefik_web");
  assertEquals(svc.unhealthy, true);
  assertEquals(svc.replicaMismatch, false);
  assertEquals(svc.reasons[0].includes("unparseable Replicas"), true);
});

Deno.test("health: Replicas with trailing garbage fails closed", async () => {
  // Previously the prefix parser accepted "2/2 malformed" as 2/2 and
  // reported the service healthy. The parser must consume the complete
  // value, so trailing garbage fails closed as unparseable.
  const runner = runnerForStack(
    "traefik",
    serviceLine("traefik_web", "2/2 malformed") + "\n",
    taskLine("traefik_web.1", "Running") + "\n",
  );

  const result = await checkStackHealth({ runner, stacks: ["traefik"] });

  assertEquals(result.unhealthy, true);
  assertEquals(result.stacks[0].unhealthy, true);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].stack, "traefik");
  assertEquals(result.errors[0].message.includes("unparseable Replicas value"), true);

  const svc = result.stacks[0].services[0];
  assertEquals(svc.name, "traefik_web");
  assertEquals(svc.running, 0);
  assertEquals(svc.desired, 0);
  assertEquals(svc.unhealthy, true);
  assertEquals(svc.replicaMismatch, false);
  assertEquals(svc.reasons[0].includes("unparseable Replicas"), true);
});

Deno.test("health: empty stack has no services and is healthy", async () => {
  const runner = runnerForStack("empty", "", "");

  const result = await checkStackHealth({ runner, stacks: ["empty"] });

  assertEquals(result.errors, []);
  assertEquals(result.unhealthy, false);
  assertEquals(result.stacks[0].services.length, 0);
});

// ---------------------------------------------------------------------------
// Multiple stacks
// ---------------------------------------------------------------------------

Deno.test("health: evaluates multiple stacks independently", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "stack", "services", "--format", "{{json .}}", "good"],
    { stdout: serviceLine("good_web", "2/2") + "\n", code: 0 },
  ).addResponse({
    match: ["docker", "stack", "ps", "--format", "{{json .}}", "good"],
    exact: true,
    result: {
      stdout: taskLine("good_web.1", "Running") + "\n",
      stderr: "",
      code: 0,
      success: true,
      command: [],
    },
  }).addResponse({
    match: ["docker", "stack", "services", "--format", "{{json .}}", "bad"],
    exact: true,
    result: {
      stdout: serviceLine("bad_api", "0/2") + "\n",
      stderr: "",
      code: 0,
      success: true,
      command: [],
    },
  }).addResponse({
    match: ["docker", "stack", "ps", "--format", "{{json .}}", "bad"],
    exact: true,
    result: {
      stdout: taskLine("bad_api.2", "Failed 5 seconds ago") + "\n",
      stderr: "",
      code: 0,
      success: true,
      command: [],
    },
  }).build();

  const result = await checkStackHealth({ runner, stacks: ["good", "bad"] });

  assertEquals(result.errors, []);
  assertEquals(result.stacks.length, 2);
  assertEquals(result.stacks[0].unhealthy, false);
  assertEquals(result.stacks[1].unhealthy, true);
  assertEquals(result.unhealthy, true);
});

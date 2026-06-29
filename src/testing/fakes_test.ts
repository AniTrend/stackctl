import { assertEquals, assertRejects } from "@std/assert";
import {
  failureResult,
  FakeProcessRunner,
  FakeProcessRunnerBuilder,
  successResult,
} from "./fakes.ts";

Deno.test("FakeProcessRunnerBuilder.success creates catch-all runner", async () => {
  const runner = FakeProcessRunnerBuilder.success("ok").build();
  const result = await runner.run(["any", "command"]);
  assertEquals(result.stdout, "ok");
  assertEquals(result.success, true);
  assertEquals(result.code, 0);
});

Deno.test("FakeProcessRunnerBuilder.forCommand matches exact command", async () => {
  const runner = FakeProcessRunnerBuilder
    .forCommand(["docker", "ps"], { stdout: "running" })
    .build();
  const result = await runner.run(["docker", "ps"]);
  assertEquals(result.stdout, "running");
  assertEquals(result.success, true);
});

Deno.test("FakeProcessRunner rejects for unmatched command", async () => {
  const runner = new FakeProcessRunner(); // no catch-all
  await assertRejects(
    async () => await runner.run(["unknown", "cmd"]),
    Error,
    "FakeProcessRunner: no response configured for command: unknown cmd",
  );
});

Deno.test("FakeProcessRunner records commands", async () => {
  const runner = new FakeProcessRunner([
    { match: [], result: successResult() },
  ]);
  await runner.run(["docker", "ps"]);
  await runner.run(["which", "docker"]);
  assertEquals(runner.commands.length, 2);
  assertEquals(runner.commands[0], ["docker", "ps"]);
  assertEquals(runner.commands[1], ["which", "docker"]);
});

Deno.test("FakeProcessRunner containsCommand", async () => {
  const runner = new FakeProcessRunner([
    { match: [], result: successResult() },
  ]);
  await runner.run(["docker", "stack", "deploy"]);
  assertEquals(runner.containsCommand(["docker"]), true);
  assertEquals(runner.containsCommand(["docker", "stack"]), true);
  assertEquals(runner.containsCommand(["docker", "ps"]), false);
});

Deno.test("FakeProcessRunner.withDryRun propagates mode", () => {
  const runner = new FakeProcessRunner([], true);
  assertEquals(runner.dryRun, true);
  const runner2 = runner.withDryRun(false);
  assertEquals(runner2.dryRun, false);
});

Deno.test("FakeProcessRunner.which returns pre-configured result", async () => {
  const runner = new FakeProcessRunner([
    { match: ["which", "docker"], exact: true, result: successResult() },
    { match: [], result: failureResult(1, "not found") },
  ]);
  assertEquals(await runner.which("docker"), true);
  assertEquals(await runner.which("sops"), false);
});

Deno.test("FakeProcessRunner runs stream method", async () => {
  const runner = FakeProcessRunnerBuilder.forCommand(
    ["docker", "logs"],
    { stdout: "log line" },
  ).build();
  const result = await runner.stream(["docker", "logs"]);
  assertEquals(result.stdout, "log line");
});

Deno.test("FakeProcessRunnerBuilder fluent API", () => {
  const builder = FakeProcessRunnerBuilder.success();
  assertEquals(typeof builder.build, "function");
});

Deno.test("successResult and failureResult helpers", () => {
  const s = successResult("out", "err");
  assertEquals(s.stdout, "out");
  assertEquals(s.stderr, "err");
  assertEquals(s.success, true);

  const f = failureResult(3, "error msg");
  assertEquals(f.code, 3);
  assertEquals(f.stderr, "error msg");
  assertEquals(f.success, false);
});

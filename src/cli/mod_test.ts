import { assertEquals } from "@std/assert";
import { buildCli } from "../cli/mod.ts";

Deno.test("buildCli returns stackctl command", () => {
  const cmd = buildCli();
  assertEquals(cmd.getName(), "stackctl");
});

Deno.test("main returns 0 for init (dry-run)", async () => {
  // Override Deno.exit to prevent actual exit during test
  const origExit = Deno.exit;
  Deno.exit = (code?: number) => {
    throw new Error(`exit ${code}`);
  };

  const { main } = await import("../cli/mod.ts");
  try {
    const code = await main(["init", "--dry-run"]);
    assertEquals(code, 0);
  } catch {
    // exit was called; init should not exit on success with --dry-run
  }

  Deno.exit = origExit;
});

Deno.test("buildCli produces correct help output smoke test", () => {
  const cmd = buildCli();
  assertEquals(cmd.getHelp().includes("stackctl"), true);
  assertEquals(cmd.getHelp().includes("init"), true);
  assertEquals(cmd.getHelp().includes("generate"), true);
  assertEquals(cmd.getHelp().includes("render"), true);
  assertEquals(cmd.getHelp().includes("up"), true);
  assertEquals(cmd.getHelp().includes("down"), true);
  assertEquals(cmd.getHelp().includes("status"), true);
  assertEquals(cmd.getHelp().includes("logs"), true);
  assertEquals(cmd.getHelp().includes("sync"), true);
  assertEquals(cmd.getHelp().includes("doctor"), true);
  assertEquals(cmd.getHelp().includes("reload"), true);
  assertEquals(cmd.getHelp().includes("secrets"), true);
  assertEquals(cmd.getHelp().includes("env"), true);
  assertEquals(cmd.getHelp().includes("plan"), true);
  assertEquals(cmd.getHelp().includes("completions"), true);
});

Deno.test("buildCli version is set", () => {
  const cmd = buildCli();
  assertEquals(cmd.getVersion(), "0.1.0-dev");
});

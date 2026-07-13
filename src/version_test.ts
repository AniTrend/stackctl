import { assertMatch } from "@std/assert";
import { VERSION } from "./version.ts";

Deno.test("VERSION is set and follows semver pattern", () => {
  assertMatch(VERSION, /^\d+\.\d+\.\d+(-dev)?$/);
});

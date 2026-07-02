import { assertEquals } from "@std/assert";
import { VERSION } from "./version.ts";

Deno.test("VERSION is dev", () => {
  assertEquals(VERSION, "0.1.0-dev");
});

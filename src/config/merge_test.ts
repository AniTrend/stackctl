import { assertEquals } from "@std/assert";
import { mergeConfig, mergeConfigs } from "./merge.ts";

Deno.test("mergeConfig: simple key overlay", () => {
  const base = { a: 1, b: 2 };
  const result = mergeConfig(base, { b: 99 });
  assertEquals(result, { a: 1, b: 99 });
});

Deno.test("mergeConfig: nested object merge", () => {
  const base: Record<string, unknown> = { top: { a: 1, b: 2, deep: { x: 10 } } };
  const overlay: Record<string, unknown> = { top: { b: 99, c: 3, deep: { y: 20 } } };
  const result = mergeConfig(base, overlay);
  assertEquals(result, {
    top: { a: 1, b: 99, c: 3, deep: { x: 10, y: 20 } },
  });
});

Deno.test("mergeConfig: array replacement (not concatenation)", () => {
  const base = { items: [1, 2, 3] };
  const result = mergeConfig(base, { items: [4, 5] });
  assertEquals(result, { items: [4, 5] });
});

Deno.test("mergeConfig: undefined in overlay is skipped", () => {
  const base: Record<string, unknown> = { a: 1, b: 2 };
  const result = mergeConfig(base, { a: undefined, b: 99 });
  assertEquals(result, { a: 1, b: 99 });
});

Deno.test("mergeConfig: null in overlay propagates", () => {
  const base: Record<string, unknown> = { a: 1, b: "hello" };
  const result = mergeConfig(base, { b: null });
  assertEquals(result, { a: 1, b: null });
});

Deno.test("mergeConfig: partial overlay on empty base", () => {
  const base: Record<string, unknown> = {};
  const result = mergeConfig(base, { a: 1 });
  assertEquals(result, { a: 1 });
});

Deno.test("mergeConfigs: three-way merge (defaults + base + overlay)", () => {
  const defaults = { a: 0, b: 0, c: 0 };
  const result = mergeConfigs(defaults, { a: 1, b: 2 }, { b: 99 });
  assertEquals(result, { a: 1, b: 99, c: 0 });
});

Deno.test("mergeConfigs: single argument returns same shape", () => {
  const defaults = { a: 1, b: 2 };
  const result = mergeConfigs(defaults);
  assertEquals(result, { a: 1, b: 2 });
});

Deno.test("mergeConfig: adds new keys from overlay", () => {
  const base: Record<string, unknown> = { existing: true };
  const result = mergeConfig(base, { newKey: "hello" });
  assertEquals(result, { existing: true, newKey: "hello" });
});

Deno.test("mergeConfig: deeply nested merge with arrays replaced", () => {
  const base: Record<string, unknown> = {
    stack: { names: ["old"], network: "old-net" },
  };
  const result = mergeConfig(base, {
    stack: { names: ["new1", "new2"] },
  });
  assertEquals(result, {
    stack: { names: ["new1", "new2"], network: "old-net" },
  });
});

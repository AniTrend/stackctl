/**
 * Tests for compose deep merge.
 */
import { assertEquals } from "@std/assert";
import { composeDeepMerge } from "./merge.ts";

Deno.test("composeDeepMerge: scalar override", () => {
  const base = { a: 1, b: 2 };
  const result = composeDeepMerge(base, { b: 99 });
  assertEquals(result, { a: 1, b: 99 });
});

Deno.test("composeDeepMerge: dict recursive merge", () => {
  const base = { top: { a: 1, b: 2, deep: { x: 10 } } };
  const override = { top: { b: 99, c: 3, deep: { y: 20 } } };
  const result = composeDeepMerge(base, override);
  assertEquals(result, {
    top: { a: 1, b: 99, c: 3, deep: { x: 10, y: 20 } },
  });
});

Deno.test("composeDeepMerge: array replacement (not concatenation)", () => {
  const base = { items: [1, 2, 3] };
  const result = composeDeepMerge(base, { items: [4, 5] });
  assertEquals(result, { items: [4, 5] });
});

Deno.test("composeDeepMerge: empty override leaves base unchanged", () => {
  const base = { a: 1, b: { c: 2 } };
  const result = composeDeepMerge(base, {});
  assertEquals(result, { a: 1, b: { c: 2 } });
});

Deno.test("composeDeepMerge: empty base filled by override", () => {
  const base = {};
  const result = composeDeepMerge(base, { a: 1, b: [2, 3] });
  assertEquals(result, { a: 1, b: [2, 3] });
});

Deno.test("composeDeepMerge: adds new keys from override", () => {
  const base = { existing: true };
  const result = composeDeepMerge(base, { newKey: "hello" });
  assertEquals(result, { existing: true, newKey: "hello" });
});

Deno.test("composeDeepMerge: does not mutate base", () => {
  const base = { a: 1 };
  const override = { b: 2 };
  composeDeepMerge(base, override);
  assertEquals(base, { a: 1 }); // base unchanged
});

Deno.test("composeDeepMerge: does not mutate override", () => {
  const base = { a: 1 };
  const override = { b: 2 };
  composeDeepMerge(base, override);
  assertEquals(override, { b: 2 }); // override unchanged
});

Deno.test("composeDeepMerge: deeply nested merge with arrays replaced", () => {
  const base = { a: { b: { names: ["old"], network: "old-net" } } };
  const override = { a: { b: { names: ["new1", "new2"] } } };
  const result = composeDeepMerge(base, override);
  assertEquals(result, {
    a: { b: { names: ["new1", "new2"], network: "old-net" } },
  });
});

Deno.test("composeDeepMerge: service merge pattern", () => {
  const base = {
    services: {
      app: { image: "old", ports: ["8080:80"] },
    },
  };
  const override = {
    services: {
      app: { image: "new", environment: { FOO: "bar" } },
    },
  };
  const result = composeDeepMerge(base, override);
  assertEquals(result, {
    services: {
      app: { image: "new", ports: ["8080:80"], environment: { FOO: "bar" } },
    },
  });
});

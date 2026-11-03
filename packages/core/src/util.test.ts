import { expect, test } from "bun:test";
import { deepEqual, slugify } from "./util.ts";

test("deepEqual compares primitives by identity", () => {
  expect(deepEqual(1, 1)).toBe(true);
  expect(deepEqual("a", "a")).toBe(true);
  expect(deepEqual(null, null)).toBe(true);
  expect(deepEqual(undefined, undefined)).toBe(true);
  expect(deepEqual(1, "1")).toBe(false);
  expect(deepEqual(0, false)).toBe(false);
  expect(deepEqual(null, undefined)).toBe(false);
});

test("deepEqual never equates null with an object", () => {
  expect(deepEqual(null, {})).toBe(false);
  expect(deepEqual({}, null)).toBe(false);
});

test("deepEqual compares nested objects and arrays structurally", () => {
  expect(deepEqual({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toBe(true);
  expect(deepEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false);
  expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
  expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
});

test("deepEqual does not equate an array with an object of the same keys", () => {
  expect(deepEqual([1], { 0: 1 })).toBe(false);
  expect(deepEqual({ 0: 1 }, [1])).toBe(false);
  expect(deepEqual([], {})).toBe(false);
});

test("deepEqual treats a key whose value is undefined as absent", () => {
  expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
  expect(deepEqual({ a: { x: undefined } }, { a: {} })).toBe(true);
});

test("deepEqual tells apart objects with the same number of different keys", () => {
  expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
  expect(deepEqual({ a: 1, b: undefined }, { b: 1 })).toBe(false);
});

test("deepEqual tells apart a missing key from a null one", () => {
  expect(deepEqual({ a: null }, {})).toBe(false);
});

test("slugify lowercases and joins words with underscores", () => {
  expect(slugify("Kitchen Ceiling Light")).toBe("kitchen_ceiling_light");
});

test("slugify strips accents", () => {
  expect(slugify("Café Déjà Vu")).toBe("cafe_deja_vu");
});

test("slugify collapses runs of other characters and trims them from the ends", () => {
  expect(slugify("  --Hello,   World!!  ")).toBe("hello_world");
  expect(slugify("a__b")).toBe("a_b");
  expect(slugify("Lamp #2 (desk)")).toBe("lamp_2_desk");
});

test("slugify keeps digits", () => {
  expect(slugify("2nd Floor 10")).toBe("2nd_floor_10");
});

test("slugify never returns an empty string", () => {
  expect(slugify("")).toBe("unnamed");
  expect(slugify("!!!")).toBe("unnamed");
  expect(slugify("日本語")).toBe("unnamed");
});

test("slugify output only uses [a-z0-9_]", () => {
  for (const input of ["Ærø Straße", "émoji 🎉 here", "TAB\there", "x.y-z/w"]) {
    expect(slugify(input)).toMatch(/^[a-z0-9_]+$/);
  }
});

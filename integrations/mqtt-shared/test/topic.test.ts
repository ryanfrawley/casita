import { expect, test } from "bun:test";
import { topicMatches } from "../src/index.ts";

test.each([
  ["a/b/c", "a/b/c"],
  ["a", "a"],
  ["", ""],
])("an exact filter %p matches %p", (filter, topic) => {
  expect(topicMatches(filter, topic)).toBe(true);
});

test.each([
  ["a/b/c", "a/b/d"],
  ["a/b/c", "a/b"],
  ["a/b", "a/b/c"],
  ["a/b", "A/b"],
  ["a/b", "a/b/"],
])("an exact filter %p does not match %p", (filter, topic) => {
  expect(topicMatches(filter, topic)).toBe(false);
});

test.each([
  ["a/+/c", "a/b/c", true],
  ["a/+/c", "a/xyz/c", true],
  ["+/+", "a/b", true],
  ["a/+", "a/", true], // + matches an empty level
  ["+", "a", true],
  ["a/+/c", "a/b/x/c", false], // + is exactly one level
  ["a/+", "a", false],
  ["a/+", "a/b/c", false],
  ["+", "a/b", false],
])("single-level wildcard: %p vs %p is %p", (filter, topic, expected) => {
  expect(topicMatches(filter, topic)).toBe(expected);
});

test.each([
  ["#", "a", true],
  ["#", "a/b/c", true],
  ["a/#", "a/b", true],
  ["a/#", "a/b/c/d", true],
  ["a/#", "a", true], // # also matches the parent level
  ["a/b/#", "a/b", true],
  ["+/b/#", "x/b/c", true],
  ["a/#", "b/c", false],
  ["a/b/#", "a/c/d", false],
  ["a/b/#", "a", false],
])("multi-level wildcard: %p vs %p is %p", (filter, topic, expected) => {
  expect(topicMatches(filter, topic)).toBe(expected);
});

test("a discovery-style filter matches config topics with and without a node id", () => {
  expect(topicMatches("casita/+/+/config", "casita/light/lamp/config")).toBe(true);
  expect(topicMatches("casita/+/+/+/config", "casita/light/node/lamp/config")).toBe(true);
  expect(topicMatches("casita/+/+/config", "casita/light/node/lamp/config")).toBe(false);
  expect(topicMatches("casita/#", "casita/light/node/lamp/config")).toBe(true);
});

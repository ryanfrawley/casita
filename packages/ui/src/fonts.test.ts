import { afterEach, beforeEach, expect, test } from "bun:test";
import { FACES, installFonts } from "./fonts.ts";

interface Declared {
  family: string;
  source: string;
  descriptors: FontFaceDescriptors;
}

/** Stands in for the browser's FontFace, which records what it was asked for. */
class FakeFontFace implements Declared {
  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors: FontFaceDescriptors,
  ) {}
}

const scope = globalThis as { FontFace?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = scope.FontFace;
  scope.FontFace = FakeFontFace;
});
afterEach(() => {
  if (saved === undefined) delete scope.FontFace;
  else scope.FontFace = saved;
});

function install(): Declared[] {
  const added: Declared[] = [];
  const fonts = { add: (face: FontFace) => added.push(face as unknown as Declared) };
  installFonts(fonts);
  return added;
}

test("each family named by the tokens has a latin and a latin-ext face", async () => {
  const tokens = await Bun.file(`${import.meta.dir}/../design/tokens.json`).json();
  const named = Object.values<string>(tokens.type.families).map((stack) =>
    (stack.split(",")[0] ?? "").replaceAll('"', ""),
  );
  expect(FACES.map((face) => face.family).sort()).toEqual(named.sort());
  const added = install();
  expect(added).toHaveLength(6);
  for (const family of named) {
    expect(added.filter((face) => face.family === family)).toHaveLength(2);
  }
});

test("the faces point at files, never at data", () => {
  for (const face of install()) {
    expect(face.source).toMatch(/^url\("[^"]+\.woff2"\) format\("woff2(-variations)?"\)$/);
    expect(face.source).not.toContain("data:");
  }
});

test("each face's latin-ext file gets the latin-ext range and its latin file the latin range", () => {
  for (const face of install()) {
    const range = face.descriptors.unicodeRange ?? "";
    // U+0100 is where latin-ext begins; plain latin starts at U+0000.
    if (face.source.includes("latin-ext")) expect(range).toStartWith("U+0100");
    else expect(range).toStartWith("U+0000");
  }
});

test("faces swap in when loaded and carry their weights", () => {
  const added = install();
  for (const face of added) expect(face.descriptors.display).toBe("swap");
  const weights = (family: string) =>
    added.find((face) => face.family === family)?.descriptors.weight;
  expect(weights("JetBrains Mono")).toBe("400");
  // A variable font declares the range it covers.
  expect(weights("Figtree")).toMatch(/^\d+ \d+$/);
});

test("Fraunces covers the weights the display styles use", () => {
  const [low, high] = (FACES[0]?.weight ?? "").split(" ").map(Number);
  expect(low).toBeLessThanOrEqual(500);
  expect(high).toBeGreaterThanOrEqual(600);
});

test("installing twice on one page declares the faces once", () => {
  const added: unknown[] = [];
  const fonts = { add: (face: FontFace) => added.push(face) };
  installFonts(fonts);
  installFonts(fonts);
  expect(added).toHaveLength(6);
});

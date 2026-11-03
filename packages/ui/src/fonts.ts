// The three families, served from here so the house needs no internet to draw its own walls.
// The faces are declared from script, through the FontFace API. A stylesheet would not do:
// the bundler writes every font it references into it as a data URI. Nor would a <style>
// element: the server's content security policy allows no inline styles. As files, a browser
// fetches only the subsets a page uses.

import figtreeLatinExt from "./fonts/figtree-latin-ext-wght-normal.woff2";
import figtreeLatin from "./fonts/figtree-latin-wght-normal.woff2";
import frauncesLatinExt from "./fonts/fraunces-latin-ext-opsz-normal.woff2";
import frauncesLatin from "./fonts/fraunces-latin-opsz-normal.woff2";
import monoLatin from "./fonts/jetbrains-mono-latin-400-normal.woff2";
import monoLatinExt from "./fonts/jetbrains-mono-latin-ext-400-normal.woff2";

const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

interface Face {
  family: string;
  /** One weight, or the range a variable font covers. */
  weight: string;
  format: "woff2" | "woff2-variations";
  latin: string;
  latinExt: string;
}

/** Fraunces carries its optical-size axis; the design uses weights 500 and 600. */
export const FACES: Face[] = [
  {
    family: "Fraunces",
    weight: "100 900",
    format: "woff2-variations",
    latin: frauncesLatin,
    latinExt: frauncesLatinExt,
  },
  {
    family: "Figtree",
    weight: "300 900",
    format: "woff2-variations",
    latin: figtreeLatin,
    latinExt: figtreeLatinExt,
  },
  {
    family: "JetBrains Mono",
    weight: "400",
    format: "woff2",
    latin: monoLatin,
    latinExt: monoLatinExt,
  },
];

interface FontSet {
  add(face: FontFace): unknown;
}
const installed = new WeakSet<FontSet>();

/** Declares the font faces on the page. Call once at startup; calling again does nothing. */
export function installFonts(fonts: FontSet = document.fonts): void {
  if (installed.has(fonts)) return;
  installed.add(fonts);
  for (const face of FACES) {
    for (const [url, unicodeRange] of [
      [face.latinExt, LATIN_EXT],
      [face.latin, LATIN],
    ] as const) {
      fonts.add(
        new FontFace(face.family, `url("${url}") format("${face.format}")`, {
          style: "normal",
          weight: face.weight,
          display: "swap",
          unicodeRange,
        }),
      );
    }
  }
}

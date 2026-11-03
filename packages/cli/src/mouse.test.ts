import { expect, test } from "bun:test";
import { parseMouse, tokenize } from "./dash-run.ts";

const ESC = String.fromCharCode(27);

test("a mouse report gives the button and a zero-based position", () => {
  expect(parseMouse(`${ESC}[<0;5;7M`)).toEqual({ button: "left", line: 6, column: 4, press: true });
  expect(parseMouse(`${ESC}[<0;5;7m`)).toEqual({
    button: "left",
    line: 6,
    column: 4,
    press: false,
  });
  expect(parseMouse(`${ESC}[<2;120;46M`)).toMatchObject({ button: "right", line: 45, column: 119 });
  expect(parseMouse(`${ESC}[<1;1;1M`)).toMatchObject({ button: "middle", line: 0, column: 0 });
});

test("the wheel is up or down, also with a modifier held", () => {
  expect(parseMouse(`${ESC}[<64;10;10M`)?.button).toBe("up");
  expect(parseMouse(`${ESC}[<65;10;10M`)?.button).toBe("down");
  expect(parseMouse(`${ESC}[<69;10;10M`)?.button).toBe("down"); // with shift
  expect(parseMouse(`${ESC}[<4;10;10M`)?.button).toBe("left"); // shift-click is still a left click
});

test("positions past column 223 survive, and anything else is not a mouse report", () => {
  expect(parseMouse(`${ESC}[<0;300;90M`)).toMatchObject({ line: 89, column: 299 });
  for (const other of [`${ESC}[A`, "q", " ", `${ESC}[<0;5M`, `${ESC}[<3;5;7M`, ""]) {
    expect(parseMouse(other)).toBeUndefined();
  }
});

test("shift, meta and ctrl held during a click do not change which button it was", () => {
  for (const modifier of [4, 8, 16, 4 + 8 + 16]) {
    expect(parseMouse(`${ESC}[<${0 + modifier};5;7M`)?.button).toBe("left");
    expect(parseMouse(`${ESC}[<${1 + modifier};5;7M`)?.button).toBe("middle");
    expect(parseMouse(`${ESC}[<${2 + modifier};5;7M`)?.button).toBe("right");
  }
  expect(parseMouse(`${ESC}[<80;5;7M`)?.button).toBe("up"); // ctrl + wheel up
  expect(parseMouse(`${ESC}[<81;5;7M`)?.button).toBe("down"); // ctrl + wheel down
});

test("a release in SGR form is not a press, for every button", () => {
  expect(parseMouse(`${ESC}[<0;5;7m`)).toMatchObject({ button: "left", press: false });
  expect(parseMouse(`${ESC}[<1;5;7m`)).toMatchObject({ button: "middle", press: false });
  expect(parseMouse(`${ESC}[<2;5;7m`)).toMatchObject({ button: "right", press: false });
});

test("motion with no button held is not a mouse event", () => {
  expect(parseMouse(`${ESC}[<35;5;7M`)).toBeUndefined();
});

test("very large coordinates come through zero-based", () => {
  expect(parseMouse(`${ESC}[<0;9999;5000M`)).toMatchObject({ line: 4999, column: 9998 });
});

test("a report with bytes after it is not a mouse report", () => {
  expect(parseMouse(`${ESC}[<0;5;7Mq`)).toBeUndefined();
});

// Bit 32 marks motion: a drag with the button held. It is not a new click.
test("a drag (motion with a button held) is not a press", () => {
  expect(parseMouse(`${ESC}[<32;5;7M`)?.press ?? false).toBe(false);
  expect(parseMouse(`${ESC}[<34;5;7M`)?.press ?? false).toBe(false);
});

// Codes 66 and 67 are the horizontal wheel; they read as vertical up and down today.
test("the horizontal wheel does not move the selection up or down", () => {
  expect(["up", "down"]).not.toContain(parseMouse(`${ESC}[<66;5;7M`)?.button);
  expect(["up", "down"]).not.toContain(parseMouse(`${ESC}[<67;5;7M`)?.button);
});

// Codes 128 to 131 are extra buttons 8 to 11 (back, forward); 128 reads as a left click.
test("the back and forward buttons are not a left click", () => {
  expect(parseMouse(`${ESC}[<128;5;7M`)?.button).not.toBe("left");
  expect(parseMouse(`${ESC}[<129;5;7M`)?.button).not.toBe("middle");
});

test("input splits into keys and whole escape sequences", () => {
  expect(tokenize(`j${ESC}[A${ESC}[<0;5;7M q`)).toEqual({
    keys: ["j", `${ESC}[A`, `${ESC}[<0;5;7M`, " ", "q"],
    rest: "",
  });
  // Function keys, application-mode arrows, and alt plus a key each stay in one piece.
  expect(tokenize(`${ESC}[15~${ESC}OA${ESC}m`).keys).toEqual([`${ESC}[15~`, `${ESC}OA`, `${ESC}m`]);
});

test("a late answer about the background is one sequence, not typed keys", () => {
  expect(tokenize(`${ESC}]11;rgb:ffff/ffff/ffff\u0007m`).keys).toEqual([
    `${ESC}]11;rgb:ffff/ffff/ffff\u0007`,
    "m",
  ]);
  expect(tokenize(`${ESC}]11;rgb:0000/0000/0000${ESC}\\`).keys).toHaveLength(1);
});

test("a sequence cut off by the end of a chunk waits for the rest", () => {
  const first = tokenize(`k${ESC}[<0;12`);
  expect(first).toEqual({ keys: ["k"], rest: `${ESC}[<0;12` });
  expect(tokenize(`${first.rest};7M`)).toEqual({ keys: [`${ESC}[<0;12;7M`], rest: "" });
  expect(tokenize(`${ESC}]11;rgb:ff`).rest).toBe(`${ESC}]11;rgb:ff`);
  expect(tokenize(`${ESC}[`).rest).toBe(`${ESC}[`);
});

test("a lone escape is the Escape key, twice if pressed twice", () => {
  expect(tokenize(ESC)).toEqual({ keys: [ESC], rest: "" });
  expect(tokenize(ESC + ESC)).toEqual({ keys: [ESC, ESC], rest: "" });
});

test("an unfinished sequence that never ends is dropped rather than held forever", () => {
  expect(tokenize(`${ESC}]${"x".repeat(300)}`)).toEqual({ keys: [], rest: "" });
});

test("an empty chunk gives no keys and nothing to carry", () => {
  expect(tokenize("")).toEqual({ keys: [], rest: "" });
});

test("a CSI with intermediate bytes is one key, and waits whole when cut off", () => {
  expect(tokenize(`${ESC}[2 q${ESC}[?25hj`).keys).toEqual([`${ESC}[2 q`, `${ESC}[?25h`, "j"]);
  expect(tokenize(`${ESC}[2 `)).toEqual({ keys: [], rest: `${ESC}[2 ` });
  expect(tokenize(`${ESC}[?`)).toEqual({ keys: [], rest: `${ESC}[?` });
});

test("an escape right before an arrow is the Escape key, then the arrow", () => {
  expect(tokenize(`${ESC}${ESC}[A`)).toEqual({ keys: [ESC, `${ESC}[A`], rest: "" });
  expect(tokenize(`${ESC}${ESC}[`)).toEqual({ keys: [ESC], rest: `${ESC}[` });
});

test("an answer cut between its closing ESC and backslash waits, then ends at the backslash", () => {
  const answer = `${ESC}]11;rgb:0000/0000/0000${ESC}\\`;
  const first = tokenize(`j${answer.slice(0, -1)}`);
  expect(first).toEqual({ keys: ["j"], rest: answer.slice(0, -1) });
  expect(tokenize(`${first.rest}\\q`)).toEqual({ keys: [answer, "q"], rest: "" });
});

// A lone ESC at the end of a chunk is the Escape key by design, so a split right after an
// ESC that starts a sequence is the one place where the two halves read differently.
test("a stream split at any other point rejoins to the same keys", () => {
  const stream = [
    "j",
    `${ESC}[A`,
    `${ESC}[<0;12;7M`,
    " ",
    `${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\`,
    `${ESC}OA`,
    `${ESC}[15~`,
    `${ESC}[2 q`,
    `${ESC}]11;rgb:0/0/0\u0007`,
    "é",
    "q",
  ];
  const input = stream.join("");
  expect(tokenize(input)).toEqual({ keys: stream, rest: "" });
  // Offsets just after the ESC that opens each sequence.
  const afterIntroducer = new Set<number>();
  let offset = 0;
  for (const key of stream) {
    if (key.length > 1 && key.startsWith(ESC)) afterIntroducer.add(offset + 1);
    offset += key.length;
  }
  for (let at = 0; at <= input.length; at++) {
    if (afterIntroducer.has(at)) continue;
    const first = tokenize(input.slice(0, at));
    const second = tokenize(first.rest + input.slice(at));
    expect([...first.keys, ...second.keys]).toEqual(stream);
    expect(second.rest).toBe("");
  }
});

test("a carried sequence still unfinished after the next chunk keeps waiting", () => {
  const first = tokenize(`${ESC}]11;rgb:`);
  const second = tokenize(`${first.rest}ffff/ffff`);
  expect(second).toEqual({ keys: [], rest: `${ESC}]11;rgb:ffff/ffff` });
  expect(tokenize(`${second.rest}/ffff\u0007m`)).toEqual({
    keys: [`${ESC}]11;rgb:ffff/ffff/ffff\u0007`, "m"],
    rest: "",
  });
});

test("an unfinished sequence of 256 characters still waits; one more and it is dropped", () => {
  const waiting = `${ESC}]${"x".repeat(254)}`;
  expect(tokenize(waiting)).toEqual({ keys: [], rest: waiting });
  expect(tokenize(`${waiting}x`)).toEqual({ keys: [], rest: "" });
  // The limit also applies when the carry and the next chunk only pass it together.
  expect(tokenize(`${waiting.slice(0, 200)}${"x".repeat(100)}`).rest).toBe("");
});

test("keys before an over-long unfinished sequence are still delivered", () => {
  expect(tokenize(`ab${ESC}]${"x".repeat(300)}`)).toEqual({ keys: ["a", "b"], rest: "" });
});

test("accented and wide characters are one key each, and nothing typed is lost", () => {
  expect(tokenize("é中ñ").keys).toEqual(["é", "中", "ñ"]);
  // An emoji is two UTF-16 units; whatever the split, the keys join back to what was typed.
  expect(tokenize("a😀b").keys.join("")).toBe("a😀b");
});

// Bug: observed ["\x1b\ud83d", "\ude00"] (a lone low surrogate gets typed); expected one key.
test("alt plus an emoji is one key", () => {
  expect(tokenize(`${ESC}😀`).keys).toEqual([`${ESC}😀`]);
});

test("a drag with modifiers held keeps its button and is not a press", () => {
  for (const modifier of [4, 8, 16, 4 + 8 + 16]) {
    expect(parseMouse(`${ESC}[<${32 + modifier};5;7M`)).toEqual({
      button: "left",
      line: 6,
      column: 4,
      press: false,
    });
    expect(parseMouse(`${ESC}[<${34 + modifier};5;7M`)).toMatchObject({
      button: "right",
      press: false,
    });
  }
  expect(parseMouse(`${ESC}[<51;5;7M`)).toBeUndefined(); // ctrl + motion with no button held
  expect(parseMouse(`${ESC}[<16;5;7m`)).toMatchObject({ button: "left", press: false });
});

test("the horizontal wheel and the extra buttons are not mouse events, with or without modifiers", () => {
  for (const code of [66, 67, 70, 83, 128, 129, 130, 131, 132, 160, 192, 194]) {
    expect(parseMouse(`${ESC}[<${code};5;7M`)).toBeUndefined();
    expect(parseMouse(`${ESC}[<${code};5;7m`)).toBeUndefined();
  }
});

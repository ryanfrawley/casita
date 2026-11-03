import { describe, expect, test } from "bun:test";
import { Diagnostics } from "./diagnostics.ts";
import { lex } from "./lexer.ts";

/** Each token as `kind text`, without the end of the file. */
const tokens = (source: string, trivia?: boolean) =>
  lex(source, new Diagnostics(), trivia === undefined ? undefined : { trivia })
    .filter((t) => t.kind !== "eof")
    .map((t) => `${t.kind} ${t.text}`);

describe("without trivia", () => {
  test("comments are dropped", () => {
    expect(tokens("a // note\nb /* more */ c")).toEqual([
      "ident a",
      "newline \n",
      "ident b",
      "ident c",
      "newline \n",
    ]);
  });

  test("blank lines are one newline", () => {
    expect(tokens("a\n\n\nb")).toEqual(["ident a", "newline \n", "ident b", "newline \n"]);
  });

  test("a line break inside ( or [ is whitespace", () => {
    expect(tokens("f(\n1\n)\n[\n2\n]")).toEqual([
      "ident f",
      "punct (",
      "number 1",
      "punct )",
      "newline \n",
      "punct [",
      "number 2",
      "punct ]",
      "newline \n",
    ]);
  });

  test("trivia: false is the same as no options", () => {
    const source = "a // note\n\n(\nb\n)";
    expect(tokens(source, false)).toEqual(tokens(source));
  });
});

describe("with trivia", () => {
  test("a line comment is a token, trimmed at the end", () => {
    expect(tokens("a // note   \nb", true)).toEqual([
      "ident a",
      "comment // note",
      "newline \n",
      "ident b",
      "newline \n",
    ]);
  });

  test("a block comment is a token as written, line breaks and all", () => {
    expect(tokens("a /* one\n  two  */ b", true)).toEqual([
      "ident a",
      "comment /* one\n  two  */",
      "ident b",
      "newline \n",
    ]);
  });

  test("a line after a block comment keeps its line number", () => {
    const [, , b] = lex("a /* one\ntwo */\nb", new Diagnostics(), { trivia: true }).filter(
      (t) => t.kind !== "newline",
    );
    expect(b?.text).toBe("b");
    expect(b?.span.line).toBe(3);
  });

  test("a comment knows whether space came before it", () => {
    const [, glued, , , spaced] = lex("a//x\nb /*y*/", new Diagnostics(), { trivia: true });
    expect(glued?.kind).toBe("comment");
    expect(glued?.spaced).toBe(false);
    expect(spaced?.kind).toBe("comment");
    expect(spaced?.spaced).toBe(true);
  });

  test("every blank line is a newline of its own", () => {
    expect(tokens("a\n\n\nb", true)).toEqual([
      "ident a",
      "newline \n",
      "newline \n",
      "newline \n",
      "ident b",
      "newline \n",
    ]);
  });

  test("a line break inside ( or [ is a newline", () => {
    expect(tokens("f(\n1\n)\n[\n2\n]", true)).toEqual([
      "ident f",
      "punct (",
      "newline \n",
      "number 1",
      "newline \n",
      "punct )",
      "newline \n",
      "punct [",
      "newline \n",
      "number 2",
      "newline \n",
      "punct ]",
      "newline \n",
    ]);
  });

  test("a comment alone on a line sits between its newlines", () => {
    expect(tokens("a\n// own\nb", true)).toEqual([
      "ident a",
      "newline \n",
      "comment // own",
      "newline \n",
      "ident b",
      "newline \n",
    ]);
  });

  test("a source ending in a newline gets no second one", () => {
    expect(tokens("a\n", true)).toEqual(["ident a", "newline \n"]);
  });

  test("a block comment that never closes runs to the end and is still an error", () => {
    const diagnostics = new Diagnostics();
    const out = lex("a /* open", diagnostics, { trivia: true });
    expect(out.map((t) => `${t.kind} ${t.text}`)).toEqual([
      "ident a",
      "comment /* open",
      "newline \n",
      "eof ",
    ]);
    expect(diagnostics.list.map((d) => d.code)).toEqual(["E001"]);
  });

  test("the other tokens are the same as without it", () => {
    const source = 'page P {\n  Text { value: f(1, -2) ? "a" : #fff }  // c\n}\n';
    const plain = tokens(source).filter((t) => !t.startsWith("newline"));
    const kept = tokens(source, true).filter(
      (t) => !t.startsWith("newline") && !t.startsWith("comment"),
    );
    expect(kept).toEqual(plain);
  });
});

import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";
import { HOME, REGISTRY } from "./fixtures.ts";
import { formatSource } from "./format.ts";
import { HEADERS_SOURCE } from "./headers.ts";
import { OCTOBER_SOURCE } from "./theme.ts";

/** A page whose one root is a Stack holding `body`, indented as the formatter would. */
const page = (body: string) => `page P {\n  Stack {\n${body}\n  }\n}\n`;
/** One line inside the Stack, formatted: what the rules make of it on its own. */
const line = (text: string) => formatSource(page(`    ${text}`)).split("\n")[2];
/** A component header followed by a page, for what only a component signature can hold. */
const component = (header: string) =>
  `component C(${header}) {\n  Text { value: 1 }\n}\npage P {\n  Stack { }\n}\n`;
const signature = (header: string) =>
  formatSource(component(header))
    .split("\n")[0]
    ?.replace(/^component C\((.*)\) \{$/, "$1");

describe("indent", () => {
  test("is two spaces per open bracket", () => {
    expect(formatSource("page P {\nStack {\nText {\nvalue: 1\n}\n}\n}\n")).toBe(
      "page P {\n  Stack {\n    Text {\n      value: 1\n    }\n  }\n}\n",
    );
  });

  test("replaces whatever the writer used, tabs included", () => {
    expect(formatSource("page P {\n        Stack {\n\tText { value: 1 }\n }\n}\n")).toBe(
      page("    Text { value: 1 }"),
    );
  });

  test("counts ( and [ as well as {", () => {
    expect(line("Text { value: f(\n1,\n[\n2\n]\n) }")).toBe("    Text { value: f(");
    expect(formatSource(page("Text { value: f(\n1,\n[\n2\n]\n) }"))).toBe(
      page("    Text { value: f(\n        1,\n        [\n          2\n        ]\n    ) }"),
    );
  });

  test("a line that starts with closers dedents once for each", () => {
    expect(formatSource(page("Text { value: [\n1\n] }"))).toBe(
      page("    Text { value: [\n        1\n    ] }"),
    );
  });

  test("a closer and an opener on one line sit at the outer depth", () => {
    const source =
      "page P {\nStack { }\nat 23:00 {\nif x {\ncall light.hall.turn_on\n} else {\ncall light.hall.turn_off\n}\n}\n}\n";
    expect(formatSource(source)).toBe(
      "page P {\n  Stack { }\n  at 23:00 {\n    if x {\n      call light.hall.turn_on\n    } else {\n      call light.hall.turn_off\n    }\n  }\n}\n",
    );
  });

  test("keeps the writer's line breaks: a one-line page stays on one line", () => {
    const source = "page P { Stack { Text { value: 1 } } }\n";
    expect(formatSource(source)).toBe(source);
  });
});

describe("operators and separators", () => {
  test("an operator has one space either side", () => {
    expect(line("Text { value: 1+2*3/4%5 }")).toBe("    Text { value: 1 + 2 * 3 / 4 % 5 }");
    expect(line("Text { value: a&&b||c??d }")).toBe("    Text { value: a && b || c ?? d }");
    expect(line("Text { value: a==b!=c<=d>=e<f>g }")).toBe(
      "    Text { value: a == b != c <= d >= e < f > g }",
    );
  });

  test("extra space around an operator is taken out", () => {
    expect(line("Text { value: a   +    b }")).toBe("    Text { value: a + b }");
  });

  test("an arrow and an assignment are operators too", () => {
    expect(line("Text { value: (v)=>set r=v }")).toBe("    Text { value: (v) => set r = v }");
  });

  test("a comma has no space before it and one after", () => {
    expect(line("Text { value: [1 ,2,   3] }")).toBe("    Text { value: [1, 2, 3] }");
    expect(line("Text { value: f(1 , 2) }")).toBe("    Text { value: f(1, 2) }");
  });

  test("a semicolon has no space before it and one after", () => {
    expect(line("Text { value: 1 ;size: 2 }")).toBe("    Text { value: 1; size: 2 }");
  });

  // After an operator a `(` or `[` cannot be a call or an index, so its space is the style's.
  test("an operator has one space before a ( or [ that follows it", () => {
    expect(line("Text { value: x+(1) }")).toBe("    Text { value: x + (1) }");
    expect(line("Text { value: a?[1]:[2] }")).toBe("    Text { value: a ? [1] : [2] }");
  });

  test("nothing pads the inside of ( or [", () => {
    expect(line("Text { value: f( 1 ) + [ 2 ][ 0 ] }")).toBe("    Text { value: f(1) + [2][0] }");
  });
});

describe("colons", () => {
  test("a property's colon has no space before it and one after", () => {
    expect(line("Text { value:1 }")).toBe("    Text { value: 1 }");
    expect(line("Text { value   :   1 }")).toBe("    Text { value: 1 }");
  });

  test("a parameter's colon is a property's", () => {
    expect(signature("of : Entity,hot:Number = 25")).toBe("of: Entity, hot: Number = 25");
  });

  test("the ternary's colon is spaced like an operator", () => {
    expect(line("Text { value: a?1:2 }")).toBe("    Text { value: a ? 1 : 2 }");
  });

  test("nested and chained ternaries are spaced at every colon", () => {
    expect(line("Text { value: a?b?1:2:3 }")).toBe("    Text { value: a ? b ? 1 : 2 : 3 }");
    expect(line("Text { value: a?1:b?2:3 }")).toBe("    Text { value: a ? 1 : b ? 2 : 3 }");
  });

  test("a ternary inside brackets is spaced, and so is one with brackets in its branches", () => {
    expect(line("Text { value: f(a?b:c, d) }")).toBe("    Text { value: f(a ? b : c, d) }");
    expect(line("Text { value: a ? [1] : (2) }")).toBe("    Text { value: a ? [1] : (2) }");
  });

  test("after a ternary, the next property's colon is a property's again", () => {
    expect(line("Text { value: a?1:2 size:3 }")).toBe("    Text { value: a ? 1 : 2  size: 3 }");
  });
});

describe("braces", () => {
  test("a block on one line has a space inside each brace", () => {
    expect(line("Card {value: 1}")).toBe("    Card { value: 1 }");
  });

  test("an empty block is `{ }`", () => {
    expect(line("Card {}")).toBe("    Card { }");
    expect(line("Card {     }")).toBe("    Card { }");
  });

  test("a brace has one space before it", () => {
    expect(line("Card{ value: 1 }")).toBe("    Card { value: 1 }");
    expect(line("Card    { value: 1 }")).toBe("    Card { value: 1 }");
  });
});

describe("things sharing a line in a block", () => {
  test("two properties are two spaces apart", () => {
    expect(line("Text { value: 1 size: 2 }")).toBe("    Text { value: 1  size: 2 }");
  });

  test("a property after a string, a member or a closer is two spaces on", () => {
    expect(line('Text { value: "a" size: 2 }')).toBe('    Text { value: "a"  size: 2 }');
    expect(line("Text { value: .On size: 2 }")).toBe("    Text { value: .On  size: 2 }");
    expect(line("Text { value: f(x) size: 2 }")).toBe("    Text { value: f(x)  size: 2 }");
  });

  test("a property after a field named by a reserved word is two spaces on", () => {
    expect(line("Forecast { weather: weather.home when: true }")).toBe(
      "    Forecast { weather: weather.home  when: true }",
    );
    expect(line("Forecast { weather: weather.weather when: true }")).toBe(
      "    Forecast { weather: weather.weather  when: true }",
    );
  });

  test("a node after a property is two spaces on", () => {
    expect(line('Card { name: "a" Row { of: light.hall } }')).toBe(
      '    Card { name: "a"  Row { of: light.hall } }',
    );
  });

  test("a for after a property is two spaces on", () => {
    expect(line('Card { name: "a" for e in areas { Row { of: e } } }')).toBe(
      '    Card { name: "a"  for e in areas { Row { of: e } } }',
    );
  });

  test("a gap already two spaces wide is kept, and a wider one narrowed", () => {
    expect(line("Text { value: 1  size: 2 }")).toBe("    Text { value: 1  size: 2 }");
    expect(line("Text { value: 1      size: 2 }")).toBe("    Text { value: 1  size: 2 }");
  });

  // `at` and `state` are keywords, but as a field or attribute name they end a value.
  test("a property after an attribute or field named by a keyword is two spaces on", () => {
    expect(line("Text { value: sensor.x#at size: 2 }")).toBe(
      "    Text { value: sensor.x#at  size: 2 }",
    );
  });
});

describe("generics", () => {
  test("List<T> is glued", () => {
    expect(signature("of: List < Entity >")).toBe("of: List<Entity>");
  });

  test("Enum<A | B> is glued at its angles and spaced at its bar", () => {
    expect(signature("k: Enum < A|B >")).toBe("k: Enum<A | B>");
  });

  test("nested generics close glued, and a default after one is spaced", () => {
    expect(signature("of: List<Enum<A|B>>, n: List<Number>   =   [1]")).toBe(
      "of: List<Enum<A | B>>, n: List<Number> = [1]",
    );
  });

  test("a comparison is not a generic", () => {
    expect(line("Text { value: a<b }")).toBe("    Text { value: a < b }");
  });
});

describe("signs and subtraction", () => {
  test("a sign stays glued to what it signs", () => {
    expect(line("Text { value: -1 }")).toBe("    Text { value: -1 }");
    expect(line("Text { value: - 1 }")).toBe("    Text { value: -1 }");
  });

  test("a sign after an operator is glued", () => {
    expect(line("Text { value: x * -1 }")).toBe("    Text { value: x * -1 }");
    expect(line("Text { value: x*- 1 }")).toBe("    Text { value: x * -1 }");
  });

  test("a sign after an opener or a comma is glued", () => {
    expect(line("Text { value: [- 1, - 2] }")).toBe("    Text { value: [-1, -2] }");
    expect(line("Text { value: f(- 1) }")).toBe("    Text { value: f(-1) }");
  });

  test("a sign in a parameter's default is glued", () => {
    expect(signature("n: Number=- 2")).toBe("n: Number = -2");
  });

  test("a subtraction is spaced, after any kind of value", () => {
    expect(line("Text { value: a-1 }")).toBe("    Text { value: a - 1 }");
    expect(line("Text { value: 2-1 }")).toBe("    Text { value: 2 - 1 }");
    expect(line("Text { value: 10m-1 }")).toBe("    Text { value: 10m - 1 }");
    expect(line("Text { value: (a)-1 }")).toBe("    Text { value: (a) - 1 }");
    expect(line("Text { value: [1]-1 }")).toBe("    Text { value: [1] - 1 }");
    expect(line("Text { value: true-1 }")).toBe("    Text { value: true - 1 }");
  });

  // As above: after a keyword-named attribute, a minus subtracts.
  test("a subtraction after an attribute named by a keyword is spaced", () => {
    expect(line("Text { value: sensor.x#at-1 }")).toBe("    Text { value: sensor.x#at - 1 }");
  });
});

describe("not", () => {
  test("! is glued to what it negates", () => {
    expect(line("Text { value: ! x }")).toBe("    Text { value: !x }");
    expect(line("Text { value: !(x) }")).toBe("    Text { value: !(x) }");
  });
});

describe("what gluing means", () => {
  test("a call stays glued", () => {
    expect(line("Text { value: f(x) }")).toBe("    Text { value: f(x) }");
  });

  test("a value then a group stays spaced", () => {
    // `f (x)` is not a call, and here it is not even a program, so it is left as written; the
    // test is that the space is not taken out to make it one.
    const source = page("    Text { value: f (x) }");
    expect(formatSource(source)).toBe(source);
  });

  test("an index stays glued", () => {
    expect(line("Text { value: a[0] }")).toBe("    Text { value: a[0] }");
  });

  test("an attribute stays glued", () => {
    expect(line("Text { value: sensor.x#at }")).toBe("    Text { value: sensor.x#at }");
  });

  test("an id that starts with a digit stays one id", () => {
    expect(line("Text { value: sensor.3d_printer.value }")).toBe(
      "    Text { value: sensor.3d_printer.value }",
    );
  });

  test("a dot is glued on both sides", () => {
    expect(line("Text { value: sensor . x }")).toBe("    Text { value: sensor.x }");
  });
});

describe("comments", () => {
  test("a comment on a line of its own is kept and indented", () => {
    expect(formatSource("// top\npage P {\n// own\n  Stack { }\n    /* block */\n}\n")).toBe(
      "// top\npage P {\n  // own\n  Stack { }\n  /* block */\n}\n",
    );
  });

  test("a trailing comment is two spaces after the code", () => {
    expect(formatSource("page P {\n  Stack { } // trailing\n}\n")).toBe(
      "page P {\n  Stack { }  // trailing\n}\n",
    );
    expect(formatSource("page P {\n  Stack { }/* b */\n}\n")).toBe(
      "page P {\n  Stack { }  /* b */\n}\n",
    );
  });

  test("a line comment loses its trailing space", () => {
    expect(formatSource("page P {\n  Stack { }  // trailing   \n}\n")).toBe(
      "page P {\n  Stack { }  // trailing\n}\n",
    );
  });

  test("a block comment over several lines is kept as written", () => {
    const source = "page P {\n  Stack {\n    /* one\n  two */\n  }\n}\n";
    expect(formatSource(source)).toBe(source);
  });

  // A bracket inside a comment opens nothing, so the blank line after it stays.
  test("an empty source stays empty", () => {
    expect(formatSource("")).toBe("");
  });

  test("a blank line after a comment that ends in a bracket is kept", () => {
    const source = page("    Text { value: 1 }\n    // see the list (\n\n    Text { value: 2 }");
    expect(formatSource(source)).toBe(source);
  });
});

describe("blank lines and the ends of the file", () => {
  test("a run of blank lines is one", () => {
    expect(formatSource(page("    Text { value: 1 }\n\n\n\n    Text { value: 2 }"))).toBe(
      page("    Text { value: 1 }\n\n    Text { value: 2 }"),
    );
  });

  test("a line of only spaces is blank", () => {
    expect(formatSource(page("    Text { value: 1 }\n      \n    Text { value: 2 }"))).toBe(
      page("    Text { value: 1 }\n\n    Text { value: 2 }"),
    );
  });

  test("there is none after an opening line", () => {
    expect(formatSource("page P {\n\n  Stack { }\n}\n")).toBe("page P {\n  Stack { }\n}\n");
  });

  test("there is none before a closing line", () => {
    expect(formatSource("page P {\n  Stack { }\n\n}\n")).toBe("page P {\n  Stack { }\n}\n");
  });

  test("there is none at the start or the end of the file", () => {
    expect(formatSource("\n\npage P {\n  Stack { }\n}\n\n\n")).toBe("page P {\n  Stack { }\n}\n");
  });

  test("the file ends in one newline, added if missing", () => {
    expect(formatSource("page P {\n  Stack { }\n}")).toBe("page P {\n  Stack { }\n}\n");
  });

  test("trailing space is taken off every line", () => {
    expect(formatSource("page P {   \n  Stack { }  \n}\n")).toBe("page P {\n  Stack { }\n}\n");
  });

  test("carriage returns are dropped", () => {
    expect(formatSource("page P {\r\n  Stack { }\r\n}\r\n")).toBe("page P {\n  Stack { }\n}\n");
  });
});

describe("a source that does not parse", () => {
  test("is returned unchanged", () => {
    const source = "page P {\n Stack {Text { value:1+ \n}\n";
    expect(formatSource(source)).toBe(source);
  });

  test("includes one where ?20:30 lexes as a time", () => {
    const source = page("    Text { value: x ?20:30 }");
    expect(formatSource(source)).toBe(source);
  });

  test("but ?2:3 is a ternary and is spaced", () => {
    expect(line("Text { value: x ?2:3 }")).toBe("    Text { value: x ? 2 : 3 }");
  });

  test("includes a page with two roots", () => {
    const two = "page P {\nStack { }\nStack { }\n}\n";
    expect(formatSource(two)).toBe(two);
  });
});

describe("the stock sources", () => {
  const sources = [
    ["the Home page", HOME, { requirePage: true }],
    ["the bundled headers", HEADERS_SOURCE, { componentsOnly: true }],
    ["the October theme", OCTOBER_SOURCE, {}],
  ] as const;

  for (const [name, source, options] of sources) {
    test(`${name} formats to a fixed point`, () => {
      const once = formatSource(source);
      expect(formatSource(once)).toBe(once);
    });

    test(`${name} compiles the same once formatted`, () => {
      const run = (text: string) => compile({ source: text, registry: REGISTRY, ...options });
      const before = run(source);
      const after = run(formatSource(source));
      expect(after.diagnostics).toEqual(before.diagnostics);
      expect(after.page).toEqual(before.page);
      expect(after.themes).toEqual(before.themes);
    });
  }

  test("the Home page loses only the double space before a brace", () => {
    expect(formatSource(HOME)).toBe(HOME.replace("History  {", "History {"));
  });
});

describe("run", () => {
  test("a badly indented automation with a `run` is formatted like any statement", () => {
    const source =
      'automation Porch {\non switch.porch changed to .On {\n        run zwave_js.main.led_notify {\n deviceId: device.dev_porch\n\t\teffect: "pulse", color: 0\n      }\n   call light.hall.turn_on\n}\n}\n';
    expect(formatSource(source)).toBe(
      'automation Porch {\n  on switch.porch changed to .On {\n    run zwave_js.main.led_notify {\n      deviceId: device.dev_porch\n      effect: "pulse", color: 0\n    }\n    call light.hall.turn_on\n  }\n}\n',
    );
  });

  test("formatted, it still compiles to the same handler", () => {
    const source =
      "automation Porch {\non switch.porch changed {\nif switch.porch.value == .On {\nrun hue.2.blink { n: 1 }\n}\n}\n}\n";
    const formatted = formatSource(source);
    expect(formatted).toBe(
      "automation Porch {\n  on switch.porch changed {\n    if switch.porch.value == .On {\n      run hue.2.blink { n: 1 }\n    }\n  }\n}\n",
    );
    const body = (text: string) =>
      compile({ source: text, registry: REGISTRY, automationOnly: true }).serverHandlers[0]?.body;
    expect(body(formatted)).toEqual(body(source));
  });

  test("a state named `run` formats as a name", () => {
    expect(formatSource("page P {\nstate run = 1\nStack { Text { value: run } }\n}\n")).toBe(
      "page P {\n  state run = 1\n  Stack { Text { value: run } }\n}\n",
    );
  });
});

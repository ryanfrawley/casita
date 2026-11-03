import { describe, expect, test } from "bun:test";
import { actionParams, type Registry, runName } from "./check.ts";
import { compile } from "./compile.ts";
import { HOME, REGISTRY } from "./fixtures.ts";
import { show } from "./types.ts";

const page = (body: string, head = "") => `${head}\npage Home {\n${body}\n}\n`;
const run = (source: string, extra: Partial<Parameters<typeof compile>[0]> = {}) =>
  compile({ source, registry: REGISTRY, requirePage: true, ...extra });
const codes = (source: string) => run(source).diagnostics.map((d) => d.code);
const messages = (source: string) => run(source).diagnostics.map((d) => `${d.code} ${d.message}`);

describe("the stock Home page", () => {
  const result = run(HOME);

  test("compiles clean", () => {
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.page?.name).toBe("Home");
  });

  test("collects the theme paths and entities it reads", () => {
    expect(result.themeRefs).toEqual([
      "accents.sage",
      "chart.good",
      "chart.series1",
      "palette.warn",
    ]);
    expect(result.entities).toContain("switch.porch");
    expect(result.entities).toContain("light.hall");
    expect(result.entities).toContain("weather.home");
  });

  test("partitions the two handlers onto the server", () => {
    expect(result.serverHandlers).toHaveLength(2);
    expect(result.serverHandlers[0]?.trigger).toEqual({
      kind: "changed",
      entity: "switch.porch",
      attr: undefined,
      to: ["member", "On"],
      from: undefined,
    });
    expect(result.serverHandlers[0]?.body).toEqual([
      ["call", "light.hall", "turn_on", { brightness: ["lit", 0.6] }],
      ["after", 600_000, [["call", "light.hall", "turn_off", {}]]],
    ]);
    expect(result.serverHandlers[1]?.trigger).toEqual({ kind: "at", minutes: 23 * 60 });
  });

  test("compiles the file's themes over Day and Night", () => {
    expect(result.themes.map((t) => t.id)).toEqual(["house", "housenight"]);
    expect(result.themes[0]?.values["palette.warn"]).toEqual({ kind: "color", hex: "#d9593a" });
    expect(result.themes[0]?.values["palette.lamp"]).toEqual({ kind: "color", hex: "#eaa63e" });
    expect(result.themes[0]?.css).toContain('[data-theme="house"]');
    expect(result.themes[0]?.css).toContain("--palette-warn: #d9593a;");
    expect(result.themes[1]?.css).toContain("color-scheme: dark;");
  });

  test("emits a component with its state and a generic Segmented", () => {
    const temp = result.page?.components.Temp;
    expect(temp?.params).toEqual([
      { name: "of", default: undefined },
      { name: "hot", default: ["lit", 25] },
    ]);
    expect(temp?.state).toEqual([{ name: "range", init: ["member", "Day"] }]);
    const segmented = temp?.root.children.find((c) => c.t === "node" && c.type === "Segmented");
    expect(segmented && segmented.t === "node" ? segmented.props.onChange : undefined).toEqual({
      h: { params: ["v"], body: [["set", "range", ["var", "v"]]] },
    });
  });

  test("keeps the AST version and source positions", () => {
    expect(result.page?.astVersion).toBe(1);
    expect(result.page?.root.at).toEqual([26, 3]);
  });

  test("is deterministic", () => {
    expect(JSON.stringify(run(HOME).page)).toBe(JSON.stringify(result.page));
  });
});

describe("one fixture per diagnostic", () => {
  test("E001 syntax", () => {
    expect(messages(page("  Card { }\n  }"))).toEqual([
      "E001 syntax: unexpected `}` at 5:1, expected `theme`, `component`, `page`, `automation` or `sensor`",
    ]);
    expect(codes("page Home { Card { name: } }")).toEqual(["E001"]);
    expect(codes(page("  Card { 1 }"))).toEqual(["E001"]);
  });

  test("E002 unknown built-in or component", () => {
    expect(messages(page("  Crad { }"))).toEqual([
      "E002 unknown built-in or component `Crad`; did you mean `Card`",
    ]);
  });

  test("E002 a Room, which is an Area now, with no alias", () => {
    expect(messages(page("  Room { area: area.living }"))).toEqual([
      "E002 `Room` is now `Area`, its area given as `of`: `Area { of: area.hall }`",
    ]);
    expect(run(page("  Room { area: area.living }")).ok).toBe(false);
  });

  test("E003 an Area's `area`, which is `of` now", () => {
    expect(messages(page("  Area { area: area.living }"))).toEqual([
      "E003 `Area` takes its area as `of` now: `Area { of: area.hall }`",
    ]);
    expect(codes(page("  Area { of: area.living }"))).toEqual([]);
  });

  test("an Area's header is a Bool or a component", () => {
    expect(codes(page("  Area { of: area.living  header: false }"))).toEqual([]);
    expect(codes(page("  Area { of: area.living  header: true }"))).toEqual([]);
    expect(codes(page('  Area { of: area.living  header: "no" }'))).toEqual(["E030"]);
  });

  test("E003 unknown property", () => {
    const [message] = messages(page("  Card { colour: palette.ink }"));
    expect(message).toStartWith(
      "E003 property `colour` is not defined on `Card`; its properties are ",
    );
    expect(message).toEndWith(
      "accent, size, header, dividers, name, subtitle, of, icon, active, onPress",
    );
  });

  test("E004 property twice", () => {
    expect(messages(page("  Card { accent: palette.ink  accent: palette.ink }"))).toEqual([
      "E004 property `accent` given twice on this `Card`",
    ]);
  });

  test("E005 unknown name", () => {
    expect(messages(page("  Text { value: nmae }"))).toEqual(["E005 unknown name `nmae`"]);
  });

  test("E010 unknown entity and area", () => {
    expect(messages(page("  Headline { of: sensor.livng_temp }"))).toEqual([
      "E010 unknown entity `sensor.livng_temp`; did you mean `sensor.living_temp`",
    ]);
    expect(messages(page("  Area { of: area.livingroom }"))).toEqual([
      "E010 unknown area `livingroom`; did you mean `living`",
    ]);
  });

  test("E012 wrong domain on a control", () => {
    expect(messages(page("  Thermostat { of: sensor.outside }"))).toEqual([
      "E012 `Thermostat` needs a climate entity; `sensor.outside` is a sensor",
    ]);
  });

  test("E012 wrong domain in a ButtonGroup, item by item", () => {
    expect(
      messages(page("  ButtonGroup { of: [cover.garage, sensor.outside, light.hall] }")),
    ).toEqual([
      "E012 `ButtonGroup` needs a cover or switch or light or button entity; `sensor.outside` is a sensor",
    ]);
    expect(codes(page("  ButtonGroup { of: [cover.garage, switch.porch] }"))).toEqual([]);
  });

  test("E013 unknown icon", () => {
    expect(messages(page('  Icon { name: "thermometr" }'))).toEqual([
      "E013 unknown icon `thermometr`; the gallery lists the icon names; did you mean `thermometer`",
    ]);
    expect(codes(page('  Card { icon: "lightbulb" }'))).toEqual([]);
  });

  test("E020 colour literal outside a theme", () => {
    expect(messages(page('  Text { value: "x"  color: #fff }'))).toEqual([
      "E020 a colour literal is only allowed inside `theme`; use a palette name",
    ]);
  });

  test("E021 theme coverage", () => {
    // The built-ins are what a viewer can pick, and none of them has `warn`.
    expect(messages(page("  Card { accent: palette.warn }"))).toEqual([
      "E021 `palette.warn` is not defined by theme `Day`; add it to `Day` or to a theme it extends",
      "E021 `palette.warn` is not defined by theme `Night`; add it to `Night` or to a theme it extends",
      "E021 `palette.warn` is not defined by theme `October`; add it to `October` or to a theme it extends",
    ]);
    // One house theme covers it; it is now the only theme a viewer can pick.
    expect(
      codes(
        page(
          "  Card { accent: palette.warn }",
          "theme Dusk extends Night { palette { warn: #d9593a } }",
        ),
      ),
    ).toEqual([]);
    // Two house themes, one without it.
    expect(
      messages(
        page(
          "  Card { accent: palette.warn }",
          "theme Dusk extends Night { palette { warn: #d9593a } }\ntheme Dawn extends Day { }",
        ),
      ),
    ).toEqual([
      "E021 `palette.warn` is not defined by theme `Dawn`; add it to `Dawn` or to a theme it extends",
    ]);
    expect(messages(page("  Card { }", "theme Dusk extends Dark { }"))).toEqual([
      "E021 theme `Dusk` extends `Dark`, which is not a theme",
    ]);
    for (const name of ["Day", "Night", "October", "OCTOBER"]) {
      expect(messages(page("  Card { }", `theme ${name} extends Night { }`))).toEqual([
        `E021 \`${name}\` is built in and cannot be redeclared; extend it instead`,
      ]);
    }
    expect(
      messages(page("  Card { }", "theme Dusk extends Night { palette { warn: plaser } }")),
    ).toEqual(["E021 `plaser` is not a palette colour this theme has; did you mean `plaster`"]);
    // A house theme over October covers it alone, and inherits October's palette.
    const hallow = run(
      page(
        "  Card { accent: palette.warn }",
        "theme Hallow extends October { palette { warn: #d9593a } }",
      ),
    );
    expect(hallow.diagnostics).toEqual([]);
    expect(hallow.themes[0]?.values["palette.terracotta"]).toEqual({
      kind: "color",
      hex: "#f08a2e",
    });
  });

  test("E022 unknown theme key", () => {
    expect(
      messages(
        page("  Card { }", "theme Dusk extends Night { surface.card { glow: palette.lamp } }"),
      ),
    ).toEqual(["E022 theme group `surface.card` has no key `glow`"]);
    expect(
      messages(page('  Card { accent: palette.ink  Text { value: "x"  color: text.glow } }')),
    ).toEqual(["E022 theme group `text` has no key `glow`"]);
  });

  test("E030 type mismatch", () => {
    expect(messages(page("  Text { value: 3 }"))).toEqual([
      "E030 type mismatch: this expects String, got Number; wrap it in `format()`",
    ]);
    expect(codes(page("  Text { value: format(3) }"))).toEqual([]);
    expect(codes(page('  Text { value: "a" + 3 }'))).toEqual([]);
    expect(codes(page("  Card { span: 10m + 1 }"))).toEqual(["E030"]);
    expect(codes(page('  Card { when: sensor.outside.value > "a" }'))).toEqual(["E030"]);
    expect(codes(page("  Card { when: switch.porch.value }"))).toEqual(["E030"]);
  });

  describe("E030 a reference compared with a plain value", () => {
    const attribute =
      "E030 an attribute is not its value, so this is never equal; compare `weather.home#x.value`";

    test("an attribute against a string, either way round, with == or !=", () => {
      expect(messages(page('  Card { when: weather.home#x == "rain" }'))).toEqual([attribute]);
      expect(messages(page('  Card { when: "rain" == weather.home#x }'))).toEqual([attribute]);
      expect(messages(page('  Card { when: weather.home#x != "rain" }'))).toEqual([attribute]);
    });

    test("an entity against a number names the entity's `.value`", () => {
      expect(messages(page("  Card { when: sensor.outside == 3 }"))).toEqual([
        "E030 an entity is not its value, so this is never equal; compare `sensor.outside.value`",
      ]);
    });

    test("a bool, a duration and a time are plain values too", () => {
      expect(codes(page("  Card { when: light.hall == true }"))).toEqual(["E030"]);
      expect(codes(page("  Card { when: sensor.outside#age == 5m }"))).toEqual(["E030"]);
      expect(codes(page("  Card { when: sensor.outside#since == 07:30 }"))).toEqual(["E030"]);
    });

    test("an entity bound to a name gets the general hint", () => {
      expect(messages(page("  Card { active: any(area.living.entities, (e) => e == 3) }"))).toEqual(
        ["E030 an entity is not its value, so this is never equal; compare its `.value`"],
      );
    });

    test("values, members and other references still compare", () => {
      expect(codes(page('  Card { when: weather.home#x.value == "rain" }'))).toEqual([]);
      expect(codes(page("  Card { when: sensor.outside.value != 3 }"))).toEqual([]);
      expect(codes(page("  Card { when: light.hall == light.living_lamp }"))).toEqual([]);
      expect(codes(page("  Card { when: switch.porch.value == .On }"))).toEqual([]);
    });

    test("an automation's handler is checked the same way", () => {
      const source = `automation Rain {
  on weather.home#x changed { if weather.home#x == "rain" { call light.hall.turn_on } }
}
`;
      expect(
        compile({ source, registry: REGISTRY, automationOnly: true }).diagnostics.map(
          (d) => `${d.code} ${d.message}`,
        ),
      ).toEqual([attribute]);
    });
  });

  test("E031 children where none go", () => {
    expect(messages(page('  Headline { of: sensor.outside  Text { value: "x" } }'))).toEqual([
      "E031 `Headline` takes no children",
    ]);
    expect(
      messages(page('  Plain { Text { value: "x" } }', "component Plain() { Card { } }")),
    ).toEqual(["E031 `Plain` takes no children"]);
    expect(
      codes(page('  Wrap { Text { value: "x" } }', "component Wrap() { Card { children } }")),
    ).toEqual([]);
  });

  test("E032 recursion", () => {
    const head = "component A() { Card { B { } } }\ncomponent B() { Card { A { } } }";
    expect(messages(page("  A { }", head))).toContain("E032 component `A` uses itself through `B`");
  });

  test("E033 required parameter missing", () => {
    expect(
      messages(page("  Temp { }", "component Temp(of: Entity, hot: Number = 25) { Card { } }")),
    ).toEqual(["E033 required parameter `of` missing on `Temp`"]);
    expect(messages(page("  Headline { }"))).toEqual([
      "E033 required property `of` missing on `Headline`",
    ]);
    // A Value may stand on words of its own, with no reading.
    expect(
      codes(page('  Value { label: "Watered"  text: date(sensor.outside.changedAt) }')),
    ).toEqual([]);
  });

  test("E034 set targets a parameter", () => {
    const head = "component Temp(range: Number) { Card { onPress: () => set range = 1 } }";
    expect(messages(page("  Temp { range: 1 }", head))).toEqual([
      "E034 `set` targets `range`, which is a parameter, not state",
    ]);
  });

  test("E040 enum compared to a string", () => {
    expect(messages(page('  Card { when: switch.porch.value == "on" }'))).toEqual([
      "E040 comparing enum On | Off to a String; use .On",
    ]);
    expect(codes(page("  Card { when: switch.porch.value == .On }"))).toEqual([]);
    expect(codes(page("  Card { when: .On == switch.porch.value }"))).toEqual([]);
    expect(codes(page("  Card { when: switch.porch.value == .Open }"))).toEqual(["E030"]);
  });

  test("E041 enum member with no expected type", () => {
    expect(messages(page("  state range = .Day\n  Card { }"))).toEqual([
      "E041 enum member .Day has no expected type here; give it one, such as a state with a type: state range: Enum<Hour | Day | Week> = .Day",
    ]);
    expect(codes(page("  state range: Enum<Hour | Day | Week> = .Day\n  Card { }"))).toEqual([]);
  });

  test("E050 server handler reads the browser", () => {
    expect(
      messages(
        page(
          "  Card { }\n  on switch.porch changed { if screen == .Phone { call light.hall.turn_on } }",
        ),
      ),
    ).toEqual(["E050 server handler reads `screen`, which only exists in the browser"]);
    expect(
      messages(page("  state n = 1\n  Card { }\n  on switch.porch changed { set n = 2 }")),
    ).toEqual(["E050 server handler sets local state, which only exists in the browser"]);
    expect(
      messages(
        page(
          "  state n = 1\n  Card { }\n  on switch.porch changed { if n > 1 { call light.hall.turn_on } }",
        ),
      ),
    ).toEqual(["E050 server handler reads `n`, local state that only exists in the browser"]);
    expect(
      codes(
        page(
          "  Card { }\n  on switch.porch changed { if palette.lamp == palette.sky { call light.hall.turn_on } }",
        ),
      ),
    ).toContain("E050");
    // A lambda binds its own parameter; the server evaluates it like any expression.
    expect(
      codes(
        page(
          "  Card { }\n  on switch.porch changed { if any(entities, (e) => e.value == .On) { call light.hall.turn_on } }",
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        page(
          "  Card { }\n  on switch.porch changed { if now.time > 18:00 { call light.hall.turn_on } }",
        ),
      ),
    ).toEqual([]);
  });

  test("E051 handler inside a component", () => {
    const head =
      "component A() { Card { }\n  on switch.porch changed { call light.hall.turn_on } }";
    expect(codes(page("  A { }", head))).toContain("E051");
  });

  test("E060 unknown command or argument", () => {
    expect(
      messages(
        page("  Card { }\n  on switch.porch changed { call switch.porch.turn_on { color: 1 } }"),
      ),
    ).toEqual(["E060 command `turn_on` takes no argument `color` for a switch"]);
    expect(messages(page("  Card { }\n  on switch.porch changed { call light.hall.dim }"))).toEqual(
      ["E060 a light has no command `dim`; it takes turn_on, turn_off"],
    );
    expect(
      messages(page("  Card { }\n  on switch.porch changed { call climate.living.set_target }")),
    ).toEqual(["E060 command `set_target` needs `temp`"]);
    expect(
      codes(
        page(
          "  Card { }\n  on switch.porch changed { call climate.living.set_mode { mode: .Heat } }",
        ),
      ),
    ).toEqual([]);
  });

  test("E061 after in a browser handler", () => {
    expect(
      messages(page("  Card { onPress: () => after 1m { call light.hall.turn_on } }")),
    ).toEqual(["E061 `after` is only allowed in server handlers"]);
  });

  test("W100 when: true", () => {
    expect(messages(page("  Card { when: true }"))).toEqual(["W100 `when: true` has no effect"]);
    expect(run(page("  Card { when: true }")).ok).toBe(true);
  });

  test("W101 unused component", () => {
    expect(messages(page("  Card { }", "component Spare() { Card { } }"))).toEqual([
      "W101 component `Spare` is never used",
    ]);
  });

  test("W102 for without a key", () => {
    expect(messages(page("  Stack { for n in [1, 2] { Text { value: format(n) } } }"))).toEqual([
      "W102 `for` over a list without a `key`; items will be keyed by index",
    ]);
    expect(codes(page("  Stack { for e in areas { Area { of: e } } }"))).toEqual([]);
  });

  test("W105 a component named RoomHeader, which is AreaHeader now", () => {
    expect(
      messages(
        page(
          '  Area { of: area.living  name: "Living" }',
          "component RoomHeader(of: Area) { Text { value: of.name } }",
        ),
      ),
    ).toContain(
      "W105 `RoomHeader` is now `AreaHeader`; rename it, as it is only drawn for an `Area` given a `name` or an `icon`",
    );
  });

  test("W104 a retired built-in draws nothing", () => {
    expect(messages(page("  Stack { Search {} }"))).toEqual([
      "W104 `Search` is retired: the search is in the header on every page now; this node draws nothing",
    ]);
    expect(run(page("  Stack { Search {} }")).ok).toBe(true);
  });

  test("W103 a chatty sensor trigger", () => {
    expect(
      messages(page("  Card { }\n  on sensor.living_power changed { call light.hall.turn_on }")),
    ).toEqual([
      "W103 handler fires on every change of `sensor.living_power`, which may report every few seconds",
    ]);
  });

  test("E035 a header that is not a component", () => {
    expect(messages(page("  Area { of: area.living  header: Nope }"))).toEqual([
      "E035 `Nope` is not a component",
    ]);
    expect(messages(page("  Area { of: area.living  header: Card }"))).toEqual([
      "E035 `Card` is a built-in, not a component; a header is a component you declare",
    ]);
  });

  test("E036 a header whose parameters the slot cannot fill", () => {
    expect(
      messages(
        page(
          "  Area { of: area.living  header: Named }",
          "component Named(title: String) { Text { value: title } }",
        ),
      ),
    ).toEqual([
      "E036 `Named` cannot draw this header: its parameters must be among of: Area, name: String, icon: String, each of that type or with a default",
    ]);
    // A parameter with a default may be left for the slot to omit; one of the slot's own
    // may be of a wider type.
    expect(
      codes(
        page(
          '  Stack {\n  Area { of: area.living  header: Spare }\n  Section { title: "Now"  header: Loud }\n  }',
          "component Spare(of: Area, big: Bool = false) { Text { value: of.name } }\ncomponent Loud(title: String) { Text { value: upper(title) } }",
        ),
      ),
    ).toEqual([]);
  });

  test("E037 a Grid's columns are 1 to 3, or one per child", () => {
    expect(messages(page('  Grid { columns: 4  Text { value: "a" } }'))).toEqual([
      "E037 a `Grid` has 1 to 3 columns, not 4",
    ]);
    expect(codes(page('  Grid { columns: 0  Text { value: "a" } }'))).toEqual(["E037"]);
    expect(codes(page('  Grid { columns: 1.5  Text { value: "a" } }'))).toEqual(["E037"]);
    // Left out, there is a column per child, so the children must be nodes, not a loop.
    expect(messages(page("  Grid { for e in areas { Area { of: e } } }"))).toEqual([
      "E037 a `Grid` without `columns` has one per child, so its children cannot be a `for`; give it `columns` (1 to 3)",
    ]);
    expect(codes(page('  Grid { Text { value: "a" }  Text { value: "b"  align: .End } }'))).toEqual(
      [],
    );
    expect(codes(page("  Grid { columns: 3  for e in areas { Area { of: e } } }"))).toEqual([]);
    // A computed count is clamped when drawn, not checked here.
    expect(
      codes(page('  Grid { columns: screen == .Phone ? 1 : 4  Text { value: "a" } }')),
    ).toEqual([]);
  });

  test("a History or Timeline reaches back a duration, in place of its range", () => {
    expect(codes(page("  History { of: sensor.outside  duration: 6h }"))).toEqual([]);
    expect(codes(page("  Timeline { of: lock.front  duration: 3d }"))).toEqual([]);
    expect(codes(page('  History { of: sensor.outside  duration: "6h" }'))).not.toEqual([]);
  });

  test("E038 a Map needs a place, and a zoom the tiles have", () => {
    expect(codes(page("  Map { of: sensor.outside }"))).toEqual([]);
    expect(
      codes(page("  Map { latitude: 47.6  longitude: -122.3  zoom: 12  height: 240 }")),
    ).toEqual([]);
    // A fixed place is where to look while the entity has none.
    expect(codes(page("  Map { of: sensor.outside  latitude: 47.6  longitude: -122.3 }"))).toEqual(
      [],
    );
    expect(messages(page("  Map { height: 200 }"))).toEqual([
      "E038 a `Map` needs a place: `of` an entity with a location, or `latitude` and `longitude`",
    ]);
    expect(messages(page("  Map { latitude: 47.6 }"))).toEqual([
      "E038 a `Map` given `latitude` needs `longitude` too",
    ]);
    expect(messages(page("  Map { of: sensor.outside  longitude: -122.3 }"))).toEqual([
      "E038 a `Map` given `longitude` needs `latitude` too",
    ]);
    expect(messages(page("  Map { of: sensor.outside  zoom: 20 }"))).toEqual([
      "E038 a `Map`'s zoom is 0 to 19, not 20",
    ]);
    expect(codes(page("  Map { of: sensor.outside  zoom: -1 }"))).toEqual(["E038"]);
    expect(codes(page("  Map { of: sensor.outside  zoom: 12.5 }"))).toEqual(["E038"]);
    expect(codes(page("  Map { of: sensor.outside  zoom: 0 }"))).toEqual([]);
    expect(codes(page("  Map { of: sensor.outside  zoom: 19 }"))).toEqual([]);
    // A computed zoom is clamped when drawn, not checked here.
    expect(codes(page("  Map { of: sensor.outside  zoom: screen == .Phone ? 14 : 30 }"))).toEqual(
      [],
    );
  });

  test("Scale reads a reading on one of the named scales", () => {
    expect(codes(page("  Scale { of: sensor.outside  scale: .PM25 }"))).toEqual([]);
    expect(codes(page('  Scale { of: sensor.outside  scale: .UV  label: "UV index" }'))).toEqual(
      [],
    );
    for (const scale of ["UV", "PM25", "PM10", "AQI", "EAQI"]) {
      expect(codes(page(`  Scale { of: sensor.outside  scale: .${scale} }`))).toEqual([]);
    }
    expect(messages(page("  Scale { of: sensor.outside }"))).toEqual([
      "E033 required property `scale` missing on `Scale`",
    ]);
    expect(messages(page("  Scale { scale: .UV }"))).toEqual([
      "E033 required property `of` missing on `Scale`",
    ]);
    expect(messages(page("  Scale { of: sensor.outside  scale: .Pollen }"))).toEqual([
      "E030 .Pollen is not one of .UV .PM25 .PM10 .AQI .EAQI",
    ]);
    expect(codes(page('  Scale { of: sensor.outside  scale: "UV" }'))).toEqual(["E030"]);
    // `of` is the reading itself, not its value.
    expect(codes(page("  Scale { of: sensor.outside.value  scale: .AQI }"))).toEqual(["E030"]);
    expect(codes(page("  Scale { of: sensor.outside  scale: .UV  label: 3 }"))).toEqual(["E030"]);
    expect(codes(page('  Scale { of: sensor.outside  scale: .UV  Text { value: "a" } }'))).toEqual([
      "E031",
    ]);
  });

  test("SunPath draws a weather entity's day, and only a weather entity's", () => {
    expect(codes(page("  SunPath { weather: weather.home }"))).toEqual([]);
    expect(codes(page('  SunPath { weather: weather.home  label: "The sun" }'))).toEqual([]);
    expect(messages(page("  SunPath { }"))).toEqual([
      "E033 required property `weather` missing on `SunPath`",
    ]);
    expect(messages(page("  SunPath { weather: sensor.outside }"))).toEqual([
      "E030 type mismatch: this expects Entity<weather>, got Entity<sensor>",
    ]);
    expect(codes(page('  SunPath { weather: "weather.home" }'))).toEqual(["E030"]);
    expect(codes(page("  SunPath { weather: weather.nope }"))).toEqual(["E010"]);
    expect(run(page("  SunPath { weather: weather.home }")).entities).toContain("weather.home");
  });

  test("E037 at the edges: 1 and 3 are columns, an empty Grid is one, and one for among nodes is enough", () => {
    expect(codes(page('  Grid { columns: 1  Text { value: "a" } }'))).toEqual([]);
    expect(codes(page('  Grid { columns: 3  Text { value: "a" } }'))).toEqual([]);
    expect(messages(page('  Grid { columns: 3.5  Text { value: "a" } }'))).toEqual([
      "E037 a `Grid` has 1 to 3 columns, not 3.5",
    ]);
    expect(codes(page("  Grid { }"))).toEqual([]);
    // More children than columns is fine: they wrap to the next row.
    expect(
      codes(
        page(
          '  Grid { Text { value: "a" } Text { value: "b" } Text { value: "c" } Text { value: "d" } }',
        ),
      ),
    ).toEqual([]);
    // One diagnostic for the Grid, however many loops it holds.
    expect(
      codes(
        page(
          '  Grid { Text { value: "a" }  for e in areas { Area { of: e } }  for e in areas { Area { of: e } } }',
        ),
      ),
    ).toEqual(["E037"]);
    // A nested Grid is checked on its own.
    expect(
      codes(page("  Grid { columns: 2  Grid { for e in areas { Area { of: e } } } }")),
    ).toEqual(["E037"]);
    // A negative literal is a minus on a number, and still a literal.
    expect(messages(page('  Grid { columns: -1  Text { value: "a" } }'))).toEqual([
      "E037 a `Grid` has 1 to 3 columns, not -1",
    ]);
    // The caller's `children` are as uncountable as a loop's.
    expect(
      messages(page('  Two { Text { value: "a" } }', "component Two() { Grid { children } }")),
    ).toEqual([
      "E037 a `Grid` without `columns` has one per child, so its children cannot be `children`; give it `columns` (1 to 3)",
    ]);
    expect(
      codes(
        page('  Two { Text { value: "a" } }', "component Two() { Grid { columns: 2  children } }"),
      ),
    ).toEqual([]);
  });

  test("align is .Start, .Center or .End on any node; a Stack's own align also takes .Stretch", () => {
    expect(messages(page('  Grid { Text { value: "a"  align: .Left } }'))).toEqual([
      "E030 .Left is not one of .Start .Center .End",
    ]);
    expect(codes(page("  Grid { Card { align: .Stretch } }"))).toEqual(["E030"]);
    expect(messages(page('  Grid { Text { value: "a"  align: "End" } }'))).toEqual([
      "E030 type mismatch: this expects Enum<Start | Center | End>, got String",
    ]);
    expect(codes(page("  Grid { Stack { align: .Stretch } }"))).toEqual([]);
    // Outside a Grid it still type-checks; it just has no cell to place.
    expect(codes(page('  Stack { Text { value: "a"  align: .Center } }'))).toEqual([]);
    expect(
      codes(page('  Grid { Text { value: "a"  align: screen == .Phone ? .Start : .End } }')),
    ).toEqual([]);
  });
});

describe("an automation", () => {
  const automation = (body: string) => `automation HallLight {\n${body}\n}\n`;
  const compiled = (source: string) =>
    compile({ source, registry: REGISTRY, automationOnly: true });
  const codesOf = (source: string) => compiled(source).diagnostics.map((d) => d.code);
  const messagesOf = (source: string) =>
    compiled(source).diagnostics.map((d) => `${d.code} ${d.message}`);

  test("compiles to server handlers with its name and entities", () => {
    const result = compiled(
      automation(
        "  on binary_sensor.hall_motion changed {\n    if binary_sensor.hall_motion.value == .On { call light.hall.turn_on }\n    else if binary_sensor.hall_motion.available { after 5m { call light.hall.turn_off { transitionMs: 2s } } }\n  }\n  at 22:30 { call light.hall.turn_on { brightness: 20% } }",
      ),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.page).toBeUndefined();
    expect(result.automation).toEqual({ name: "HallLight" });
    expect(result.entities).toEqual(["binary_sensor.hall_motion", "light.hall"]);
    expect(result.serverHandlers.map((h) => h.trigger)).toEqual([
      {
        kind: "changed",
        entity: "binary_sensor.hall_motion",
        attr: undefined,
        to: undefined,
        from: undefined,
      },
      { kind: "at", minutes: 22 * 60 + 30 },
    ]);
    expect(result.serverHandlers[0]?.line).toBe(2);
    expect(result.serverHandlers[1]?.body).toEqual([
      ["call", "light.hall", "turn_on", { brightness: ["lit", 0.2] }],
    ]);
  });

  test("may have no handlers yet", () => {
    expect(compiled("automation Empty { }").ok).toBe(true);
    expect(compiled("automation Empty { }").serverHandlers).toEqual([]);
  });

  test("E001 is one automation and nothing else", () => {
    expect(messagesOf("")).toEqual(["E001 the file declares no `automation`"]);
    expect(messagesOf(`${automation("")}automation Other { }`)).toEqual([
      "E001 one `automation` per file; a second automation is a second file",
    ]);
    expect(messagesOf(`${automation("")}page Home { Card { } }`)).toEqual([
      "E001 an automation file holds one `automation` declaration, not a `page`",
    ]);
    expect(messagesOf(`${automation("")}component Tile() { Card { } }`)).toEqual([
      "E001 an automation file holds one `automation` declaration, not a `component`",
    ]);
    expect(messagesOf(`${automation("")}theme Dusk extends Day { }`)).toEqual([
      "E001 an automation file holds one `automation` declaration, not a `theme`",
    ]);
  });

  test("E001 an automation in a page or the shared components file", () => {
    expect(messages(`${page("  Card { }")}automation HallLight { }`)).toEqual([
      "E001 an automation is saved from the Automations page, not in a page",
    ]);
    expect(
      compile({
        source: "component Tile() { Card { } }\nautomation HallLight { }",
        registry: REGISTRY,
        componentsOnly: true,
      }).diagnostics.map((d) => `${d.code} ${d.message}`),
    ).toEqual([
      "E001 an automation is saved from the Automations page, not in the shared components file",
    ]);
  });

  test("E001 syntax: an automation has only handlers", () => {
    expect(messagesOf(automation("  Card { }"))).toEqual([
      "E001 syntax: unexpected `Card` at 2:3, expected a handler; an automation has no state or nodes, only `on`, `every` and `at`",
    ]);
    expect(codesOf(automation("  state n = 1"))).toEqual(["E001"]);
  });

  test("E050 in an automation's words", () => {
    expect(
      messagesOf(
        automation("  on switch.porch changed { if screen == .Phone { call light.hall.turn_on } }"),
      ),
    ).toEqual(["E050 an automation runs on the server, where there is no `screen`"]);
    expect(messagesOf(automation("  on switch.porch changed { set n = 2 }"))).toEqual([
      "E050 an automation has no state to `set`; it runs on the server",
    ]);
    expect(
      messagesOf(
        automation(
          "  on switch.porch changed { if palette.lamp == palette.sky { call light.hall.turn_on } }",
        ),
      ),
    ).toEqual([
      "E050 an automation runs on the server, where there is no theme to read `palette` from",
      "E050 an automation runs on the server, where there is no theme value to read",
      "E050 an automation runs on the server, where there is no theme to read `palette` from",
      "E050 an automation runs on the server, where there is no theme value to read",
    ]);
    expect(
      messagesOf(
        automation(
          "  on switch.porch changed { if theme.palette.lamp == theme.palette.sky { call light.hall.turn_on } }",
        ),
      ),
    ).toEqual(
      Array(4).fill("E050 an automation runs on the server, where there is no theme value to read"),
    );
  });

  test("checks entities and commands as a page's handlers are checked", () => {
    expect(codesOf(automation("  on switch.nowhere changed { call light.hall.turn_on }"))).toEqual([
      "E010",
    ]);
    expect(codesOf(automation("  every 30s { call light.hall.turn_on }"))).toEqual(["E030"]);
    expect(codesOf(automation("  at 07:00 { call light.hall.turn_on { nope: 1 } }"))).toEqual([
      "E060",
    ]);
  });
});

describe("if statements", () => {
  const handler = (body: string) =>
    run(page(`  Card { }\n  on switch.porch changed {\n${body}\n  }`)).serverHandlers[0]?.body;

  test("`else if` is an `if` alone in the else branch", () => {
    expect(
      handler(
        "    if switch.porch.value == .On { call light.hall.turn_on } else if now.time > 18:00 { call light.hall.turn_off } else { call switch.porch.turn_off }",
      ),
    ).toEqual([
      [
        "if",
        ["bin", "==", ["get", ["entity", "switch.porch"], "value"], ["member", "On"]],
        [["call", "light.hall", "turn_on", {}]],
        [
          [
            "if",
            ["bin", ">", ["get", ["global", "now"], "time"], ["lit", 18 * 60]],
            [["call", "light.hall", "turn_off", {}]],
            [["call", "switch.porch", "turn_off", {}]],
          ],
        ],
      ],
    ]);
  });

  test("`else` may start the next line", () => {
    expect(
      handler(
        "    if switch.porch.value == .On {\n      call light.hall.turn_on\n    }\n    else {\n      call light.hall.turn_off\n    }",
      ),
    ).toEqual([
      [
        "if",
        ["bin", "==", ["get", ["entity", "switch.porch"], "value"], ["member", "On"]],
        [["call", "light.hall", "turn_on", {}]],
        [["call", "light.hall", "turn_off", {}]],
      ],
    ]);
  });
});

describe("headings", () => {
  test("every page carries the bundled headers, and an Area's is AreaHeader, given the area, name and icon", () => {
    const result = run(page('  Area { of: area.living  name: "Living"  icon: "lightbulb" }'));
    expect(result.ok).toBe(true);
    expect(Object.keys(result.page?.components ?? {}).sort()).toEqual([
      "AreaHeader",
      "CardHeader",
      "SectionHeader",
    ]);
    expect(result.page?.components.AreaHeader?.params.map((p) => p.name)).toEqual([
      "of",
      "name",
      "icon",
    ]);
    // The bundled headers' theme paths are covered, but are not the page's own.
    expect(result.themeRefs).toEqual([]);
  });

  test("a header names a component, compiled to its name", () => {
    const result = run(
      page(
        '  Stack {\n  Area { of: area.living  header: Plain }\n  Card { name: "A"  header: Plain2 }\n  Section { title: "S"  header: Plain3 }\n  }',
        "component Plain(of: Area) { Text { value: of.name } }\ncomponent Plain2(name: String) { Text { value: name } }\ncomponent Plain3(title: String) { Text { value: title } }",
      ),
    );
    expect(result.ok).toBe(true);
    const [room, card, section] = (result.page?.root.children ?? []) as {
      t: string;
      props: Record<string, unknown>;
    }[];
    expect(room?.t === "node" && room.props.header).toEqual({ e: ["lit", "Plain"] });
    expect(card?.t === "node" && card.props.header).toEqual({ e: ["lit", "Plain2"] });
    expect(section?.t === "node" && section.props.header).toEqual({ e: ["lit", "Plain3"] });
    // A Card's header may still be switched off.
    expect(codes(page('  Card { name: "A"  header: false }'))).toEqual([]);
  });

  test("a Card has a subtitle, drawn under the name by the bundled header; a custom one may ignore it", () => {
    expect(codes(page('  Card { name: "Oven"  subtitle: "Preheating · 180°" }'))).toEqual([]);
    expect(codes(page('  Card { name: "Oven"  subtitle: 180 }'))).toEqual(["E030"]);
    const result = run(page('  Card { name: "Oven" }'));
    expect(result.page?.components.CardHeader?.params.map((p) => p.name)).toEqual([
      "name",
      "subtitle",
      "icon",
      "active",
      "accent",
      "onAccent",
    ]);
    // A header that only takes the name still fits the slot.
    expect(
      codes(
        page(
          '  Card { name: "A"  subtitle: "b"  header: Plain }',
          "component Plain(name: String) { Text { value: name } }",
        ),
      ),
    ).toEqual([]);
  });

  test("a Card is of an entity, a device or an area, and of nothing else", () => {
    expect(codes(page("  Card { of: light.hall }"))).toEqual([]);
    expect(codes(page("  Card { of: device.dev_lamp }"))).toEqual([]);
    expect(codes(page("  Card { of: area.living }"))).toEqual([]);
    expect(codes(page('  Card { of: "light.hall" }'))).toEqual(["E030"]);
    expect(codes(page("  Card { of: device.nope }"))).toEqual(["E010"]);
  });

  test("an Icon takes a box and a Text its own size, weight and face, from the theme", () => {
    expect(
      codes(
        page(
          '  Stack { gap: 0\n  Icon { name: "lightbulb"  shape: room.icon.shape  size: room.icon.size  border: room.icon.border  background: room.icon.background  padding: room.icon.padding }\n  Text { value: "x"  size: room.name.size  weight: room.name.weight  font: room.name.font }\n  }',
        ),
      ),
    ).toEqual([]);
    expect(codes(page('  Icon { name: "lightbulb"  shape: palette.lamp }'))).toEqual(["E030"]);
    expect(codes(page('  Text { value: "x"  font: space.md }'))).toEqual(["E030"]);
  });

  test("a shared component is usable from a page, and one named AreaHeader replaces the bundled one", () => {
    const shared =
      "component Pill(label: String) { Text { value: label } }\ncomponent AreaHeader(of: Area) { Text { value: upper(of.name) } }";
    const result = run(
      page('  Stack {\n  Pill { label: "hi" }\n  Area { of: area.living  name: "Living" }\n  }'),
      {
        sharedSource: shared,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.page?.components.Pill).toBeDefined();
    expect(result.page?.components.AreaHeader?.root.type).toBe("Text");
    // The page's own component shadows a shared one; a shared file that does not parse is one problem.
    const own = run(
      page('  Pill { label: "hi" }', "component Pill(label: String) { Card { name: label } }"),
      {
        sharedSource: shared,
      },
    );
    expect(own.page?.components.Pill?.root.type).toBe("Card");
    expect(messages(page("  Card { }")).length).toBe(0);
    expect(
      run(page("  Card { }"), { sharedSource: "component {" }).diagnostics.map((d) => d.code),
    ).toEqual(["E001"]);
  });

  test("the shared file is checked on its own: components only, every body typed, themes covered", () => {
    const only = (source: string, extra: Partial<Parameters<typeof compile>[0]> = {}) =>
      compile({ source, registry: REGISTRY, componentsOnly: true, ...extra });
    expect(only("component A(x: String) { Text { value: x } }").ok).toBe(true);
    expect(only("page P { Card { } }").diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([
      "E001 the shared components file holds only `component` declarations, not a `page`",
    ]);
    expect(
      only("component A(x: String) { Text { value: y } }").diagnostics.map((d) => d.code),
    ).toEqual(["E005"]);
    expect(
      only("component Card(x: String) { Text { value: x } }").diagnostics.map((d) => d.code),
    ).toEqual(["E002"]);
    // Its theme references are reported as the file's, for the themes to be checked against.
    const refs = only("component A(x: String) { Text { value: x  color: palette.warn } }");
    expect(refs.diagnostics.map((d) => d.code)).toEqual(["E021", "E021", "E021"]);
    expect(
      only("component A(x: String) { Text { value: x  color: text.muted } }").themeRefs,
    ).toEqual(["text.muted"]);
  });

  test("an Area names no header unless told; its heading is drawn only when asked for", () => {
    const bare = run(page("  Area { of: area.living }"));
    expect(bare.diagnostics).toEqual([]);
    expect(bare.page?.root.props.header).toBeUndefined();
    const headed = run(
      page('  Area { of: area.living  name: area.living.name  icon: "lightbulb" }'),
    );
    expect(headed.diagnostics).toEqual([]);
    expect(headed.page?.root.props.header).toBeUndefined();
    expect(Object.keys(headed.page?.root.props ?? {})).toEqual(["of", "name", "icon"]);
    // A frame for what is in no area takes a name and an icon too.
    expect(codes(page('  Area { name: "Elsewhere"  icon: "lightbulb" }'))).toEqual([]);
    expect(codes(page('  Area { icon: "lightblub" }'))).toEqual(["E013"]);
  });

  describe("a RoomHeader, from before Room was Area", () => {
    const ROOM_HEADER = "component RoomHeader(of: Area) { Text { value: upper(of.name) } }";
    const W105 =
      "W105 `RoomHeader` is now `AreaHeader`; rename it, as it is only drawn for an `Area` given a `name` or an `icon`";
    const named = page('  Area { of: area.living  name: "Living" }');

    test("in the shared file still replaces the bundled AreaHeader, and the page is not told", () => {
      const result = run(named, { sharedSource: ROOM_HEADER });
      expect(result.diagnostics).toEqual([]);
      expect(result.page?.components.AreaHeader?.root.type).toBe("Text");
      expect(result.page?.components.RoomHeader?.root.type).toBe("Text");
    });

    test("in the shared file is a warning when that file is checked", () => {
      const result = compile({ source: ROOM_HEADER, registry: REGISTRY, componentsOnly: true });
      expect(result.ok).toBe(true);
      expect(result.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([W105]);
      expect(result.diagnostics[0]?.span.line).toBe(1);
    });

    test("in the page's own file replaces the bundled AreaHeader, with the warning", () => {
      const result = run(page('  Area { of: area.living  name: "Living" }', ROOM_HEADER));
      expect(result.ok).toBe(true);
      expect(result.diagnostics.map((d) => `${d.code} ${d.message}`)).toContain(W105);
      expect(result.page?.components.AreaHeader?.root.type).toBe("Text");
    });

    test("beside an AreaHeader in the same file is left alone: the AreaHeader draws, unwarned", () => {
      const both = `${ROOM_HEADER}\ncomponent AreaHeader(of: Area) { Card { } }`;
      const shared = run(named, { sharedSource: both });
      expect(shared.diagnostics).toEqual([]);
      expect(shared.page?.components.AreaHeader?.root.type).toBe("Card");
      const checked = compile({ source: both, registry: REGISTRY, componentsOnly: true });
      expect(checked.diagnostics).toEqual([]);
      const own = run(page('  Area { of: area.living  name: "Living" }', both));
      expect(own.diagnostics.map((d) => d.code)).not.toContain("W105");
      expect(own.page?.components.AreaHeader?.root.type).toBe("Card");
    });
  });
});

describe("the grammar", () => {
  test("two properties on one line need nothing between them; a newline ends one", () => {
    const source = page('  Card { name: "a"  size: .Sm\n    header: false; active: true }');
    expect(codes(source)).toEqual([]);
    const card = run(source).page?.root;
    expect(Object.keys(card?.props ?? {})).toEqual(["name", "size", "header", "active"]);
  });

  test("an expression runs on after an operator, not before one", () => {
    expect(codes(page("  Card { span: 1 +\n    2 }"))).toEqual([]);
    expect(codes(page("  Card { span: 1\n    + 2 }"))).toEqual(["E001"]);
    expect(codes(page('  Card { active: any(areas,\n    (a) => a.name == "x") }'))).toEqual([]);
  });

  test("every trigger and statement form parses", () => {
    const source = page(`  Card { }
  on switch.porch changed { call light.hall.turn_on }
  on switch.porch changed to .On from .Off { call light.hall.turn_on { brightness: 50% } }
  on sensor.outside#humidity changed { call light.hall.turn_on }
  every 5m { if cover.garage.value == .Open { call cover.garage.close } else { call cover.garage.open } }
  on every 1h { call light.hall.turn_off }
  at 07:30 { after 1h { call light.hall.turn_off } }`);
    expect(messages(source)).toEqual([]);
    const triggers = run(source).serverHandlers.map((h) => h.trigger.kind);
    expect(triggers).toEqual(["changed", "changed", "changed", "every", "every", "at"]);
  });

  test("every runs at most once a minute", () => {
    expect(codes(page("  Card { }\n  every 10s { call light.hall.turn_off }"))).toEqual(["E030"]);
  });

  test("one page per file, and a page is required for a page save", () => {
    expect(codes(`${page("  Card { }")}${page("  Card { }")}`)).toEqual(["E001"]);
    expect(codes("component A() { Card { } }")).toEqual(["E001"]);
    expect(compile({ source: "theme Dusk extends Night { }", registry: REGISTRY }).ok).toBe(true);
  });

  test("reserved words cannot be bound", () => {
    expect(codes(page("  Stack { for screen in areas { Area { of: screen } } }"))).toEqual([
      "E001",
    ]);
    expect(codes(page("  state when = 1\n  Card { }"))).toEqual(["E001"]);
  });

  test("comments, durations, percentages and times lex", () => {
    const source = page(
      "  /* a\n  block */ Card { span: 60% // trailing\n    onPress: () => call light.hall.turn_on { transitionMs: 1.5s } }",
    );
    expect(codes(source)).toEqual([]);
    const card = run(source).page?.root;
    expect(card?.props.span).toEqual({ e: ["lit", 0.6] });
    expect(card?.props.onPress).toEqual({
      h: { params: [], body: [["call", "light.hall", "turn_on", { transitionMs: ["lit", 1500] }]] },
    });
  });

  test("a bad character, number or string is one diagnostic each", () => {
    expect(codes(page("  Card { span: 3x }"))).toEqual(["E001"]);
    expect(codes(page('  Card { name: "open'))).toEqual(["E001", "E001"]);
    expect(codes(page("  Card { span: 1 @ 2 }"))).toEqual(["E001", "E001"]);
  });
});

describe("expressions", () => {
  const props = (body: string) => run(page(body)).page?.root.props ?? {};

  test("a theme path compiles to its name and is recorded once", () => {
    const result = run(
      page('  Card { accent: theme.palette.lamp  Text { value: "x"  color: palette.lamp } }'),
    );
    expect(result.themeRefs).toEqual(["palette.lamp"]);
    expect(result.page?.root.props.accent).toEqual({ e: ["theme", "palette.lamp"] });
  });

  test("a token property only takes its own group", () => {
    expect(codes(page("  Stack { gap: space.lg }"))).toEqual([]);
    expect(codes(page("  Stack { gap: palette.lamp }"))).toEqual(["E030"]);
    expect(codes(page("  Card { accent: space.lg }"))).toEqual(["E030"]);
  });

  test("entity fields are typed per domain", () => {
    expect(
      codes(page("  Card { when: sensor.outside.value > 20 && lock.front.value == .Unlocked }")),
    ).toEqual([]);
    expect(codes(page("  Card { when: climate.living.value == .Heat }"))).toEqual([]);
    expect(codes(page("  Card { when: lock.front.value > 1 }"))).toEqual(["E030"]);
    expect(
      codes(
        page(
          '  Text { value: sensor.outside.name + ": " + format(sensor.outside.value, 1) + unit(sensor.outside) } ',
        ),
      ),
    ).toEqual([]);
    expect(codes(page("  Text { value: sensor.outside.nmae }"))).toEqual(["E003"]);
  });

  test("attributes and attr records are open", () => {
    expect(
      codes(
        page(
          "  Card { when: sensor.outside#humidity.value > 50 && light.hall.attr.brightness > 0.5 }",
        ),
      ),
    ).toEqual([]);
    expect(props("  Card { when: sensor.outside#humidity.value > 50 }").when).toEqual({
      e: ["bin", ">", ["get", ["attr", "sensor.outside", "humidity"], "value"], ["lit", 50]],
    });
  });

  test("functions check their arguments and lambdas", () => {
    expect(codes(page("  Card { span: round(sensor.outside.value, 1) + count(areas) }"))).toEqual(
      [],
    );
    expect(codes(page('  Card { span: round("a") }'))).toEqual(["E030"]);
    expect(codes(page("  Card { span: round() }"))).toEqual(["E030"]);
    expect(codes(page('  Card { active: any(areas, (a) => a.name == "Hall") }'))).toEqual([]);
    expect(codes(page("  Card { active: any(areas, 1) }"))).toEqual(["E030"]);
    expect(codes(page("  Card { name: first(sort(areas, (a) => a.name)).name }"))).toEqual([]);
    expect(
      codes(page('  Card { name: first(filter(areas, (a) => a.name != "Hall")).name }')),
    ).toEqual([]);
    expect(codes(page("  Card { span: count(filter(areas, (a) => a.name)) }"))).toEqual(["E030"]);
    expect(codes(page("  Card { span: rond(1) }"))).toEqual(["E005"]);
  });

  test("?? and ?: agree on a type", () => {
    expect(codes(page("  Card { span: sensor.outside.value ?? 0 }"))).toEqual([]);
    expect(codes(page("  Card { span: screen == .Phone ? 1 : 2 }"))).toEqual([]);
    expect(codes(page('  Card { span: screen == .Phone ? 1 : "2" }'))).toEqual(["E030"]);
  });

  test("a for variable takes the list's element type", () => {
    expect(codes(page("  Stack { for a in areas { Area { of: a } } }"))).toEqual([]);
    expect(codes(page("  Stack { for a in areas { Area { of: a.name } } }"))).toEqual(["E030"]);
    expect(codes(page("  Stack { for a in sensor.outside { Area { of: a } } }"))).toEqual(["E030"]);
    expect(codes(page("  Stack { for a in areas where a.name { Area { of: a } } }"))).toEqual([
      "E030",
    ]);
  });

  test("a component's parameters are reactive bindings with defaults", () => {
    const head =
      "component Temp(of: Entity, hot: Number = 25) { Card { accent: of.value > hot ? palette.ink : palette.sky } }";
    expect(codes(page("  Temp { of: sensor.outside }", head))).toEqual([]);
    expect(codes(page('  Temp { of: sensor.outside  hot: "x" }', head))).toEqual(["E030"]);
    expect(codes(page("  Temp { of: sensor.outside  cold: 1 }", head))).toEqual(["E003"]);
  });

  test("a component does not see the caller's variables", () => {
    const head = "component A() { Card { name: a.name } }";
    expect(codes(page("  Stack { for a in areas { A { } } }", head))).toEqual(["E005"]);
  });

  test("Segmented binds T from value", () => {
    expect(
      codes(
        page(
          "  state r: Enum<Hour | Day> = .Day\n  Segmented { options: [.Hour, .Day]  value: r  onChange: (v) => set r = v }",
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        page(
          "  state r: Enum<Hour | Day> = .Day\n  Segmented { options: [.Hour, .Week]  value: r }",
        ),
      ),
    ).toEqual(["E030"]);
  });

  test("an event takes a lambda and nothing else", () => {
    expect(codes(page("  Card { onPress: 1 }"))).toEqual(["E030"]);
    expect(codes(page("  Card { name: () => call light.hall.turn_on }"))).toEqual(["E030"]);
    expect(
      codes(page("  Toggle { of: switch.porch  onToggle: (a, b) => call light.hall.turn_on }")),
    ).toEqual(["E030"]);
  });
});

describe("a sensor", () => {
  const sensor = (body: string, name = "KitchenDoor") => `sensor ${name} {\n${body}\n}\n`;
  const compiled = (source: string) => compile({ source, registry: REGISTRY, sensorOnly: true });
  const messagesOf = (source: string) =>
    compiled(source).diagnostics.map((d) => `${d.code} ${d.message}`);
  const DOOR = `  input door = binary_sensor.hall_motion
  input bolt = lock.front
  name: "Hall door"
  type: String
  value: door.value == .On ? "Open" : bolt.value == .Unlocked ? "Unlocked" : "Secured"`;

  test("compiles its inputs and its value over them, with its name, type and entities", () => {
    const result = compiled(sensor(DOOR));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.page).toBeUndefined();
    expect(result.entities).toEqual(["binary_sensor.hall_motion", "lock.front"]);
    expect(result.sensor).toEqual({
      name: "Hall door",
      type: "String",
      inputs: [
        { name: "door", value: ["entity", "binary_sensor.hall_motion"] },
        { name: "bolt", value: ["entity", "lock.front"] },
      ],
      value: [
        "if",
        ["bin", "==", ["get", ["var", "door"], "value"], ["member", "On"]],
        ["lit", "Open"],
        [
          "if",
          ["bin", "==", ["get", ["var", "bolt"], "value"], ["member", "Unlocked"]],
          ["lit", "Unlocked"],
          ["lit", "Secured"],
        ],
      ],
      line: 6,
    });
  });

  test("a Number takes a unit and a class, a list input feeds avg, and a Bool takes a binary class", () => {
    const temp = compiled(
      sensor(
        '  input rooms = [sensor.living_temp, sensor.outside]\n  name: "House"\n  type: Number  unit: "°C"  class: .Temperature\n  value: avg(rooms, (s) => s.value)',
        "HouseTemp",
      ),
    );
    expect(temp.diagnostics).toEqual([]);
    expect(temp.sensor).toMatchObject({
      type: "Number",
      unit: "°C",
      class: "temperature",
      value: ["call", "avg", ["var", "rooms"], ["fn", ["s"], ["get", ["var", "s"], "value"]]],
    });
    const secure = compiled(
      sensor(
        '  input door = binary_sensor.hall_motion\n  input bolt = lock.front\n  name: "Secure"\n  type: Bool  class: .Door\n  value: door.value == .Off && bolt.value == .Locked',
      ),
    );
    expect(secure.diagnostics).toEqual([]);
    expect(secure.sensor).toMatchObject({ type: "Bool", class: "door" });
    expect(secure.sensor?.unit).toBeUndefined();
  });

  test("E070 the value reads only its inputs: no entity, no house, no clock", () => {
    expect(
      messagesOf(
        sensor(
          '  input door = binary_sensor.hall_motion\n  name: "x"\n  type: Bool\n  value: binary_sensor.hall_motion.value == .On || count(entities) > 1 || ago(now) == ""',
        ),
      ),
    ).toEqual([
      "E070 a sensor's value reads only its inputs; declare `binary_sensor.hall_motion` as one: `input hall_motion = binary_sensor.hall_motion`",
      "E070 a sensor's value reads only its inputs; `entities` is the house; give it the entities as inputs",
      "E070 a sensor's value reads only its inputs; `ago` reads the clock, and a sensor is computed when an input changes, not as time passes",
      "E070 a sensor's value reads only its inputs; it is computed when an input changes, not as time passes, so `now` would go stale",
    ]);
  });

  test("the value is checked against the type, and unit and class against it too", () => {
    expect(
      messagesOf(
        sensor(
          '  input door = binary_sensor.hall_motion\n  name: "x"\n  type: Number\n  value: door.value == .On ? "Open" : "Closed"',
        ),
      ),
    ).toEqual([
      // Each branch of the ternary is held to the type.
      "E030 type mismatch: this expects Number, got String",
      "E030 type mismatch: this expects Number, got String",
    ]);
    expect(
      messagesOf(
        sensor(
          '  input door = binary_sensor.hall_motion\n  name: "x"\n  type: String  unit: "°C"  class: .Door\n  value: "x"',
        ),
      ),
    ).toEqual([
      "E030 a String sensor has no `unit`; only a Number does",
      "E030 a String sensor has no `class`; a Number or a Bool does",
    ]);
    expect(
      messagesOf(
        sensor(
          '  input door = binary_sensor.hall_motion\n  name: "x"\n  type: Bool  class: .Temperature\n  value: true',
        ),
      ),
    ).toEqual([
      "E030 a Bool sensor's `class` is one of .Motion .Occupancy .Door .Window .Leak .Smoke",
    ]);
    expect(
      messagesOf(
        sensor(
          '  input door = binary_sensor.hall_motion\n  name: "x"\n  type: Colour\n  value: true',
        ),
      ),
    ).toEqual(["E030 a sensor's `type` is String, Number or Bool"]);
  });

  test("E003, E004, E030 and E033 on the declaration itself", () => {
    expect(
      messagesOf(
        sensor(
          '  input door = binary_sensor.hall_motion\n  input door = lock.front\n  input n = 3\n  name: "a" + "b"\n  type: String\n  value: "x"\n  extra: 1',
        ),
      ),
    ).toEqual([
      "E004 input `door` is declared twice",
      "E030 an input is an entity or a list of entities, got Number",
      'E030 a sensor\'s name is written as a string, such as "Kitchen door"',
      "E003 property `extra` is not defined on a sensor; its properties are name, type, value, unit, class",
    ]);
    expect(messagesOf(sensor("  input door = binary_sensor.hall_motion"))).toEqual([
      "E033 required property `name` missing on sensor `KitchenDoor`",
      "E033 required property `type` missing on sensor `KitchenDoor`",
      "E033 required property `value` missing on sensor `KitchenDoor`",
    ]);
    expect(
      messagesOf(
        sensor(
          '  input door = binary_sensor.hall_motion\n  name: "x"\n  type: String\n  value: "a"\n  value: "b"',
        ),
      ),
    ).toEqual(["E004 property `value` given twice on this sensor"]);
  });

  test("E001 is one sensor and nothing else, and a sensor belongs in no page", () => {
    expect(messagesOf("")).toEqual(["E001 the file declares no `sensor`"]);
    expect(messagesOf(`${sensor(DOOR)}sensor Other { }`)).toEqual([
      "E001 one `sensor` per file; a second sensor is a second file",
    ]);
    expect(messagesOf(`${sensor(DOOR)}automation HallLight { }`)).toEqual([
      "E001 a sensor file holds one `sensor` declaration, not a `automation`",
    ]);
    expect(messages(`${page("  Card { }")}sensor Door { }`)).toEqual([
      "E001 a sensor is saved from the Automations page, not in a page",
    ]);
    expect(
      compile({
        source: `${sensor(DOOR)}`,
        registry: REGISTRY,
        automationOnly: true,
      }).diagnostics.map((d) => d.message),
    ).toEqual([
      "an automation file holds one `automation` declaration, not a `sensor`",
      "the file declares no `automation`",
    ]);
  });

  test("the parser names what a sensor holds", () => {
    expect(messagesOf("sensor Door {\n  on light.hall changed { }\n}")).toEqual([
      "E001 syntax: unexpected `on` at 2:3, expected an `input` or a property; a sensor has no handlers, state or nodes",
    ]);
    expect(messagesOf("sensor Door {\n  input lock = lock.front\n}")).toEqual([
      "E001 syntax: `lock` is a reserved word; an input needs another name",
    ]);
  });
});

describe("run", () => {
  const LED = {
    type: "object",
    properties: {
      deviceId: { type: "string" },
      effect: { type: "string", enum: ["pulse", "solid"] },
      color: { type: "integer" },
    },
    required: ["deviceId"],
    additionalProperties: false,
  };
  const WITH_INTEGRATIONS: Registry = {
    ...REGISTRY,
    integrations: [
      {
        id: "zwave-js.main",
        actions: [
          { name: "led_notify", schema: LED },
          {
            name: "ping",
            schema: {
              type: "object",
              properties: { n: { type: "number" } },
              additionalProperties: true,
            },
          },
          // As zod writes a plain z.object's input: no `additionalProperties`, so closed.
          { name: "blink", schema: { type: "object", properties: { n: { type: "number" } } } },
          // No properties at all: nothing is known, so anything goes.
          { name: "raw", schema: {} },
        ],
      },
      { id: "hue.2", actions: [] },
      // Configured but not running: what it offers is not known.
      { id: "mqtt.main" },
    ],
  };
  const automation = (body: string) =>
    `automation Porch {\n  on switch.porch changed {\n    ${body}\n  }\n}\n`;
  const compiled = (source: string, registry: Registry = WITH_INTEGRATIONS) =>
    compile({ source, registry, automationOnly: true });
  const messagesOf = (source: string, registry?: Registry) =>
    compiled(source, registry).diagnostics.map((d) => `${d.code} ${d.message}`);
  const bodyOf = (source: string, registry?: Registry) =>
    compiled(source, registry).serverHandlers[0]?.body;

  test("compiles to the instance's own id, the action and its arguments", () => {
    const source = automation(
      'run zwave_js.main.led_notify { deviceId: device.dev_porch, effect: "pulse", color: 0 }',
    );
    expect(messagesOf(source)).toEqual([]);
    expect(bodyOf(source)).toEqual([
      [
        "run",
        "zwave-js.main",
        "led_notify",
        {
          deviceId: ["lookup", "device", "dev_porch"],
          effect: ["lit", "pulse"],
          color: ["lit", 0],
        },
      ],
    ]);
  });

  test("an action with no braces has no arguments", () => {
    expect(bodyOf(automation("run zwave_js.main.ping"))).toEqual([
      ["run", "zwave-js.main", "ping", {}],
    ]);
  });

  test("args may span lines, with or without commas", () => {
    const source = automation(
      'run zwave_js.main.led_notify {\n      deviceId: "x"\n      color: 3,\n    }',
    );
    expect(messagesOf(source)).toEqual([]);
    expect(bodyOf(source)).toEqual([
      ["run", "zwave-js.main", "led_notify", { deviceId: ["lit", "x"], color: ["lit", 3] }],
    ]);
  });

  test("an instance named by a number parses", () => {
    expect(messagesOf(automation("run hue.2.go"))).toEqual(["E060 hue.2 has no actions"]);
  });

  test("runs among other statements, inside `if` and `after`", () => {
    const source = automation(
      'if switch.porch.value == .On { run zwave_js.main.ping } else { after 5m { run zwave_js.main.led_notify { deviceId: "x" } } }\n    call light.hall.turn_on',
    );
    expect(messagesOf(source)).toEqual([]);
    expect(bodyOf(source)).toEqual([
      [
        "if",
        ["bin", "==", ["get", ["entity", "switch.porch"], "value"], ["member", "On"]],
        [["run", "zwave-js.main", "ping", {}]],
        [["after", 300_000, [["run", "zwave-js.main", "led_notify", { deviceId: ["lit", "x"] }]]]],
      ],
      ["call", "light.hall", "turn_on", {}],
    ]);
  });

  test("runs in a page's `on` handler", () => {
    const result = compile({
      source: page("  Card { }\n  on switch.porch changed { run zwave_js.main.ping }"),
      registry: WITH_INTEGRATIONS,
      requirePage: true,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.serverHandlers[0]?.body).toEqual([["run", "zwave-js.main", "ping", {}]]);
  });

  test("E050 in a browser handler, including a lambda's single statement", () => {
    const source = page("  Card { onPress: () => run zwave_js.main.ping }");
    expect(
      compile({ source, registry: WITH_INTEGRATIONS, requirePage: true }).diagnostics.map(
        (d) => `${d.code} ${d.message}`,
      ),
    ).toEqual([
      "E050 `run` reaches an integration, which only an automation or an `on` handler can do",
    ]);
    const block = page("  Card { onPress: () => { run zwave_js.main.ping } }");
    expect(
      compile({ source: block, registry: WITH_INTEGRATIONS, requirePage: true }).diagnostics.map(
        (d) => d.code,
      ),
    ).toEqual(["E050"]);
  });

  test("E010 an unknown integration, with a did-you-mean, on the integration's span", () => {
    const source = automation('run zwave_js.mian.led_notify { deviceId: "x" }');
    const [d] = compiled(source).diagnostics;
    expect(`${d?.code} ${d?.message}`).toBe(
      "E010 unknown integration `zwave_js.mian`; did you mean `zwave_js.main`",
    );
    expect(source.slice(d?.span.start, d?.span.end)).toBe("zwave_js.mian");
    expect(messagesOf(automation("run nothing.here.go"))).toEqual([
      "E010 unknown integration `nothing.here`",
    ]);
  });

  test("the instance may be written with its own `-`", () => {
    // The lexer reads `zwave-js` as a subtraction, so `_` is how it's written; but an id with
    // `_` in its type resolves too.
    const registry: Registry = { ...REGISTRY, integrations: [{ id: "my_thing.a" }] };
    expect(bodyOf(automation("run my_thing.a.go"), registry)).toEqual([
      ["run", "my_thing.a", "go", {}],
    ]);
  });

  test("E060 an unknown action names the ones there are", () => {
    expect(messagesOf(automation('run zwave_js.main.led_notfy { deviceId: "x" }'))).toEqual([
      "E060 zwave_js.main has no action `led_notfy`; it has led_notify, ping, blink, raw",
    ]);
  });

  test("E060 an argument a closed schema doesn't take names the ones it does", () => {
    expect(
      messagesOf(automation('run zwave_js.main.led_notify { deviceId: "x", nope: 1 }')),
    ).toEqual(["E060 `led_notify` takes no `nope`; it takes deviceId, effect, color"]);
  });

  test("a schema that allows other names takes any other argument", () => {
    expect(messagesOf(automation("run zwave_js.main.ping { n: 1, extra: true }"))).toEqual([]);
  });

  test("E060 a schema that says nothing of other names takes only its own", () => {
    expect(messagesOf(automation("run zwave_js.main.blink { n: 1, extra: true }"))).toEqual([
      "E060 `blink` takes no `extra`; it takes n",
    ]);
  });

  test("a schema with no properties takes anything", () => {
    expect(messagesOf(automation("run zwave_js.main.raw { a: 1, b: device.dev_porch }"))).toEqual(
      [],
    );
  });

  test("E060 a missing required argument", () => {
    expect(messagesOf(automation("run zwave_js.main.led_notify { color: 1 }"))).toEqual([
      "E060 `led_notify` needs `deviceId`",
    ]);
  });

  test("E030 an argument of the wrong type", () => {
    expect(
      compiled(automation("run zwave_js.main.led_notify { deviceId: true }")).diagnostics.map(
        (d) => d.code,
      ),
    ).toEqual(["E030"]);
    expect(
      compiled(
        automation('run zwave_js.main.led_notify { deviceId: "x", color: "red" }'),
      ).diagnostics.map((d) => d.code),
    ).toEqual(["E030"]);
  });

  test("a device, area or entity goes where a string does", () => {
    for (const value of ["device.dev_porch", "area.hall", "light.hall"]) {
      expect(messagesOf(automation(`run zwave_js.main.led_notify { deviceId: ${value} }`))).toEqual(
        [],
      );
    }
  });

  test("an instance that isn't running resolves, but its action and args go unchecked", () => {
    const source = automation("run mqtt.main.anything { a: 1, b: device.dev_porch }");
    expect(messagesOf(source)).toEqual([]);
    expect(bodyOf(source)).toEqual([
      ["run", "mqtt.main", "anything", { a: ["lit", 1], b: ["lookup", "device", "dev_porch"] }],
    ]);
  });

  test("with no integrations in the registry, nothing is checked and the name is kept", () => {
    const source = automation("run zwave_js.main.whatever { x: 1 }");
    expect(messagesOf(source, REGISTRY)).toEqual([]);
    expect(bodyOf(source, REGISTRY)).toEqual([
      ["run", "zwave_js.main", "whatever", { x: ["lit", 1] }],
    ]);
  });

  describe("`run` is a word only where a statement starts", () => {
    test("a state named `run` is still a state", () => {
      const result = run(page("  state run = 1\n  Card { span: run }"));
      expect(result.diagnostics).toEqual([]);
      expect(result.page?.root.props.span).toEqual({ e: ["var", "run"] });
    });

    test("`set run` sets it", () => {
      expect(codes(page("  state run = 1\n  Card { onPress: () => set run = run + 1 }"))).toEqual(
        [],
      );
    });

    test("a lambda body of just `run` is an expression", () => {
      expect(codes(page("  state run = true\n  Card { active: any([1], (x) => run) }"))).toEqual(
        [],
      );
    });

    test("a parameter named `run` is still a parameter", () => {
      const result = run(
        `component C(run: Number) { Card { span: run } }\n${page("  C { run: 2 }")}`,
      );
      expect(result.diagnostics).toEqual([]);
      expect(result.page?.root.props).toEqual({ run: { e: ["lit", 2] } });
    });
  });

  test("a statement that isn't one names `run` among those there are", () => {
    expect(messagesOf(automation("light.hall"))[0]).toContain(
      "expected a statement (`call`, `run`, `set`, `if`, `after`)",
    );
  });

  test("`run` with no integration's name after the type is a syntax error", () => {
    expect(compiled(automation("run zwave_js..go")).diagnostics.map((d) => d.code)).toEqual([
      "E001",
    ]);
    expect(messagesOf(automation('run zwave_js."main".go'))[0]).toContain(
      "expected an integration's name",
    );
  });
});

describe("runName", () => {
  test("writes an instance id's `-` as `_`, every one of them", () => {
    expect(runName("zwave-js.main")).toBe("zwave_js.main");
    expect(runName("a-b-c.x-y")).toBe("a_b_c.x_y");
    expect(runName("hue.2")).toBe("hue.2");
  });
});

describe("actionParams", () => {
  /** Each parameter's type as the checker shows it. */
  const typesOf = (properties: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(actionParams({ type: "object", properties }).params).map(([k, t]) => [
        k,
        show(t),
      ]),
    );
  const STRINGISH = show(actionParams({ properties: { s: { type: "string" } } }).params.s as never);

  test("no schema, or one without properties, takes anything", () => {
    for (const schema of [undefined, null, {}, "x", [], { type: "object" }, { properties: [] }]) {
      expect(actionParams(schema)).toEqual({ params: {}, open: true, required: [] });
    }
  });

  test("required names come through; anything that isn't a string in the list is ignored", () => {
    expect(
      actionParams({ properties: { a: {}, b: {} }, required: ["a", 3, null, "b"] }).required,
    ).toEqual(["a", "b"]);
    expect(actionParams({ properties: { a: {} }, required: "a" }).required).toEqual([]);
  });

  test("only an explicit allowance opens it: `true` or a schema for the others", () => {
    expect(actionParams({ properties: {}, additionalProperties: true }).open).toBe(true);
    expect(actionParams({ properties: {}, additionalProperties: {} }).open).toBe(true);
    expect(actionParams({ properties: {}, additionalProperties: { type: "string" } }).open).toBe(
      true,
    );
  });

  test("absent, false or anything else, it is closed, since zod drops names it doesn't list", () => {
    expect(actionParams({ properties: {} }).open).toBe(false);
    expect(actionParams({ properties: {}, additionalProperties: false }).open).toBe(false);
    expect(actionParams({ properties: {}, additionalProperties: "yes" }).open).toBe(false);
    expect(actionParams({ properties: {}, additionalProperties: [] }).open).toBe(false);
  });

  test("integer and number are Number; boolean is Bool", () => {
    expect(
      typesOf({ i: { type: "integer" }, n: { type: "number" }, b: { type: "boolean" } }),
    ).toEqual({ i: "Number", n: "Number", b: "Bool" });
  });

  test("a string also takes a device, area or entity, sent as its id", () => {
    const { params } = actionParams({ properties: { s: { type: "string" } } });
    expect(params.s).toEqual({
      kind: "union",
      of: [{ kind: "string" }, { kind: "device" }, { kind: "area" }, { kind: "entity" }],
    });
  });

  test("an array is a list of its items; one with no items is a list of anything", () => {
    const { params } = actionParams({
      properties: { ns: { type: "array", items: { type: "integer" } }, xs: { type: "array" } },
    });
    expect(params.ns).toEqual({ kind: "list", of: { kind: "number" } });
    expect(params.xs).toEqual({ kind: "list", of: { kind: "any" } });
  });

  test("a type array is a union, and one with null is nullable", () => {
    const { params } = actionParams({
      properties: { a: { type: ["integer", "boolean"] }, b: { type: ["integer", "null"] } },
    });
    expect(params.a).toEqual({ kind: "union", of: [{ kind: "number" }, { kind: "bool" }] });
    expect(params.b).toEqual({ kind: "union", of: [{ kind: "number" }, { kind: "null" }] });
  });

  test("anyOf and oneOf are unions of their alternatives; one open alternative opens it", () => {
    const { params } = actionParams({
      properties: {
        a: { anyOf: [{ type: "integer" }, { type: "boolean" }] },
        o: { oneOf: [{ type: "integer" }] },
        open: { anyOf: [{ type: "integer" }, {}] },
        none: { anyOf: [] },
      },
    });
    expect(params.a).toEqual({ kind: "union", of: [{ kind: "number" }, { kind: "bool" }] });
    expect(params.o).toEqual({ kind: "number" });
    expect(params.open).toEqual({ kind: "any" });
    expect(params.none).toEqual({ kind: "any" });
  });

  test("an enum is typed by its values, whatever `type` says", () => {
    const { params } = actionParams({
      properties: {
        s: { type: "string", enum: ["pulse", "solid"] },
        mixed: { enum: [1, true, null] },
      },
    });
    expect(show(params.s as never)).toBe(STRINGISH);
    expect(params.mixed).toEqual({
      kind: "union",
      of: [{ kind: "number" }, { kind: "bool" }, { kind: "null" }],
    });
  });

  test("what doesn't map is anything, checked when it runs", () => {
    const { params } = actionParams({
      properties: { o: { type: "object" }, u: {}, x: "nonsense", t: { type: "weird" } },
    });
    for (const name of ["o", "u", "x", "t"]) expect(params[name]).toEqual({ kind: "any" });
  });
});

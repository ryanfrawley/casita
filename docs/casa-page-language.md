<!-- Exported 2026-11-02 from the Claude Doc "Casa Page Language — Spec v1". Section 20, "As
     built", lists where the implementation departs from the sections above it; the code is the
     reference. One embedded diagram did not survive the export (marked "embedded content"). -->

# Casa Page Language — Spec v1

Oct 7, 2026 · Ryan Frawley · Draft

## 1. Purpose and scope

Casa is the language a Casita admin writes a page in. One text file describes a page's layout, the components it is built from, the theme that skins it, the expressions that bind entity state to what is shown, and the handlers that run when the house changes. The web app renders that file live; the server runs its handlers.

Casa replaces the stored card configuration (`CardConfig`, `CardReading`, `AreaDisplay`, the `cards` table, `devices.card`) and the form-based Add-card and arrange UI. After the migration in section 16 the Home page is an ordinary Casa page stored in a `pages` table.

v1 has one page, `home`. The `pages` table is generic, so further pages and navigation between them are a later addition rather than a redesign; nothing in v1 assumes a single page except the router.

Casa is not a general programming language. It has no loops in handlers, no user-defined functions beyond components, no string templating, no raw CSS, no literal colours outside a theme, and no network access. Anything that needs those stays a TypeScript automation in `automations/*.ts` or a change to `packages/ui`.

The decisions behind this spec, taken 2026-10-07: UI expressions evaluate in the browser and entity-triggered handlers run on the server from the same file; the language is a purpose-built declarative tree with a small expression language rather than sandboxed JavaScript or YAML with templates; users define their own components; pages are admin-authored, stored in SQLite and edited in-app with a live preview; themes are written in Casa; breakpoints are a reactive `screen` value; components may only use named theme values; existing readings migrate to Casa and the arrange UI is removed.

## 2. Guarantees

The compiler enforces five properties. A page that violates one does not save.

1. **Theme-complete.** Every colour, border, shadow, radius, spacing and font a page uses is a named theme value, and every installed theme defines (or inherits) every name any page references. Switching themes can never leave a stranded literal.
2. **Runtime-partitioned.** A handler triggered by entity state, a schedule or a clock runs on the server and may reference only entity state and literals. A handler triggered by a UI event runs in the browser. The compiler decides, and rejects a server handler that reads `screen`, local state or theme values.
3. **Side-effect-free expressions.** An expression can read and compute but never command an entity, set state or wait. Only handler statements do those.
4. **Reactive by construction.** Every property value is re-evaluated when any value it read changes, with no explicit subscriptions in the page. Dependency sets are recorded during evaluation.
5. **Nothing before the device reports.** An entity whose state is unavailable or not yet received evaluates to an `Unavailable` value; every built-in renders its placeholder for it, and expressions over it propagate it rather than throw.

## 3. Lexical structure

Source is UTF-8. Whitespace and newlines separate tokens and carry no meaning except that a newline or `;` ends a property or statement; `;` is never required. Comments are `//` to end of line and `/* … */`.

| Token | Form | Examples |
| --- | --- | --- |
| Identifier | `[a-z_][a-zA-Z0-9_]*` | `range`, `of`, `living_temp` |
| Type name | `[A-Z][a-zA-Z0-9]*` | `Card`, `History`, `Temp` |
| Entity ref | `<domain>.<object_id>` where domain is one of `light sensor binary_sensor switch climate cover lock button weather` | `sensor.living_temp`, `light.hall` |
| Attribute ref | entity ref followed by `#` and an identifier | `sensor.outside#humidity` |
| Number | decimal integer or float, optional unit suffix `%` | `3`, `21.5`, `60%` |
| Duration | number followed by `ms s m h d` | `10m`, `1.5h` |
| Time of day | `HH:MM` | `07:00` |
| String | double-quoted, escapes `\" \\ \n` | `"Porch"` |
| Colour | `#rgb`, `#rrggbb`, `#rrggbbaa`, only inside `theme` | `#f2b05e` |
| Boolean | `true` `false` |  |
| Null | `null` |  |
| Punctuation | `{ } ( ) [ ] : , . # ? => = == != < <= > >= + - * / % ! && \|\| ??` |  |

Reserved words: `theme extends palette surface text space font breakpoints component state page for in where when on changed to every at call set if else after true false null screen`, plus the nine domain names. They cannot name a parameter, local state or component.

A type name that is not a built-in or a `component` in the same file is an error. There are no imports in v1; a page is one file.

## 4. Grammar

A file is a sequence of declarations. Exactly one `page` per file in v1. EBNF, with `{x}` meaning zero or more and `[x]` optional:

```ebnf
file        = { theme | component | page } ;

theme       = "theme" TypeName [ "extends" TypeName ] "{" { themeGroup } "}" ;
themeGroup  = groupPath "{" { ident ":" themeValue } "}" ;
groupPath   = ident { "." ident } ;
themeValue  = Colour | Number | String | themeRef ;
themeRef    = ident { "." ident } ;

component   = "component" TypeName "(" [ param { "," param } ] ")" "{" { stateDecl } node "}" ;
param       = ident ":" typeName [ "=" expr ] ;
stateDecl   = "state" ident [ ":" typeName ] "=" expr ;

page        = "page" TypeName "{" { stateDecl } node { handler } "}" ;

node        = TypeName "{" { property | child } "}" ;
property    = ident ":" ( expr | lambda ) ;
lambda      = "(" [ ident { "," ident } ] ")" "=>" ( statement | "{" { statement } "}" ) ;
child       = node | repeat | "children" ;
repeat      = "for" ident "in" expr [ "where" expr ] "{" { child } "}" ;

handler     = "on" trigger "{" { statement } "}" ;
trigger     = entityRef [ "#" ident ] "changed" [ "to" expr ] [ "from" expr ]
            | "every" Duration
            | "at" TimeOfDay ;

statement   = "call" entityRef "." ident [ "{" { ident ":" expr } "}" ]
            | "set" ident "=" expr
            | "if" expr "{" { statement } "}" [ "else" "{" { statement } "}" ]
            | "after" Duration "{" { statement } "}" ;

expr        = ternary ;
ternary     = nullish [ "?" expr ":" expr ] ;
nullish     = or { "??" or } ;
or          = and { "||" and } ;
and         = equality { "&&" equality } ;
equality    = relational { ( "==" | "!=" ) relational } ;
relational  = additive { ( "<" | "<=" | ">" | ">=" ) additive } ;
additive    = multiplicative { ( "+" | "-" ) multiplicative } ;
multiplicative = unary { ( "*" | "/" | "%" ) unary } ;
unary       = ( "!" | "-" ) unary | postfix ;
postfix     = primary { "." ident | "[" expr "]" | "(" [ expr { "," expr } ] ")" } ;
primary     = literal | ident | entityRef | "." TypeName | "[" [ expr { "," expr } ] "]" | "(" expr ")" ;
literal     = Number | Duration | String | Boolean | "null" ;
```

Notes on the grammar:

- A property name may repeat only for `when`-less siblings; the same property twice on one node is an error.
- `children` as a child is legal only inside a `component` body and at most once; it marks where a caller's children render.
- `for` binds its variable for its block; `where` filters. Nested `for` is allowed.
- A `lambda` is only legal as the value of a property whose declared type is an event (`onChange`, `onPress`, `onToggle`). Its statements are browser statements (section 12).
- `"." TypeName` in `primary` is an enum member such as `.Lg`, resolved against the expected type (section 7). A bare `TypeName` is never an expression, so it only ever names a component, built-in or theme.
- Operator precedence is as listed, lowest first. `==` and `!=` compare by value; strings, numbers, booleans, durations and entity refs are comparable, nodes and lists are not.

## 5. Types and values

Casa is statically typed with inference; a type is only written on component parameters. The checker rejects a mismatch at save time, so the browser never sees a type error.

| Type | Values | Notes |
| --- | --- | --- |
| `Number` | 64-bit float | `%` suffix is a plain number divided by 100 |
| `String` | UTF-8 text | `+` concatenates when either side is a String |
| `Bool` | `true` `false` |  |
| `Duration` | milliseconds | `10m` = 600000; arithmetic with Number is an error |
| `Time` | wall-clock time of day | only in `at` triggers and comparisons with `now.time` |
| `Color` | a theme palette name | never a literal outside `theme`; passing `palette.lamp` passes the name, not the hex |
| `Token` | a theme value of any other group (`surface.card.shadow`) |  |
| `Entity` | a live view of one entity | fields in section 6 |
| `Attribute` | a live view of `entity#attr` | fields `value`, `available` |
| `Area`, `Device` | registry records | fields in section 6 |
| `List<T>` | ordered, homogeneous | `[1, 2]`, `area.entities` |
| `Enum<…>` | a closed set of member names; a value is written with a leading dot, .Lg | `Sm \| Md \| Lg`, `Hour \| Day \| Week` |
| `Unavailable` | the state of an entity that has not reported | see below |
| `Null` | absent | `??` substitutes |
| `Event<…>` | a lambda with typed arguments | property type only, never a value |

**Unavailable.** An `Entity` whose `StateRecord.available` is false, or that the browser has not yet received, is still an `Entity`, but its `value` and every attribute are `Unavailable`. Arithmetic, comparison and functions over `Unavailable` yield `Unavailable`; `??` turns it into its right operand; `when: x` with `x` Unavailable hides the node; a built-in whose `of` is Unavailable renders its placeholder. `Unavailable` is distinct from `Null` so that a sensor that has never reported is never confused with a value an author left out.

**Coercion.** None. `"21" == 21` is false; `format(x, 1)` makes a String. A Number in a String position is an error, which is what `format` is for.

## 6. The live scope

Every expression evaluates in a scope built from the `House` object the web store already keeps (`packages/web/src/store.ts`): entities, devices, areas and the `states` map. These names are always in scope.

| Name | Type | Reads |
| --- | --- | --- |
| `sensor.x`, `light.y`, … | `Entity` | `StateRecord` for that id, resolved by name at compile time; an unknown id is a save-time error |
| `sensor.x#humidity` | `Attribute` | `StateRecord.attributes.humidity` |
| `areas` | `List<Area>` | every `Area`, in registry order |
| `area.<id>` | `Area` | one area by id (`area.kitchen`) |
| `devices` | `List<Device>` | every `Device` |
| `device.<id>` | `Device` | one device by id |
| `screen` | `Enum<Phone \| Tablet \| Desktop>` | viewport width against the theme's `breakpoints` (section 11) |
| `now` | `Now` | `now.time` (`Time`), `now.date`, `now.weekday`; ticks once a minute |
| `theme` | `Theme` | the active theme's values: `theme.palette.lamp` (section 8 shortens this to `palette.lamp`) |
| component parameters, `for` variables, `state` names | as declared | innermost binding wins; shadowing a built-in name is an error |

**`Entity` fields.** `value` (the domain's state, typed per domain: `Number` for sensor, `Enum<On \| Off>` for switch and light, `Enum<Open \| Closed \| Opening \| Closing>` for cover, and so on, following `EntityState` in `packages/core/src/types.ts`), `available` (`Bool`), `changedAt` and `updatedAt` (`Number`, epoch ms), `name` (`String`, the registry name), `id`, `domain` (`String`), `area` (`Area` or `Null`), `device` (`Device` or `Null`), `unit` (`String` or `Null`), `attr` (a record of attributes: `e.attr.brightness`), `capabilities` (`List<String>`).

**`Area` fields.** `id`, `name`, `entities` (`List<Entity>`, in registry order, hidden and disabled excluded), `devices` (`List<Device>`).

**`Device` fields.** `id`, `name`, `area` (`Area` or `Null`), `entities` (`List<Entity>`), `manufacturer`, `model` (`String` or `Null`).

Entity refs resolve to the live record, so `sensor.living_temp.value` changes when a `state_changed` event lands. `areas` and `area.*` change on registry events. Nothing in the scope is writable from an expression.

## 7. Expressions and reactivity

An expression is pure: given the same scope it yields the same value and touches nothing. Evaluation is strict except for `?:`, `&&`, `||` and `??`, which evaluate only the branch they need, so a dependency is recorded only for what was actually read.

**Dependency tracking.** While an expression evaluates, every read of an entity, attribute, area, device, `screen`, `now` or local state is appended to that expression's dependency set. The set is replaced on each evaluation, so a branch that stops being read stops being a dependency. The browser interpreter subscribes each node's properties to their sets (section 14). Server handlers use the same evaluator; their trigger is the subscription.

**Functions.** A fixed library; there are no user functions. Each is total over `Unavailable` and `Null` (returns the same kind back).

| Function | Signature | Meaning |
| --- | --- | --- |
| `round(x, places = 0)` | Number → Number | half away from zero |
| `floor(x)`, `ceil(x)`, `abs(x)` | Number → Number |  |
| `clamp(x, lo, hi)` | Number → Number |  |
| `min(a, b, …)`, `max(a, b, …)` | Number… → Number |  |
| `format(x, places = 0)` | Number → String | locale-aware, no unit |
| `unit(e)` | Entity → String | the entity's unit via `packages/client` units |
| `ago(t)` | Number → String | "4 min ago", the wording from `present.ts` |
| `present(e)` | Entity → String | the state wording `present.ts` already produces for the CLI and web |
| `count(list)` | List\<T> → Number |  |
| `any(list, pred)`, `all(list, pred)` | List\<T>, (T) => Bool → Bool | the only places a lambda is an expression argument |
| `first(list)` | List\<T> → T or Null |  |
| `sort(list, key)` | List\<T>, (T) => Number or String → List\<T> | stable |
| `lower(s)`, `upper(s)`, `trim(s)` | String → String |  |
| `contains(s, sub)`, `starts(s, p)` | String, String → Bool |  |
| `since(t)` | Number → Duration | `now - t`; depends on `now` |
| `between(x, lo, hi)` | Number → Bool | inclusive |

**Lists.** `list[i]` indexes from 0; out of range is `Null`. `for` in a node body is the only iteration; there is no `map` because a `for` with a child node is one.

**Comparison of enums.** Enum values are written with a leading dot and compare to members: `switch.porch.value == .On`. Comparing an enum to a String is a type error, which catches the common `== "on"` mistake.

**Resolving `.Name`.** A member takes its enum from the expected type: the parameter or property it is passed to, the other side of `==` or `!=`, the entity's value in `changed to`, a list's element type, a generic `T` bound by a sibling property (`Segmented`'s `value`), or a declared state type. With none of these it is error E041. Members never stand bare, so they cannot collide with components or themes: `.Day` the range and `Day` the theme are different names.

**Evaluation cost.** Expressions are small and the interpreter is an AST walker; a page with 200 nodes and 1000 properties re-evaluates only the properties whose dependencies changed. There is no memoisation beyond that in v1.

## 8. Themes

A theme is a named set of values in fixed groups. Two themes ship as built-ins, `Day` and `Night`, generated from `packages/ui/design/tokens.json` so the existing 23 colours keep their names. A user theme `extends` one of them and overrides or adds values. Pages reference values by group path; the `theme.` prefix is implied, so `palette.lamp` and `theme.palette.lamp` are the same.

```casa
theme Dusk extends Night {
  palette    { lamp: #f2b05e  warn: #d9593a }
  surface.card { background: palette.plaster  border: hairline  shadow: lg  radius: md }
  breakpoints  { tablet: 640  desktop: 1100 }
}
```

**Vocabulary.** The groups and their keys. A key marked *open* accepts new names in a user theme; the others are closed.

| Group | Keys | Value type | Open |
| --- | --- | --- | --- |
| `palette` | the 23 token colours (`plaster`, `ink`, `terracotta`, `lamp`, `sky`, `sage`, `ember`, `series1`…`series3`, …) | Colour or palette ref | yes |
| `surface.page`, `surface.card`, `surface.raised`, `surface.control` | `background`, `border`, `shadow`, `radius` | palette ref; `border` one of `none hairline thin thick`; `shadow` one of `none sm md lg`; `radius` one of `none sm md lg full` | no |
| `text` | `primary`, `muted`, `accent`, `onAccent`, `danger` | palette ref | no |
| `space` | `xs sm md lg xl` | Number (px) | no |
| `font` | `body`, `display`, `mono` (family strings); `size.sm size.md size.lg size.xl` (Number) |  | no |
| `chart` | `grid`, `axis`, `series1`…`series3`, `good`, `warn`, `bad` | palette ref | no |
| `breakpoints` | `tablet`, `desktop` (min widths; `phone` is everything below `tablet`) | Number (px) | no |
| `accents` | `lamp sky sage ember` | palette ref | yes |
| `divider` | color, height, inset, space | palette ref; Numbers (px) | no |
| `room.icon`, `card.icon` | shape, size, border, background, padding | shape one of `arch circle square none`; size and padding Number (px); border as surfaces; background palette ref | no |
| `room.name`, `room.subtitle`, `card.title`, `card.subtitle`, `section.title` | size, weight, font, color | size Number (px); weight 100–900 in hundreds; font one of `body display mono` (a `font` family); color palette ref | no |

**Where a page may use a theme value.** Any property typed `Color` or `Token` on a built-in: `accent`, `color`, `background`, `border`, `shadow`, `radius`, `gap`, `padding`. Those properties accept nothing else; `color: #fff` in a page is diagnostic `E020`.

**Coverage rule.** On every save of a page or a theme, the compiler collects the set of theme paths referenced by every stored page and checks every stored theme resolves every one of them. A theme that fails is not saved; a page that references a name no theme has is not saved. `extends` makes this cheap: adding `palette.warn` to `Dusk` alone fails coverage, because `Day` and `Night` lack it, until it is added to a theme they can inherit from or to each of them. The recommended shape is one house theme that `Day` and `Night`-derived themes extend.

**CSS emission.** A theme compiles to one CSS rule `:root[data-theme="dusk"] { --palette-lamp: #f2b05e; … }` layered over `tokens.css`. The existing `--lamp`-style names are kept as aliases so `packages/ui` needs no change. `border`, `shadow` and `radius` enums map to fixed CSS values in a small table in the compiler. The browser applies the chosen theme by setting `data-theme`, exactly as `theme.ts` does today; the Day/Night choice becomes "which theme", with `system` mapping to the two themes marked as the light and dark defaults.

## 9. Components

A component is a named, parameterised subtree. It is instantiated like a built-in. There is no inheritance; composition is the only reuse.

```casa
component Temp(of: Entity, hot: Number = 25, range: Enum<Hour | Day | Week> = .Day) {
  state shown = range                       // local, browser-only, initialised from a parameter
  Card {
    accent: of.value > hot ? palette.warn : palette.sage
    Headline { of: of }
    History  { of: of  range: shown  color: of.value > hot ? chart.warn : chart.series1 }
    Segmented { options: [.Hour, .Day, .Week]  value: shown  onChange: (v) => set shown = v }
    children
  }
}
```

**Parameters.** Each has a type and an optional default. A caller sets a parameter as a property: `Temp { of: sensor.living_temp  hot: 27 }`. A parameter without a default is required. Parameters are reactive: if the caller's expression changes, the component's expressions that read it re-evaluate.

**Local state.** `state name[: Type] = expr` declares a mutable, browser-only value scoped to that instance. The type may be left out when the initialiser has one; an enum member alone needs it (`state range: Enum<Hour | Day | Week> = .Day`). The initialiser evaluates once when the instance mounts; it is not a binding. Only a `set` in a browser handler changes it. State does not survive a reload and is not shared between viewers. A component with state is still pure from the outside.

**Children.** A component body has exactly one root node and may contain `children` once, which is where the caller's child nodes render. A caller passing children to a component with no `children` slot is `E031`.

**Scope.** A component sees its parameters, its state, the live scope (section 6) and theme values. It does not see the caller's `for` variables or state. Names resolve lexically; a parameter shadowing a theme group name (`palette`) is an error.

**Recursion** is not allowed; the component graph must be acyclic (`E032`).

**Built-ins and components share one namespace**, so a component may not be named `Card`. A built-in cannot be overridden; wrap it instead.

## 10. Built-in catalogue

Every built-in is a thin wrapper over a `packages/ui` component. The catalogue is deliberately the set needed to reproduce today's Home plus the primitives to compose new things; new built-ins are a `packages/ui` change plus one registry entry, not a language change.

**Common properties**, on every node: `when: Bool` (hide when false or Unavailable; default true), `key: String` (identity inside a `for`; defaults to the loop variable's `id`), `span: Number` (columns to occupy inside a `Grid`; default 1).

**Layout**

| Built-in | Properties | Notes |
| --- | --- | --- |
| `Stack` | `direction: Enum<Column \| Row> = .Column`, `gap: Token = space.md`, `align: Enum<Start \| Center \| End \| Stretch>` | the only flex container |
| `Grid` | `columns: Number`, `gap: Token = space.md`, `rowHeight: Enum<Auto \| Equal> = .Equal` | `.Equal` is today's "rooms in a row stand as tall as the tallest" |
| `Card` | `accent: Color`, `size: Enum<Sm \| Md \| Lg> = .Md`, `header: Bool \| Component<name, subtitle, icon, active, accent> = CardHeader`, `name: String`, `subtitle: String`, `of: Entity \| Device \| Area`, `icon: String`, `active: Bool`, `onPress: Event<>` | `active` lights the card as `activeWhen` does today |
| `Room` | `area: Area`, `facts: Bool = true`, `columns: Number = 1`, header: Component\<of: Area> = RoomHeader | the area frame with its status chips; header names a component with one parameter of that type, drawn in place of the bundled one (§9, shared components); `columns` becomes `span` on the parent Grid |
| `Section` | `title: String`, `collapsible: Bool = false`, header: Component\<title: String> = SectionHeader | a titled page region |
| `Spacer` | `size: Token = space.md` |  |

**Text**

| Built-in | Properties | Notes |
| --- | --- | --- |
| `Text` | `value: String`, `style: Enum<Body \| Muted \| Label \| Display> = .Body`, `color: Color`, size: Number, weight: Number, font: Token\<font> | the only way to put a string on the page; size, weight and font set one by one over the style, from a theme's heading groups (room.name.size) |
| `Icon` | `name: String`, `color: Color`, `size: Enum<Sm \| Md \| Lg>` \| Number, shape: Token\<shape>, border: Token\<border>, background: Color, padding: Number | names from the ui gallery's icon list, checked at save time; an unknown name is E013; shape, border, background and padding draw a box behind the icon (room.icon, card.icon) |

**Readings** (today's `CardReading.display` values, one built-in each; all take `of: Entity \| Attribute`, `label: String = of.name`, `tone: Color`)

| Built-in | Extra properties | Replaces |
| --- | --- | --- |
| `Row` | `onPress: Event<>` | `display: row`; a lone `Row` in a `Card` renders as today's `EntityCard` |
| `Headline` | `unit: Bool = true` | `display: headline` |
| `Value` |  | `display: value` (the `stats` block) |
| `Bar` | `low: Number`, `target: Number`, `max: Number`, `color: Color` | `display: bar` |
| `Status` |  | `display: status` |
| `History` | `range: Enum<Hour \| Day \| Week> = .Day`, `color: Color = chart.series1`, `height: Number = 120` | `display: history`; data from `historyView` in `web/model.ts` |
| `Timeline` | `range`, as `History` | `StateTimeline` for on/off domains |
| `Map` | `of` optional, read for its `latitude`, `longitude` and `heading` attributes; `latitude: Number`, `longitude: Number`, `zoom: Number = 15`, `height: Number = 180`, `marker: Bool = true` | new; `MapView` in `packages/ui`, OpenStreetMap tiles |
| `Scale` | `scale: Enum<UV \| PM25 \| PM10 \| AQI \| EAQI>` (required) | new; `ScaleBar` in `packages/ui`, bands from `SCALES` in `packages/client` |

**Controls** (each is a reading plus an action; the action goes through the socket exactly as the ui components do today)

| Built-in | Properties | Domains |
| --- | --- | --- |
| `Toggle` | `of`, `label`, `onToggle: Event<Bool>` | switch, light |
| `Dimmer` | `of`, `label` | light with brightness |
| `Thermostat` | `of`, `label` | climate |
| `CoverControl` | `of`, `label` | cover |
| `LockControl` | `of`, `label` | lock |
| `Button` | `label: String`, `icon: String`, `onPress: Event<>` | any; `of: Entity` optional for button domain |
| `Segmented` | `options: List<T>`, `value: T`, `labels: List<String>`, `onChange: Event<T>` | UI only |

**Page sections** (today's fixed Home blocks, as placeable nodes)

| Built-in | Properties | Notes |
| --- | --- | --- |
| `Greeting` | `weather: Entity` | the greeting with the weather outside |
| `Forecast` | `weather: Entity`, `days: Number = 5` |  |
| `SunPath` | `weather: Entity`, `label: String` | the day as the sun's arc, from the weather's daily sunrise and sunset |
| `Recent` | `limit: Number = 10` | the recent-changes list from `House.recent` |
| `Search` |  | the entity search bar |

A built-in whose `of` has the wrong domain (`Thermostat { of: sensor.x }`) is `E040` at save time, since domains are known from the registry.

## 11. Responsive

`screen` is one reactive value, `.Phone, .Tablet or .``Desktop`, derived from the viewport width and the active theme's `breakpoints` (`tablet` and `desktop` minimums; `Day` and `Night` ship with 860 and 1100 to match today's `app.css`). It is read like any other value, so reflow, hiding and alternate subtrees are all the same mechanism and combine freely with entity state:

```casa
Grid { columns: screen == .Phone ? 1 : screen == .Tablet ? 2 : 3 }
Forecast { when: screen != .Phone }
Stack { when: screen == .Phone   /* a phone-only layout */ }
Stack { when: screen != .Phone   /* everything else */ }
Recent { when: screen == .Desktop && lock.front.value == .Unlocked }
```

There are no `@media` blocks and no per-property breakpoint syntax. A property that should differ by size is written as an expression over `screen`. Changing the viewport across a breakpoint re-evaluates exactly the properties that read `screen`; nothing else re-renders.

`screen` is browser-only. A server handler that reads it is `E050`.

## 12. Handlers

A handler is a trigger and a block of statements. The trigger decides where it runs; the author writes nothing about runtimes.

**Triggers and their runtime**

| Trigger | Runs on | Fires when |
| --- | --- | --- |
| `on <entity> changed` | server | the entity's state value changes (not on attribute-only updates) |
| `on <entity> changed to <expr>` | server | the value changes and the new value equals `<expr>` |
| `on <entity> changed from <a> to <b>` | server | both ends match; either may be omitted |
| `on <entity>#<attr> changed` | server | that attribute changes |
| `every <duration>` | server | the scheduler ticks; minimum `1m` |
| `at <time>` | server | once a day at that wall-clock time in server.timezone from config.toml, the zone the scheduler already uses |
| `onPress`, `onToggle`, `onChange` property lambdas | browser | the viewer interacts |

Server handlers are compiled to the existing `AutomationApi` (`onStateChange`, `scheduler`, `command`) and registered under the page's id; republishing the page replaces them atomically. Browser handlers run in the viewer's tab; their `call` goes through the same socket command the ui components use.

**Statements**

| Statement | Server | Browser | Meaning |
| --- | --- | --- | --- |
| `call <entity>.<command> { arg: expr … }` | yes | yes | send a command; commands and their arguments are those the command router accepts for the domain, checked at save time (`E060`) |
| `set <state> = expr` | no | yes | assign local state in the enclosing component or page |
| `if expr { … } else { … }` | yes | yes |  |
| `after <duration> { … }` | yes | no | schedule the block; a later firing of the same handler cancels a pending `after` from the earlier one |

**Partition rule.** The compiler walks each server handler's expressions. Any read of `screen`, local `state`, theme values, or a component parameter is `E050`; the handler may read only entity, attribute, area and device state, `now`, and literals. This is what lets the server run it with the page closed. Browser handlers may read everything.

**Handler placement.** Entity-triggered handlers are legal only at `page` level, not inside a component; a component is instantiated many times and would register the same automation many times. UI-event lambdas are legal anywhere a built-in exposes an `Event` property.

**Delivery.** A server handler fires at most once per state change, after the state store has applied it. If the server restarts, pending `after` blocks are lost; v1 does not persist them. Errors inside a handler (a command refused by an integration) are logged to `casita.log` with the page id and line, and do not stop other handlers.

## 13. Compilation, storage and the API

The compiler lives in `packages/core/src/casa/` and is pure: `compile(source, registry, themes) => { ok, ast, serverHandlers, themeRefs, diagnostics }`. It never touches the database or the network, so it is unit-testable like `model.ts` and runs unchanged in the browser for the live preview.

**Passes**, in order; each stops the pipeline on an error.

1. Lex and parse to a syntax tree with source spans on every node.
2. Resolve names: built-ins, components, entity and area ids against the registry, theme paths against the theme vocabulary.
3. Type-check expressions, parameters, property types and `Enum` members.
4. Partition handlers into server and browser and apply the partition rule.
5. Check theme coverage across all stored pages and themes.
6. Emit: a compact JSON AST for the browser (expressions as prefix arrays, not strings, so no parsing happens at render), the server handler list, and for a theme its CSS text.

**AST stability.** The emitted AST carries an `astVersion` and is treated as a public format: additive changes only within a major version, with a fixture test that loads every stored page's AST. This keeps a later form-based arrange UI, which would edit the AST directly rather than the source, possible without a rewrite.

**Storage.** Two new tables by migration 009, both in `data/home.db`:

| Table | Columns | Notes |
| --- | --- | --- |
| `pages` | `id`, `name`, `source`, `compiled` (JSON), `theme_refs` (JSON), `updated_at`, `updated_by` | one row per page; `home` is seeded by the migration |
| `themes` | `id`, `name`, `source`, `css`, `extends`, `is_light_default`, `is_dark_default` | `day` and `night` are seeded and read-only |

The previous `source` is kept in a `page_versions` table (every version, unbounded for now; a size cap can come later) so a bad save can be reverted from the editor.

**API requests** (added to `packages/api/src/schema.ts` following the CONTRIBUTING checklist):

| Request | Auth | Returns |
| --- | --- | --- |
| `page.get { id }` | any user | `compiled`, `theme_refs`, `updated_at` |
| `page.source { id }` | admin | `source`, versions |
| `page.check { source }` | admin | diagnostics only; nothing stored. The editor calls this on a 300 ms debounce |
| `page.save { id, source }` | admin | diagnostics, or the new compiled page; also replaces the page's server handlers |
| `page.revert { id, version }` | admin |  |
| `theme.list` | any user | ids, names, light/dark defaults, css |
| `theme.save { id, source }` | admin | diagnostics or the compiled theme |
| event `page_changed { id }` | subscribed | the browser refetches `page.get` |

Command-sending from browser handlers reuses the existing `command` request; nothing new is needed for it.

## 14. Runtime

&#91;embedded content: runtime · one compiler, two runtimes, one socket\]

The compiler's AST goes to the browser and its handler list to the server; the two meet only over the existing `/ws` socket, which carries state events down and commands up.

**Browser interpreter** (`packages/web/src/casa/`). It mounts the AST as a React tree: each node becomes a React component that holds its evaluated properties in local state and subscribes to the dependency set of each property through `useSyncExternalStore` on the `House` store. When an event changes a key in a set, only that property re-evaluates, and the node re-renders only if the value changed. `for` blocks keep children by `key` so a reorder is a move, not a remount. `screen` is a store key fed by a `ResizeObserver`; `now` is a store key ticked every minute. Browser handler lambdas close over the node's scope and run on the event; `set` writes the instance's state cell, `call` sends the command request.

**Server handlers** (`packages/core/src/casa/runtime.ts`). On startup and on `page.save`, the server reads each page's compiled handler list and registers one automation per page through the same `AutomationApi` that `automations/*.ts` uses. An entity trigger becomes `onStateChange(entityId, (next, prev) => …)` whose body evaluates `to`/`from` guards and then the statements with the same expression evaluator, over a scope backed by the state store instead of the House store. `every` and `at` use the scheduler. `after` uses the scheduler with a per-handler token so a re-fire cancels the pending block. Republishing a page unregisters its automation and registers the new one before acknowledging the save.

**Theme switching.** `theme.list` gives the browser every theme's CSS once per session; switching sets `data-theme` and swaps the injected stylesheet. No page re-evaluation is needed because pages carry names, not values.

**Failure modes.** If the compiled page fails to load (a registry entity was removed after the save), the browser renders the page with that node replaced by an inline error block and the editor shows `E011`; the page is not blank. A server handler whose entity is gone logs once and is skipped until the page is re-saved.

## 15. Editor and preview

The editor is a page in the web app at `/edit/:pageId`, admin-only, with the source on the left and the live page on the right. One file holds layout, components, theme references and handlers, which satisfies the single-editor requirement.

**Editor.** CodeMirror 6 with a Lezer grammar generated from the same EBNF, giving highlighting, bracket matching, folding by node and autocomplete for built-in names, their properties, theme paths, and entity ids from the registry. The compiler runs in the browser on every keystroke (debounced 300 ms) with the registry and theme list the app already holds, so diagnostics appear inline with no round-trip; `page.check` is called only before save for the cross-page coverage check, which needs every stored page.

**Preview.** The right pane mounts the browser interpreter on the compiled AST against the real `House` store, so it shows live data and reacts to the house while you type. Browser handlers are live in the preview too; a `call` in the preview really sends the command, which is the honest behaviour, and the pane says so in its header. Server handlers never run from the preview; the pane lists them with their trigger and an "armed after save" badge.

**Pretend panel.** A drawer under the preview lists the entities the page reads, each with an override field. An override replaces that entity's value in the preview's scope only, so the hot-temperature branch can be seen without heating the house. Overrides are cleared on save and never leave the browser. `screen` has a three-way toggle in the same drawer; the pane also narrows to the chosen width.

**Save and revert.** Save sends the source; a diagnostic blocks the save and highlights the line. A successful save publishes to every viewer through `page_changed`. Every version is listed in a side sheet with their time and author; revert is a save of that version's source, so it passes the same checks.

**Theme editing** uses the same editor on `/edit/theme/:id`, with a preview of the Home page in that theme and a swatch strip of the palette. Coverage failures name the page and line that references the missing value.

**Discoverability.** Clicking any node in the preview while holding Alt moves the cursor to that node's source line, using the spans the compiler keeps. This is the replacement for the arrange forms: the question "where is this card defined" has a one-click answer.

## 16. Migration from CardConfig and AreaDisplay

Migration 009 generates the `home` page from the stored data once, then the old columns stop being read. The generator is a pure function `homeFromLegacy(house) => string` in `packages/core/src/casa/legacy.ts`, tested against fixtures of today's `areaViews()` output so the first render of the generated page matches the current Home pixel for pixel in the ui gallery.

**Mapping**

| Today | Casa |
| --- | --- |
| page sections (search, greeting, forecast, rooms, recent) | `Search {}`, `Greeting { weather: weather.<id> }`, `Forecast { … }`, a `Grid { columns: … }` of `Room`s, `Recent {}` in that order, with today's 3/2/1 columns as a `screen` expression |
| `AreaDisplay.columns` | `Room { span: n }` |
| `AreaDisplay.facts` | `Room { facts: bool }` |
| room order and climate-first ordering | written out explicitly; the generator emits climate cards first |
| a device card with no `CardConfig` | `Card { name: device.name  for e in device.<id>.entities { Row { of: e } } }` |
| `CardConfig.name/icon/accent/size/header` | the same properties on `Card`; `accent: "lamp"` becomes `accent: accents.lamp` |
| `CardConfig.activeWhen: any` | `active: any(device.<id>.entities, (e) => e.value == .On)` |
| `CardConfig.activeWhen: never` | `active: false` |
| `CardConfig.activeWhen: <entityId>` | `active: <entity>.value == .On` |
| `CardReading` with `display: row/value/headline/bar/status/history` | `Row/Value/Headline/Bar/Status/History { of: … }` with `label`, `tone`, `low`, `target`, `range` carried over; `tone` values are limited by zod to accent, neutral and the four CARD\_ACCENTS, so none fall outside; accent becomes the enclosing card's accent, neutral becomes text.muted, and the rest become `accents.*` refs |
| `entityId#attribute` | `sensor.x#attribute` |
| a `CustomCard` | a `Card` placed in its `areaId`'s `Room`, or after the Grid when it has none |
| one-row card | `Card { Row { … } }`; the interpreter renders it as `EntityCard` as today |
| `Device.homeHidden` | the device is omitted from the generated page |

**What is removed**, in the same change: the Add-card button and arrange forms in `packages/web`, `forms.ts` validation for `CardConfig`, the `card.*` API requests, the `cards` table, `devices.card` and `areas.display` (dropped in migration 010 one release later, after the generated page has been seen to work), and the `CardConfig` zod schema in `packages/core/src/card.ts`. `CardBlock` in `web/card.ts` stays, as it is what the reading built-ins render through.

**What is lost.** Arranging a card by form. A viewer who is not an admin can no longer change what Home shows. This was the chosen trade-off; section 19 lists an AST-level arrange UI as a possible later addition.

**Rollback.** Migration 009 only adds tables and a row; the old columns are untouched until 010. Reverting the deploy before 010 brings the old Home back with no data loss.

## 17. Diagnostics catalogue

Every diagnostic has a stable code, a line and column span, and a one-sentence message that names the thing and the fix. Warnings never block a save; errors always do.

| Code | Level | Message pattern |
| --- | --- | --- |
| E001 | error | syntax: unexpected `}` at 12:3, expected a property or a node |
| E002 | error | unknown built-in or component `Crad`; did you mean `Card` |
| E003 | error | property `colour` is not defined on `Card`; its properties are … |
| E004 | error | property `accent` given twice on this `Card` |
| E010 | error | unknown entity `sensor.livng_temp`; did you mean `sensor.living_temp` |
| E011 | error | entity `sensor.old` is no longer in the registry (shown after a registry change) |
| E012 | error | `Thermostat` needs a climate entity; `sensor.x` is a sensor |
| E013 | error | unknown icon \`thermometr\`; the gallery lists the icon names |
| E020 | error | a colour literal is only allowed inside `theme`; use a palette name |
| E021 | error | `palette.warn` is not defined by theme `Day`; add it to `Day` or to a theme it extends |
| E022 | error | theme group `surface.card` has no key `glow` |
| E030 | error | type mismatch: `label` expects String, got Number; wrap it in `format()` |
| E031 | error | `Temp` takes no children |
| E032 | error | component `A` uses itself through `B` |
| E033 | error | required parameter `of` missing on `Temp` |
| E034 | error | `set` targets `range`, which is a parameter, not state |
| E038 | error | a `Map` needs a place: `of` an entity with a location, or `latitude` and `longitude` (also: one without the other; a written zoom outside 0–19) |
| E040 | error | comparing enum `On \| Off` to a String; use .`On` |
| E041 | error | enum member .Day has no expected type here; give range a type: state range: Enum\<Hour \| Day \| Week> = .Day |
| E050 | error | server handler reads `screen`, which only exists in the browser |
| E051 | error | entity-triggered handlers are only allowed at page level |
| E060 | error | command `turn_on` takes no argument `color` for a switch |
| E061 | error | `after` is only allowed in server handlers |
| W100 | warning | `when: true` has no effect |
| W101 | warning | component `Spare` is never used |
| W102 | warning | `for` over a list without a `key`; items will be keyed by index |
| W103 | warning | handler fires on every change of `sensor.power`, which reports every few seconds |

The editor shows errors as red underlines and warnings as amber, with the message on hover and in a problems list. The compiler's test suite has one fixture per code.

## 18. The stock Home page in Casa

This is the shape migration 009 generates, shortened to one room, with one custom component and one server handler added to show every feature in use. Entity and area ids are illustrative.

```casa
// A house theme both light and dark derive from, so `palette.warn` is covered everywhere.
theme House extends Day {
  palette { warn: #d9593a }
}
theme HouseNight extends Night {
  palette { warn: #e8755a }
}

// A temperature card that turns on the warning colour above a threshold and
// lets the viewer pick the history range.
component Temp(of: Entity, hot: Number = 25) {
  state range: Enum<Hour | Day | Week> = .Day
  Card {
    name: of.name
    accent: of.value > hot ? palette.warn : accents.sage
    Headline { of: of }
    History  { of: of  range: range  color: of.value > hot ? palette.warn : chart.series1 }
    Segmented {
      options: [.Hour, .Day, .Week]  labels: ["Hour", "Day", "Week"]
      value: range  onChange: (v) => set range = v
    }
  }
}

page Home {
  Stack {
    Search {}
    Greeting { weather: weather.home }
    Forecast { weather: weather.home  when: screen != .Phone }

    Grid {
      columns: screen == .Phone ? 1 : screen == .Tablet ? 2 : 3

      Room { area: area.living  span: screen == .Desktop ? 2 : 1  facts: true
        Thermostat { of: climate.living }
        Temp { of: sensor.living_temp  hot: 26 }
        Card { name: "Lamps"  active: any(area.living.entities, (e) => e.domain == "light" && e.value == .On)
          for e in area.living.entities where e.domain == "light" {
            Toggle { of: e }
          }
        }
        Card { name: "Power"  size: .Sm
          Bar { of: sensor.living_power  target: 150  max: 600  color: sensor.living_power.value > 400 ? palette.warn : chart.good }
        }
      }

      // Every other room, generated: devices first, then entities with no device, by domain.
      for a in areas where a != area.living {
        Room { area: a  facts: true
          for d in a.devices {
            Card { name: d.name
              for e in d.entities { Row { of: e } }
            }
          }
        }
      }
    }

    Recent { limit: 10  when: screen != .Phone }
  }

  // Runs on the server, tab open or not.
  on switch.porch changed to .On {
    call light.hall.turn_on { brightness: 60 }
    after 10m { call light.hall.turn_off }
  }

  // Nightly, close anything left open.
  at 23:00 {
    if cover.garage.value == .Open { call cover.garage.close }
  }
}
```

Reading it against the constraints: the theme block is the reskin surface (1, 2); the whole page is one editable text with a live preview (3, 5); `accent`, `color` and the two handlers are the scripted values and reactions (4); `screen` drives columns, `span` and what is hidden (6).

## 19. Open questions and implementation order

**Open questions**, to settle before the parser is written:

- [x] Enum members as bare type names (`On`, `Day`, `Lg`) share the namespace with components. Keep this, or spell them `.On`?
- [ ] Should `for` be allowed at page level outside a container node (it is not today; the root must be one node)?
- [x] Is a 20-version history enough, or should `page_versions` be unbounded with a size cap?
- [x] `at` uses the server's zone. Expose a `tz` in the theme or in `config.toml`?
- [x] Which `packages/ui` icon names does `Icon` accept: the gallery list, or any name with a fallback?
- [x] Do any current `CardConfig` rows use `tone` values outside `CARD_ACCENTS`? The generator needs a rule for them.
- [x] Multiple pages (Home plus others) are a `pages` row away; is navigation between them in scope for v1?
- [x] An AST-level arrange UI could later restore form-based editing for non-admins. Worth keeping the AST stable enough to build it?

**Implementation order.** Each step ends with its tests passing and is independently shippable.

1. Lexer, parser, AST and the diagnostics framework in `packages/core/src/casa/`; fixtures for E001–E004.
2. Resolver and type checker against a registry fixture; expression evaluator with dependency tracking; the function library.
3. Theme compiler: `Day` and `Night` generated from `tokens.json`, coverage check, CSS emission, `themes` table and requests.
4. Browser interpreter and the built-in registry for layout and text; render a static page in the ui gallery.
5. Reading and control built-ins over the existing `CardBlock` and control components; `screen` and `now` store keys.
6. Handler partition, server runtime over `AutomationApi`, `page.save` replacing handlers atomically.
7. `pages` table, requests, `page_changed` event; the Home page loads from the table behind a flag.
8. The editor page: CodeMirror, Lezer grammar, inline diagnostics, preview, pretend panel, versions.
9. `homeFromLegacy` generator with pixel fixtures; migration 009 seeds `home`; flag removed.
10. Remove the arrange UI, `card.*` requests and `CardConfig` schema; migration 010 drops the old columns one release later.

Steps 1–3 touch no UI and can land on `web-ui` without changing what the server shows. Step 7 is the first deploy that changes Home, and it is flag-guarded.

## 20. As built (2026-10-07)

Steps 1–10 are implemented on `web-ui`. Where the build departs from the sections above, this is what stands; the code is the reference.

**Coverage (§8).** Day and Night are read-only, so the rule as written made any new palette name impossible (§18's own example adds `palette.warn` to `House`/`HouseNight` only). Coverage is checked over the themes a viewer can pick: the house's own themes when it has any, else Day and Night. Themes declared in a page's file are stored as rows of `themes` on save, beside the page. The light and dark defaults are not stored: the first light and the first dark theme among the pickable ones are what `system` chooses.

**Names (§13).** Requests follow the codebase's convention: `get_page`, `list_pages`, `get_page_source`, `check_page`, `save_page`, `revert_page`, `list_themes`, `save_theme`; events `page_changed { pageId }` and `theme_changed { themeId }`; CLI `casita page list|show|source|check|save|revert` and `casita theme list|save`. `list_themes` carries each theme's `values` and `breakpoints`, so the browser compiles with the coverage check in view. Versions are unbounded.

**Language.** An `entities` global (`List<Entity>`, every shown entity) joins `areas` and `devices`, so a page can say what is in no room. `Room` takes `name` in place of `area` for that frame; `Room { columns }` is the same as `span`. A member compared with a value of unknown domain (`e.value == .On` for a loop variable) is accepted; an entity of unknown domain fits any `Entity<domain>` property, and a wrong one draws a plain row. `transitionMs` takes a Duration or a Number; `brightness` is 0–1, so §18's handler reads `brightness: 60%`. Added diagnostics: E005 (unknown name), and E012 is the wrong-domain error (E040 stays enum-versus-string). Icon names are checked in the browser (E013), the server checks the shape. `for` at page level outside a node is not allowed: the root is one node.

**Runtime.** Server-side `present()`, `unit()` and `ago()` give plain words ("On", "21.5", "4 min ago"); the client's wording lives in the browser. `Search` lists what matches and opens its details rather than filtering rooms. `History`'s `color` and `height` are accepted but the chart keeps the house's style; `Timeline` draws through the same history block, which picks a timeline for on/off domains. A card's `accent` that is not one of the four design-system accents is set as a custom property on the card.

**Editor (§15).** The source pane is CodeMirror with a hand-written stream tokenizer following the lexer's rules, not a generated Lezer grammar; folding is by brackets. The browser compiles on a 300 ms debounce; a save calls `check_page` first, then `save_page`. The web app's content security policy allows the styles the page makes itself (a theme's rule, the editor's) through a per-response nonce in `<meta name="csp-nonce">`; nothing else inline is allowed.

**Migration (§16).** `homeFromLegacy` reads the old columns straight from SQLite (`legacyHouse(db)`), so the registry no longer carries cards or how rooms are drawn. The generated page writes out only what was arranged by hand and loops over the rest (`for d in sort(area.x.devices, …)`), so a device that arrives later still shows, and a fresh install's Home is all loops. Group cards ("Lights", "Sensors") are a `Group` component; a car's stats block is not reproduced. `CardBlock` is gone: the reading built-ins draw through `WidgetBlockView`, exported from `packages/ui`'s `WidgetCard`, which also takes `children`. Migration 010, dropping `cards`, `devices.card`, `devices.home_hidden` and `areas.display`, is for the next release; `legacyHouse` copes when they are gone.

**Added since (2026-10-08).** `date(t)`, `time(t)` and `datetime(t)` take an epoch-ms Number and give a String in the app's wording ("Wed 7 Oct", "10:42 pm"; plain on the server), beside `ago(t)`; each depends on `now`. `Value` takes `text: String` for words of the page's own, and `of` is then optional: `Value { label: "Last watered"  text: date(switch.x#lastWateredAt.value) }`.

**Dividers (§8, 2026-10-08).** The vocabulary gains a `divider` group: `color` (colour), `height`, `inset` and `space` (numbers, px). It is the line between any two blocks of a `Card`'s body, between the rows of a list, and under a one-row card's dimmer; never after the last block. Day and Night set it to `palette.line`, 1, 0, 12. Emitted as `--divider-color`, `--divider-height`, `--divider-inset`, `--divider-space`; `packages/ui` reads them with fallbacks so the design tokens alone still draw a hairline. A `Card` whose only child is a `for` over `Row { of: e }` (the loop's own variable) with exactly one item, or a `Row` whose `of` is a variable, is drawn as that row too, not only a literal `Row { of: switch.x }`; an empty such loop reads "Nothing on this card." \`Card\` takes \`dividers: Bool = true\`; false leaves the lines out of its body and keeps the room between blocks.

**October (§8, 2026-10-08).** A third built-in theme, `October`, extends `Night` and is written in Casa (`OCTOBER_SOURCE` in `theme.ts`, compiled at startup), not generated from the tokens; `list_themes` carries its source so the editor shows it read-only, and `isBuiltinTheme` (ids `day`, `night`, `october`) is the one built-in check for coverage and the `builtin` flag. Built-ins are still never a viewer's defaults ahead of the house's own themes. Outside the language, the web shell draws the brand mark from `--terracotta` and `--lamp` and, for October or a theme that extends it, adds a crescent moon to the mark and a moonlight gradient on the page.

**CSS emission, beyond colours (§8, 2026-10-08).** The theme rule now also stands the design system's names behind the other groups, as it already did `--lamp` behind `palette.lamp`: `--ink`, `--ink-muted`, `--terracotta-ink`, `--on-terracotta` behind `text.*`; `--series-1..3` behind `chart.series*`; `--space-1/2/3/4/6` behind `space.xs..xl` and `--space-8` as `xl + sm`; `--font-sans` behind `font.body`; and `--text-<style>-size` behind `font.size` (label and entity-id `sm`, caption `sm - 1`, body `md`, heading `md + 1`, title `lg`, reading `xl`, display `xl + 8`), which `tokens.css` reads with the token as fallback and a fixed lead on the line height. The surface groups reach `packages/ui` directly: component CSS reads `--surface-card-*` (cards, rows, tables, charts, panels), `--surface-raised-*` (dialog, sheet, menu, toast) and `--surface-control-*` (fields, buttons, segmented control, stepper, toggle, pill, icon picker), each only for the properties whose Day/Night default equals what the component drew before, with that token as the fallback. `--danger` stays on `palette.danger`, not `text.danger`, since it colours more than text.

**Headings (§8–§10, 2026-10-09).** Seven theme groups beyond the table in §8: `room.icon`, `card.icon` (`shape` one of `arch circle square none`, `size`, `border`, `background`, `padding`), and `room.name`, `room.subtitle`, `card.title`, `card.subtitle`, `section.title` (`size`, `weight` 100–900 in hundreds, `font` one of `body display mono`, `color`). A shape emits a radius plus `--<box>-lift` (4px for a room's arch, else 0) and `--<box>-box: none` when the shape is `none`; a face emits `var(--font-<face>)`; a weight is unitless. The headings are bundled Casa components (`headers.ts`: `RoomHeader(of: Area)`, `CardHeader(name icon active accent)`, `SectionHeader(title)`), merged into every page's `components` ahead of the house's shared file and the page's own, innermost wins; their theme references are covered but not recorded as the page's. `Room`, `Card` and `Section` take `header:` naming a component (a bare TypeName now parses as a value; a new `component` type with `fitsSlot`; `Card`'s `header` is `Bool | component`); E035 names a header that is not a component, E036 one whose parameters the slot cannot fill. `Icon` takes `shape border background padding` and a numeric `size`; `Text` takes `size weight font`; `Stack`/`Grid` `gap` may be a number; `Area` has `icon`. The shared components file (one row, table `components`, migration 010 — the drop of the pre-Casa columns moves to a later migration) is compiled with `componentsOnly` over an empty page, and a save recompiles every stored page against it. The React `Area` and `WidgetCard` take a heading node; the component CSS reads `--room-*`/`--card-*` with the old values as fallbacks, so Day and Night are unchanged and the Devices page follows a theme. `CardHeader` takes the card's name, icon, active state and accent rather than a device, since a `Card` stands for nothing else; a Room with no area keeps the plain React heading.

**Layout (§8, 2026-10-09).** Every block in a Card's body is the full width; the implicit side-by-side flow of `Value` stats is gone, so two readings beside each other are written as a `Grid`. `Grid`'s `columns` is optional and 1 to 3 (`GRID_COLUMNS_MAX`): left out, there is one column per child up to three, and the children must then be nodes, not a `for` (E037); a literal outside 1–3 is E037; a computed count (`screen == .Phone ? 1 : 3`) is clamped when drawn. A fourth common property, `align: Enum<Start | Center | End>`, says where a node sits in its Grid cell and is honoured only there (CSS `align-items` plus `text-align`, so an aligned `Text` reads that way); left out, the node fills the cell. The node written in a Grid is its cell, a component's use as much as a built-in: \`span\` and \`align\` on \`Temp { … }\` place it, and its root node, no longer in the Grid, has no say (before, the cell wrapped the root, so a use's \`span\` was ignored). A \`columns\` that is not a finite number counts the children; a negative literal (\`-1\`, a minus on a number) is E037; a Grid without \`columns\` whose children are the caller's \`children\` slot is E037 like a \`for\`. `Stack`'s own `align` keeps its meaning (its children's), so a Stack always fills its cell. `Stack { direction: .Row }` was going to retire in favour of `Grid` and did not: the bundled `RoomHeader` and `CardHeader` need a content-sized icon beside a name that takes the rest, which equal columns cannot say; a Row stack is for content-sized things beside each other, a Grid for equal columns of full-width content.

**Device icons (§6, 2026-10-10).** `Device` has an `icon: String` field beside `manufacturer` and `model`: the icon chosen for the device, else its integration kind's (`deviceIcon` in `eval.ts`, the one table the Devices page also reads), else its first shown entity's domain, else `plug`. A `Card` still stands for nothing and defaults its icon to `plug`; the generated Home writes `icon: of.icon` on `DeviceCard` and `icon: device.<id>.icon` on a device's own card when no icon was chosen for it. Day and Night draw a card's icon in a circle now; the arch is a room's.

**Ink on an accent (§8–§9, 2026-10-10).** The `accents` group carries an on-colour per accent: `accents.onLamp`, `onSky`, `onSage`, `onEmber`, set in the Day/Night base to `palette.inkOnLamp`, `palette.onSky`, `palette.plaster`, `palette.inkOnLamp`, the pairs the components' CSS always used. The Card slot gives its header a fifth parameter, `onAccent: Color`, derived in the renderer by `onAccentOf`: `accents.<x>` → `accents.on<X>`, anything else → `text.onAccent`. `CardHeader` draws the active icon in `onAccent`; `RoomHeader` in `accents.onLamp`. The ui's `--ca-on-accent` reads `var(--accents-on<X>, <the old token>)`, so a theme that recolours an accent recolours its ink everywhere, and a custom accent (`[style*="--casa-accent"]`) pairs with `--text-onAccent`.

**Card subtitle (§8, 2026-10-10).** `Card` takes `subtitle: String`, a line under the name in the theme's `card.subtitle` group, which Day and Night defined from the start but nothing drew. The Card slot passes it to its header as `subtitle` (null when the card has none); the bundled `CardHeader` stacks name and subtitle beside the icon, as `RoomHeader` does, and draws the line only when it is given and not empty. A custom `CardHeader` may leave the parameter out (`fitsSlot` already allows a subset).

**Editor hover (2026-10-10).** The page and components editors describe a reference under the pointer: `referenceAt` (web `language.ts`) finds `domain.id`, `area.id` or `device.id` by the lexer's rules, lexically and per line, passing over comments, strings and the tail of a longer path; `describeReference` (web `hover.ts`) says what the house holds for it, or that nothing has the id. An unknown id stays E010 (an error, so the page does not save); the tooltip only adds the words. ⌘-click (Ctrl-click) or the tooltip's link opens the thing's sheet over the editor: `EntityDetail`, and `DeviceDetail` and `AreaDetail` (both in web `detail.tsx`; the device sheet moved there from the Devices page, the area sheet is new). A plain click was not used, since it is how the cursor is placed to edit an id.

**Card `of` (§8, 2026-10-10).** `Card` takes `of: Entity | Device | Area`, what the card is about; when given, the renderer wraps the heading (whatever component draws it) in a button labelled "\<name> details" that opens that thing's sheet, and a one-row card's heading opens it in place of the entity. Nothing in the language acts on it: it is a reference the renderer reads, as `Room`'s `area` is. The page's sheets are `useThingSheets` (web `detail.tsx`): entity, device and area, one open at a time, with an entity pressed on a device's or area's sheet stacking over it. The editor's hover uses the same hook.

**Map (§10, 2026-10-16).** `Map { of: sensor.terry_location  zoom: 15  height: 200 }` draws a still map centred on the `latitude` and `longitude` attributes of `of`'s state (TeslaMate's car location carries them), with a pin turned to its `heading`. `latitude` and `longitude` written on the Map are a fixed place, used while the entity has none; with neither there, it reads "No location". `of` is any entity, so no E012. E038 is a Map with no place, half a place, or a literal zoom outside 0 to `MAP_ZOOM_MAX` (19); a computed zoom is clamped when drawn. The renderer wraps `MapView` in a block of its own (`app-casa-map`), so in a Card's body the divider and spacing fall on the wrapper, outside the map's rounded frame. Tiles are OpenStreetMap's standard ones, fetched by the browser with no key: only those in view, with the required "© OpenStreetMap" credit, darkened by a CSS filter under a dark theme. The server's CSP allows images from `tile.openstreetmap.org`, and each tile sets `referrerPolicy` so OSM gets the Referer that the page's `same-origin` policy would otherwise drop. The map does not pan or zoom.

**Scale and SunPath (§10, 2026-10-16).** `Scale { of: sensor.weather_pm2_5  scale: .PM25 }` puts a reading on its health bands: `.UV` by the WHO's, `.PM25`, `.PM10` and `.AQI` by the US EPA's (PM2.5 as revised in 2024), `.EAQI` by the EEA's. Each band is an equal share of one track, since the bands are far from equal, and the track blends through their colours; a marker stands at the reading (linear within its band), and the band's word sits beside the value. Without a reading the track is grey. The label defaults to the scale's title ("PM2.5", "UV index", "Air quality"), not the entity's name. A reading is rounded to the decimals the scale is published to before its band is chosen. Past the last band it stays at the end. The six colour steps are made from the palette (sage, lamp, ember, danger, then danger mixed toward sky and toward ink), so a theme recolours them. `SunPath { weather: weather.weather }` reads the weather's `daily` sunrise and sunset in its `timeZone` and draws the whole local day (midnight to midnight) as the sun's true elevation, worked out (USNO low-precision formulas) from the weather's \`latitude\` and \`longitude\`, which Open-Meteo now carries; below the horizon it is eased by \`depth · tanh(e / depth)\` so the slope is the same either side and the curve has no corner. Without coordinates a cosine through sunrise and sunset stands in. It is a fixed 72px that stretches to any width; a pointer or finger along it puts the time there and the sun's angle in the heading, and at rest the heading adds the angle now. The day runs from \`midnightIn(date, zone)\` to the next, 23 or 25 hours across a change of clocks, and a midnight the clocks skip is the date's first moment. The sun rides it (a ring below the horizon), the travelled way is lamp by day and muted by night, the times sit under the horizon crossings, and a headline says what comes next ("Sunset in 2h 10m"; after sunset, tomorrow's sunrise, found by date). It redraws on the page's minute tick. A word sensor whose state carries a numeric `at` (Open-Meteo's sunrise and sunset) no longer has "· \<since>" appended by `present`.

**Grid gap (§10, 2026-10-16).** A `Grid` given no `gap` puts its columns `space.xl` apart and its rows `space.md` (CSS `column-gap` beside the `--casa-grid-gap` rows use); a given `gap` is both ways, as before. The cards in an `Area`'s own grid stand `space-6` apart across and `space-4` down.

**Area (§10, 2026-10-17).** `Room` is renamed `Area`, with no alias: `Room` is E002 with the message "`Room` is now `Area`; give it a `name` and an `icon` to draw its heading", and a stored page that uses it fails `refresh()` and keeps its last compiled form, which the renderer no longer draws, until it is edited and saved. `Area` takes `area`, `name`, `icon` (new), `facts`, `columns` and `header`, which has no default now. The heading is drawn only when asked for: `name` puts up the title and the "N devices · M entities" line, `icon` the icon, `header` a component of its own; with none of them the ui `Area` is `bare` (no heading row, so no facts chips, Turn off lights or menu, and it cannot be closed). The slot is `AreaHeader(of: Area, name: String, icon: String)`, bundled to draw each part only when it is given, its lit icon `palette.lampSoft` behind `text.primary` (was `accents.lamp` behind `accents.onLamp`). A house's own `RoomHeader`, in the shared file or a page, still replaces it as a copy named `AreaHeader` unless the same file declares `AreaHeader`; that file is told W105. An `Area` with no `area` keeps the plain React heading, by the same rules. The theme groups stay `room.icon`, `room.name`, `room.subtitle`. `homeFromLegacy` writes `component AreaCard` with `Area { area: of  name: of.name  icon: of.icon … }`, and `name:`/`icon:` on an arranged area, so a generated Home looks as it did.

**Area `of` (§10, 2026-10-17).** `Area` takes its area as `of: Area`, as `Card`, `Row`, `Scale`, `Map` and house components take what they are about; `area:` is E003 with "`Area` takes its area as `of` now: `Area { of: area.hall }`", and the `Room` E002 names `of` too. The generated `AreaCard` writes `Area { of: of  name: of.name  icon: of.icon … }` and an arranged area `of: area.<id>`.

**Area heading from `of` (§10, 2026-10-17).** An `Area` with an `of` is headed by that area's own name and icon (its `icon`, else `house`) without writing them; `name` and `icon` replace either. `header` is `Bool | component` like a `Card`'s, and `header: false` leaves the heading row out. An `Area` with no `of` keeps the rule above: only the parts it is given, bare with none. The generated `AreaCard` is `Area { of: of  facts: facts … }` again, and an arranged area carries no `name`/`icon`.

**Stored pages after a compiler change (§16, 2026-10-09).** A page's compiled form is stored at save time, so a compiler that later makes more of the same source (a bundled heading, a new built-in) would leave stored pages behind: the Home page saved before the bundled headings drew none. `PageStore.refresh()` runs at server start: every page is recompiled from its source against the current themes and shared file, the stored `compiled` and `theme_refs` replaced when they differ, `page_changed` emitted, no version saved. A page that no longer compiles is left as it was and logged.

**Automations (§12, §13, 2026-10-10).** The `automations/*.ts` files and `AutomationApi` are gone; an automation is a fourth top-level declaration, `automation Name { … }`: a PascalCase name (a `type` token, like a page's) and zero or more handlers, no `state` and no nodes (E001 otherwise). One per file, and never inside a page or the shared components file (E001 either way). Its handlers are checked as server handlers, so E050 applies, worded for an automation ("runs on the server, where there is no `screen`"); a lambda's own parameter is readable there now (`any(entities, (e) => …)` was refused before). The grammar takes `else if`, and `else` may start the next line. Stored in `automations` / `automation_versions` (migration 011) with an `enabled` column the editor flips without a save; compiled on save with `automationOnly`, refreshed at start like pages; ids are `^[a-z][a-z0-9_]*$`, the web derives `hall_light` from `HallLight`. The runtime (`PageRuntime`, now taking both stores) registers `automation:<id>` beside `page:<id>`, and its `after` differs: in an automation a firing of any handler cancels every timer the automation has pending (a page's handler cancels only its own), a firing overtaken while a `call` is in flight arms nothing, every timer a firing armed is cancelled by the next (a set, not one slot), and a save whose handlers compile to the same JSON keeps the pending timers; a restart still drops them. Status is `running` / `stopped` (disabled) / `error` (an entity it names is gone, rechecked on `entity_added`/`entity_removed`/`entity_renamed`); a refused command or a thrown handler records the error without changing the status. Each registration keeps the last 20 runs in memory (when, which line, the trigger, each `call` with its refusal, the timers armed; a timer firing is a run of its own, `after 5m`). Requests: `get_automations` (every automation with its live status, then each page that has handlers, read-only), `get_automation_source`, `check_automation`, `save_automation`, `revert_automation`, `delete_automation`, `set_automation_enabled`, `get_automation_runs`; event `automation_changed`; `automation_changed` and `automation_status` go to admins only, and a member's list carries no error text. CLI `casita automation list|source|check|save|revert|delete|enable|disable|runs`. The web's Automations page lists them with a switch, Edit and Delete; "New automation" takes a name and a template (blank, motion light, schedule, follow another; `packages/web/src/automations.ts`), filled with entities picked from the house so the first save compiles, and opens `/automations/edit/:id`: the Casa editor with problems and handlers under the source and the recent runs on the right, polled while open.

```casa
automation HallLight {
  on binary_sensor.hall_motion changed {
    if binary_sensor.hall_motion.value == .On {
      call light.hall.turn_on
    } else if binary_sensor.hall_motion.available {
      after 5m { call light.hall.turn_off }
    }
  }
  at 22:30 { call light.hall.turn_on { brightness: 20% } }
}
```

**Derived sensors (2026-10-10).** A fifth declaration, `sensor`, not in the spec text above. It is a transformer: it names its inputs, an output type, and an expression over the inputs alone.

```casa
sensor KitchenDoor {
  input door = binary_sensor.kitchen_door
  input bolt = lock.exterior_kitchen_door
  name: "Kitchen door"
  type: String
  value: door.value == .On ? "Open" : bolt.value == .Unlocked ? "Unlocked" : "Secured"
}
```

- `input name = expr` binds an entity or a list of entities (E030 otherwise); the name follows the rules for state (so a domain word such as `lock` is refused).
- `name` and `unit` are string literals; `type` is `String`, `Number` or `Bool`; `class` is `.Temperature` etc. on a Number, `.Door` etc. on a Bool (E030 elsewhere). `name`, `type` and `value` are required (E033).
- `value` is checked against `type` and may read only the inputs: a bare entity, `entities`/`areas`/`devices`/`area.x`/`device.x`, `now`, and `ago`/`date`/`time`/`datetime` are E070, because the sensor is computed when an input changes, not as time passes.
- The domain is implied by the type: String and Number are a `sensor` (with `unit` and `deviceClass`), Bool a `binary_sensor` (with `deviceClass`). No `domain:`; multi-field states (climate, weather) would be a different feature.
- Stored and versioned like an automation (`sensors`, `sensor_versions`; `sensor_changed` on the bus), one per file (`sensorOnly`); refused inside a page or the shared components file (E001). The server (`casa/derived.ts`) registers it as an entity of the `casa.sensors` integration with the sensor's id as its slug, recomputes it on any input's `state_changed` and on registry changes, and makes it unavailable while an input is missing or unavailable, or when it is switched off. A Bool that evaluates to null is unavailable; a String or Number that does is `Unknown` (value null). Changing the type between words and yes/no replaces the entity (the domain is in the id). Status events reuse `automation_status` with the key `sensor:<id>`.
- `avg(list, fn)` and `sum(list, fn)` were added for it: the numbers the lambda picks, leaving out items that are absent or not numbers; `avg` of none is Null.
- API: `get_sensors`, `get_sensor_source`, `check_sensor`, `save_sensor`, `revert_sensor`, `delete_sensor`, `set_sensor_enabled` (admin-only but the list). CLI: `casita sensor …`. Web: a list under the automations with templates (door and lock, secure, average) and an editor whose right pane shows each input's reading and the value.

**Device ids are slugs (2026-10-10).** A device's id is a slug of the name it was discovered with, `thermostat` or `model_3`, `_2` and up on a collision, where it was a random `dev_3f9a1c2b7e4d`; so `device.<id>` reads as `area.<id>` does. Taken once and kept through a rename, as an area's is; an admin changes it (`newId` on `update_device`, the sheet's Device id field, `casita device set --id`), its entities and the devices behind it follow, and there is no alias: a source that named the old id is rechecked and gets E010 with the nearest id. The first start after the change moves every random id to a slug and rewrites `device.dev_…` in every stored page, automation and sensor source, versions included (`slugDeviceIds` in core `db/device-slugs.ts`), before the stores recompile.

**Integration actions (2026-11-01).** A sixth statement, `run <type>.<name>.<action> { arg: expr, … }`, runs an integration's action from a server handler (an automation, or a page's `on`). The instance id is written with `_` for the `-` in its type (`zwave-js.main` is `zwave_js.main`; `runName` in `check.ts`). `run` is not reserved: it is a statement only at a statement's start before a name, so a state or parameter may still be called `run`. The `Registry` gains `integrations` (every configured instance; each running one's actions with their parameters as JSON Schema, from `host.runnable()` on the server and the `get_integrations` rows in the editor); left unset, `run` is not checked. An unknown instance is E010 with a suggestion; an unknown action, an unknown argument (where the schema has `additionalProperties: false`) or a missing required one is E060; an instance that is not running resolves but its action and arguments are not checked. Argument types come from the schema: integer and number are `Number`, boolean `Bool`, array `List<…>`, and string `String | Device | Area | Entity`, a device, area or entity being sent as its id; anything else is checked when it runs. In a browser handler `run` is E050. It compiles to `["run", instanceId, action, args]`; `PageRuntime` calls `IntegrationHost.runAction`, and each run-log entry gains `actions` (`integrationId`, `action`, `params`, `error`), where a failure also sets the registration's error as a refused `call` does.

**Test runs and reference comparisons (2026-11-01).** `PageRuntime.test(key, {line?, pretend?})` runs one handler now, as if its trigger fired, logged with trigger `test` (or `test, pretending …`); a disabled automation keeps its handlers' firings unarmed but testable. `pretend` maps `entity.id` (its value, via `overridden`, which moved to core `casa/pretend.ts` and now covers weather) or `entity.id#attr` (one attribute) to a value, read through `pretending(host, …)` for that run only. Request `test_automation` (admin, audited); CLI `casita automation test <id> [--line n] [--pretend k=v]`; the editor's Test sheet. Comparing an `Entity` or `Attribute` with a Number, String, Bool, Duration or Time under `==`/`!=` is E030 ("an attribute is not its value, so this is never equal; compare `weather.home#x.value`"): it compared the reference itself and was never true.

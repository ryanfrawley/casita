// casa/headers.ts
// The headings Casita draws by default, written in Casa so a house can see how they are made
// and replace them: a component of the same name in the house's shared components file
// stands in for one on every page, and `header:` on one Area, Card or Section names another.
// They read the theme's `room`, `card` and `section` groups, which is how a theme reaches
// a heading; a custom one may read anything.

import type { ComponentDecl } from "./ast.ts";
import { Diagnostics } from "./diagnostics.ts";
import { parse } from "./parser.ts";

export const HEADERS_SOURCE = `// The headings every page draws unless a component of the same name replaces them.

// An area: its name, when given one, and nothing else. The icon and the area are passed so a
// house's own AreaHeader can draw them.
component AreaHeader(of: Area, name: String, icon: String) {
  Text { value: name  size: room.name.size  weight: room.name.weight
    font: room.name.font  color: room.name.color
    when: name != null && name != "" }
}

// A card: its icon in a box, in the card's accent when it is active, drawn in the ink that
// reads on that accent; its name, and under it the subtitle when the card has one.
component CardHeader(name: String, subtitle: String, icon: String, active: Bool, accent: Color,
    onAccent: Color) {
  Stack { direction: .Row  gap: space.md  align: .Center
    Icon { name: icon  size: card.icon.size  shape: card.icon.shape  border: card.icon.border
      padding: card.icon.padding
      background: active ? accent : card.icon.background
      color: active ? onAccent : text.muted }
    Stack { gap: 0
      Text { value: name  size: card.title.size  weight: card.title.weight
        font: card.title.font  color: card.title.color }
      Text { value: subtitle  size: card.subtitle.size  weight: card.subtitle.weight
        font: card.subtitle.font  color: card.subtitle.color
        when: subtitle != null && subtitle != "" }
    }
  }
}

// A section: its title.
component SectionHeader(title: String) {
  Text { value: title  size: section.title.size  weight: section.title.weight
    font: section.title.font  color: section.title.color }
}
`;

let parsed: ComponentDecl[] | undefined;

/** The bundled headings, parsed once; each is marked as Casita's own. */
export function bundledComponents(): ComponentDecl[] {
  if (!parsed) {
    const diagnostics = new Diagnostics();
    const file = parse(HEADERS_SOURCE, diagnostics);
    if (diagnostics.failed) {
      throw new Error(
        `the bundled headers do not parse: ${diagnostics.list.map((d) => d.message).join("; ")}`,
      );
    }
    parsed = file.components.map((decl) => ({ ...decl, origin: "bundled" as const }));
  }
  return parsed;
}

export const BUNDLED_COMPONENT_NAMES = ["AreaHeader", "CardHeader", "SectionHeader"];

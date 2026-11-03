import { expect, test } from "bun:test";
import {
  type Grant,
  type Level,
  type Role,
  resolveLevel,
  type ScopeKind,
  type SubjectKind,
} from "./permissions.ts";

const entity = { id: "lock.front_door", domain: "lock", areaId: "hall" };
const elsewhere = { id: "light.desk", domain: "light" };

let n = 0;
const grant = (subject: string, scope: string, level: Level): Grant => {
  const [subjectKind, subjectId] = subject.split(":") as [SubjectKind, string];
  const [scopeKind, scopeId] = scope.split(":") as [ScopeKind, string];
  return { id: `g${n++}`, subjectKind, subjectId, scopeKind, scopeId, level, createdAt: 0 };
};

const cases: [string, Role, Grant[], typeof entity | typeof elsewhere, Level][] = [
  ["admin default", "admin", [], entity, "control"],
  ["member default", "member", [], entity, "control"],
  ["guest default", "guest", [], entity, "none"],
  [
    "user entity grant",
    "guest",
    [grant("user:u1", "entity:lock.front_door", "control")],
    entity,
    "control",
  ],
  ["user area grant", "guest", [grant("user:u1", "area:hall", "control")], entity, "control"],
  ["user domain grant", "member", [grant("user:u1", "domain:lock", "none")], entity, "none"],
  [
    "role entity grant",
    "guest",
    [grant("role:guest", "entity:lock.front_door", "read")],
    entity,
    "read",
  ],
  ["role area grant", "guest", [grant("role:guest", "area:hall", "read")], entity, "read"],
  ["role domain grant", "guest", [grant("role:guest", "domain:lock", "read")], entity, "read"],
  [
    "user entity beats user area and domain",
    "member",
    [
      grant("user:u1", "domain:lock", "none"),
      grant("user:u1", "area:hall", "read"),
      grant("user:u1", "entity:lock.front_door", "control"),
    ],
    entity,
    "control",
  ],
  [
    "user area beats user domain",
    "member",
    [grant("user:u1", "domain:lock", "control"), grant("user:u1", "area:hall", "none")],
    entity,
    "none",
  ],
  [
    "any user grant beats any role grant",
    "guest",
    [
      grant("role:guest", "entity:lock.front_door", "control"),
      grant("user:u1", "domain:lock", "none"),
    ],
    entity,
    "none",
  ],
  [
    "role entity beats role area beats role domain",
    "guest",
    [
      grant("role:guest", "domain:lock", "none"),
      grant("role:guest", "area:hall", "read"),
      grant("role:guest", "entity:lock.front_door", "control"),
    ],
    entity,
    "control",
  ],
  [
    "another user's grant does not apply",
    "guest",
    [grant("user:u2", "entity:lock.front_door", "control")],
    entity,
    "none",
  ],
  [
    "another role's grant does not apply",
    "guest",
    [grant("role:member", "domain:lock", "read")],
    entity,
    "none",
  ],
  [
    "grants on other scopes do not apply",
    "guest",
    [grant("user:u1", "area:hall", "control")],
    elsewhere,
    "none",
  ],
  [
    "a grant can lower an admin",
    "admin",
    [grant("user:u1", "domain:lock", "read")],
    entity,
    "read",
  ],
  [
    "an entity without an area ignores area grants",
    "member",
    [grant("role:member", "area:hall", "none")],
    elsewhere,
    "control",
  ],
];

test.each(cases)("%s", (_name, role, grants, target, expected) => {
  expect(resolveLevel({ id: "u1", role }, grants, target)).toBe(expected);
});

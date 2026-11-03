import { describe, expect, test } from "bun:test";
import type { Row } from "@casita/client";
import {
  auditLine,
  displayNameError,
  grantsFor,
  ROLE_DEFAULT,
  ROLES,
  roleLabel,
  SCOPE_LABEL,
  scopeName,
  scopeOptions,
  userDraftErrors,
} from "./access.ts";
import { DOMAIN_LABEL } from "./model.ts";
import { EMPTY, type House } from "./store.ts";

// ───────── fixtures ─────────

const domainOf = (id: string) => id.split(".")[0] ?? "";

const entity = (id: string, extra: Row = {}): Row => ({
  id,
  name: id.split(".")[1] ?? id,
  domain: domainOf(id),
  integrationId: "zigbee2mqtt.main",
  uniqueId: `u-${id}`,
  capabilities: {},
  controllable: true,
  level: "control",
  ...extra,
});

const area = (id: string, name: string): Row => ({ id, name });

const houseOf = (parts: { entities?: Row[]; areas?: Row[] }): House => ({
  ...EMPTY,
  entities: parts.entities ?? [],
  areas: parts.areas ?? [],
});

const grant = (
  id: string,
  subjectKind: string,
  subjectId: string,
  scopeKind: string,
  scopeId: string,
): Row => ({ id, subjectKind, subjectId, scopeKind, scopeId, level: "read" });

const user = (id: string, username: string): Row => ({ id, username, role: "member" });

// ───────── roles and labels ─────────

describe("roleLabel", () => {
  test("capitalises the role's first letter", () => {
    expect(roleLabel("admin")).toBe("Admin");
    expect(roleLabel("member")).toBe("Member");
    expect(roleLabel("guest")).toBe("Guest");
  });

  test("leaves the rest of the word alone", () => {
    expect(roleLabel("superUser")).toBe("SuperUser");
  });

  test("gives an empty string for an empty role", () => {
    expect(roleLabel("")).toBe("");
  });
});

describe("ROLES", () => {
  test("lists admin, member, guest in that order", () => {
    expect([...ROLES]).toEqual(["admin", "member", "guest"]);
  });
});

describe("ROLE_DEFAULT", () => {
  test("has a sentence for each of the three roles", () => {
    expect(Object.keys(ROLE_DEFAULT).sort()).toEqual(["admin", "guest", "member"]);
    for (const role of ROLES) {
      const sentence = ROLE_DEFAULT[role] ?? "";
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence.endsWith(".")).toBe(true);
    }
  });
});

describe("SCOPE_LABEL", () => {
  test("labels entity, area and domain", () => {
    expect(SCOPE_LABEL).toEqual({ entity: "Entity", area: "Area", domain: "Domain" });
  });
});

// ───────── scopes ─────────

describe("scopeName", () => {
  const house = houseOf({
    entities: [entity("light.porch", { name: "Porch light" })],
    areas: [area("kitchen", "Kitchen")],
  });

  test("gives a domain's plural label", () => {
    expect(scopeName(house, "domain", "light")).toBe("Lights");
    expect(scopeName(house, "domain", "binary_sensor")).toBe("Binary sensors");
  });

  test("gives an unknown domain's own id", () => {
    expect(scopeName(house, "domain", "vacuum")).toBe("vacuum");
  });

  test("gives an area's name by id", () => {
    expect(scopeName(house, "area", "kitchen")).toBe("Kitchen");
  });

  test("gives an entity's name by id", () => {
    expect(scopeName(house, "entity", "light.porch")).toBe("Porch light");
  });

  test("gives the id itself when the area is gone", () => {
    expect(scopeName(house, "area", "attic")).toBe("attic");
  });

  test("gives the id itself when the entity is gone", () => {
    expect(scopeName(house, "entity", "light.gone")).toBe("light.gone");
  });

  test("does not look an area id up among entities, or the reverse", () => {
    const mixed = houseOf({
      entities: [entity("shared", { name: "An entity" })],
      areas: [area("shared", "An area")],
    });
    expect(scopeName(mixed, "area", "shared")).toBe("An area");
    expect(scopeName(mixed, "entity", "shared")).toBe("An entity");
  });
});

describe("scopeOptions", () => {
  describe("domain", () => {
    test("offers every known domain with its label and itself as icon", () => {
      const expected = Object.entries(DOMAIN_LABEL).map(([value, label]) => ({
        value,
        label,
        icon: value,
      }));
      expect(scopeOptions(EMPTY, "domain")).toEqual(expected);
    });

    test("includes light as Lights", () => {
      expect(scopeOptions(EMPTY, "domain")).toContainEqual({
        value: "light",
        label: "Lights",
        icon: "light",
      });
    });

    test("does not depend on what the house holds", () => {
      const house = houseOf({ entities: [entity("vacuum.robot")] });
      expect(scopeOptions(house, "domain")).toEqual(scopeOptions(EMPTY, "domain"));
    });
  });

  describe("area", () => {
    test("offers areas sorted by name with the id as value", () => {
      const house = houseOf({
        areas: [area("k", "Kitchen"), area("b", "Bedroom"), area("o", "Office")],
      });
      expect(scopeOptions(house, "area")).toEqual([
        { value: "b", label: "Bedroom" },
        { value: "k", label: "Kitchen" },
        { value: "o", label: "Office" },
      ]);
    });

    test("offers nothing when the house has no areas", () => {
      expect(scopeOptions(EMPTY, "area")).toEqual([]);
    });
  });

  describe("entity", () => {
    test("offers entities sorted by name, id as description, domain as icon", () => {
      const house = houseOf({
        entities: [
          entity("switch.fan", { name: "Fan" }),
          entity("light.porch", { name: "Porch" }),
          entity("lock.door", { name: "Back door" }),
        ],
      });
      expect(scopeOptions(house, "entity")).toEqual([
        { value: "lock.door", label: "Back door", description: "lock.door", icon: "lock" },
        { value: "switch.fan", label: "Fan", description: "switch.fan", icon: "switch" },
        { value: "light.porch", label: "Porch", description: "light.porch", icon: "light" },
      ]);
    });

    test("includes hidden entities", () => {
      const house = houseOf({
        entities: [entity("light.secret", { name: "Secret", hidden: true })],
      });
      expect(scopeOptions(house, "entity").map((option) => option.value)).toEqual(["light.secret"]);
    });

    test("offers nothing when the house has no entities", () => {
      expect(scopeOptions(EMPTY, "entity")).toEqual([]);
    });
  });
});

// ───────── grants ─────────

describe("grantsFor", () => {
  const grants: Row[] = [
    grant("g1", "user", "ann", "domain", "light"),
    grant("g2", "user", "ann", "entity", "switch.fan"),
    grant("g3", "user", "bob", "entity", "light.porch"),
    grant("g4", "user", "ann", "area", "kitchen"),
    grant("g5", "user", "ann", "entity", "light.porch"),
    grant("g6", "user", "ann", "area", "bedroom"),
    grant("g7", "role", "guest", "domain", "lock"),
    grant("g8", "user", "guest", "domain", "cover"),
  ];

  test("keeps only the given subject's grants", () => {
    const ids = grantsFor(grants, "user", "bob").map((row) => row.id);
    expect(ids).toEqual(["g3"]);
  });

  test("excludes the same id under the other subject kind", () => {
    expect(grantsFor(grants, "user", "guest").map((row) => row.id)).toEqual(["g8"]);
    expect(grantsFor(grants, "role", "guest").map((row) => row.id)).toEqual(["g7"]);
  });

  test("orders entity, then area, then domain, and by scope id within a kind", () => {
    const ids = grantsFor(grants, "user", "ann").map((row) => row.id);
    expect(ids).toEqual(["g5", "g2", "g6", "g4", "g1"]);
  });

  test("gives nothing for a subject without grants", () => {
    expect(grantsFor(grants, "user", "nobody")).toEqual([]);
    expect(grantsFor([], "role", "guest")).toEqual([]);
  });

  test("does not mutate its input", () => {
    const before = grants.map((row) => row.id);
    grantsFor(grants, "user", "ann");
    expect(grants.map((row) => row.id)).toEqual(before);
  });
});

// ───────── new user form ─────────

describe("displayNameError", () => {
  test("allows anything up to 80 characters, including nothing", () => {
    expect(displayNameError("")).toBeUndefined();
    expect(displayNameError("Mel R.")).toBeUndefined();
    expect(displayNameError("x".repeat(80))).toBeUndefined();
    expect(displayNameError("x".repeat(81))).toBe("At most 80 characters.");
  });
});

describe("userDraftErrors", () => {
  const good = { username: "ann", password: "12345678" };

  test("gives no errors for a valid draft", () => {
    expect(userDraftErrors(good)).toEqual({});
  });

  test("accepts letters, digits, dots, dashes and underscores after a letter or digit", () => {
    for (const username of ["Ann", "a", "7", "ann.smith", "ann-smith", "ann_smith", "a1.b-c_d"]) {
      expect(userDraftErrors({ ...good, username })).toEqual({});
    }
  });

  test("ignores surrounding spaces in the username", () => {
    expect(userDraftErrors({ ...good, username: "  ann  " })).toEqual({});
  });

  test("rejects an empty or blank username", () => {
    expect(userDraftErrors({ ...good, username: "" }).username).toBeString();
    expect(userDraftErrors({ ...good, username: "   " }).username).toBeString();
  });

  test("rejects a username that starts with a dot, dash or underscore", () => {
    for (const username of [".ann", "-ann", "_ann"]) {
      expect(userDraftErrors({ ...good, username }).username).toBeString();
    }
  });

  test("rejects a space inside the username", () => {
    expect(userDraftErrors({ ...good, username: "ann smith" }).username).toBeString();
  });

  test("rejects other characters such as a slash", () => {
    expect(userDraftErrors({ ...good, username: "a/b" }).username).toBeString();
    expect(userDraftErrors({ ...good, username: "ann@home" }).username).toBeString();
  });

  test("gives only a username error for a bad username", () => {
    expect(Object.keys(userDraftErrors({ ...good, username: "a/b" }))).toEqual(["username"]);
  });

  test("rejects a password under 8 characters", () => {
    expect(userDraftErrors({ ...good, password: "1234567" })).toEqual({
      password: "At least 8 characters.",
    });
    expect(userDraftErrors({ ...good, password: "" }).password).toBeString();
  });

  test("accepts a password of exactly 8 characters", () => {
    expect(userDraftErrors({ ...good, password: "abcdefgh" })).toEqual({});
  });

  test("gives both errors together", () => {
    expect(userDraftErrors({ username: ".x", password: "short" })).toEqual({
      username: "Letters, digits, dots, dashes and underscores.",
      password: "At least 8 characters.",
    });
  });
});

// ───────── audit log ─────────

describe("auditLine", () => {
  const users: Row[] = [user("u1", "ann"), user("u2", "bob")];

  describe("who", () => {
    test("is the actor's username when the actor is a known user", () => {
      expect(auditLine({ action: "logout", actorUserId: "u1" }, users).who).toBe("ann");
    });

    test("is Someone when the actor is unknown", () => {
      expect(auditLine({ action: "logout", actorUserId: "u9" }, users).who).toBe("Someone");
    });

    test("is Someone when there is no actor", () => {
      expect(auditLine({ action: "config_set", target: "units" }, users).who).toBe("Someone");
      expect(auditLine({ action: "logout", actorUserId: null }, users).who).toBe("Someone");
    });

    test("is the name that was tried for a failed sign-in, whose target is then empty", () => {
      const line = auditLine({ action: "login_failed", target: "mallory" }, users);
      expect(line).toEqual({ who: "mallory", what: "failed to sign in", target: "" });
    });

    test("is empty for a failed sign-in with no name tried", () => {
      expect(auditLine({ action: "login_failed" }, users)).toEqual({
        who: "",
        what: "failed to sign in",
        target: "",
      });
    });
  });

  describe("what", () => {
    const phrases: [string, string][] = [
      ["login", "signed in"],
      ["login_failed", "failed to sign in"],
      ["logout", "signed out"],
      ["user_created", "added the user"],
      ["user_updated", "changed the user"],
      ["user_deleted", "removed the user"],
      ["grant_set", "set a grant"],
      ["grant_deleted", "removed a grant"],
      ["token_created", "made an API token"],
      ["token_revoked", "revoked an API token"],
      ["config_set", "set the config at"],
    ];

    for (const [action, phrase] of phrases) {
      test(`words ${action} as "${phrase}"`, () => {
        expect(auditLine({ action, actorUserId: "u1" }, users).what).toBe(phrase);
      });
    }

    test("gives an unknown action's name with underscores as spaces", () => {
      expect(auditLine({ action: "backup_made_now" }, users).what).toBe("backup made now");
      expect(auditLine({ action: "reboot" }, users).what).toBe("reboot");
    });
  });

  describe("target", () => {
    test("is a user's username when the target is a user id", () => {
      const line = auditLine({ action: "user_updated", actorUserId: "u1", target: "u2" }, users);
      expect(line).toEqual({ who: "ann", what: "changed the user", target: "bob" });
    });

    test("is the raw target otherwise, such as a config path", () => {
      const line = auditLine(
        { action: "config_set", actorUserId: "u1", target: "integrations.mqtt.host" },
        users,
      );
      expect(line.target).toBe("integrations.mqtt.host");
    });

    test("is the raw target for a grant id", () => {
      expect(auditLine({ action: "grant_deleted", target: "g42" }, users).target).toBe("g42");
    });

    test("is the raw id for a user that is gone", () => {
      expect(auditLine({ action: "user_deleted", target: "u9" }, users).target).toBe("u9");
    });

    test("is empty when absent or null", () => {
      expect(auditLine({ action: "login", actorUserId: "u1" }, users).target).toBe("");
      expect(auditLine({ action: "login", actorUserId: "u1", target: null }, users).target).toBe(
        "",
      );
    });
  });
});

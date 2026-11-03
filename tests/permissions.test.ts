import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { addUser, BOOTSTRAP_TOKEN, boot, codeOf, type Harness, record } from "./harness.ts";

let h: Harness;
let admin: CasitaClient;
beforeEach(async () => {
  h = await boot();
  const bootstrap = await h.connect();
  // Creating the first admin retires the bootstrap token, so continue as that admin.
  const root = await addUser(h, bootstrap, "root", "admin");
  admin = await h.connect(root.token);
});
afterEach(() => h.stop());

type Row = Record<string, unknown>;
const ids = (rows: unknown) => (rows as Row[]).map((r) => r.entityId ?? r.id).sort();
const unlock = { domain: "lock", action: "unlock" } as const;
const lightOn = { domain: "light", action: "turn_on" } as const;

test("the bootstrap token stops working once an admin exists", async () => {
  expect(await codeOf(h.connect(BOOTSTRAP_TOKEN))).toBe("auth");
  const schema = await fetch(`${h.url}/api/schema`, {
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  expect(schema.status).toBe(401);
});

test("the first user must be an admin", async () => {
  const fresh = await boot();
  try {
    const bootstrap = await fresh.connect();
    const create = bootstrap.request("create_user", {
      username: "kid",
      password: "kid-password",
      role: "guest",
    });
    await expect(create).rejects.toThrow("The first user must be an admin");
    expect(await bootstrap.request("get_me", {})).toMatchObject({
      user: { id: "bootstrap", role: "admin" },
    });
  } finally {
    await fresh.stop();
  }
});

test("a guest sees no ungranted entity in get_states, get_entities, get_devices, or subscribe", async () => {
  const guest = await h.connect((await addUser(h, admin, "gus", "guest")).token);
  expect(await guest.request("get_states", {})).toEqual([]);
  expect(await guest.request("get_entities", {})).toEqual([]);
  expect(await guest.request("get_devices", {})).toEqual([]);
  expect(await codeOf(guest.request("get_states", { entityIds: ["light.desk"] }))).toBe(
    "not_found",
  );
  expect(await guest.request("get_status", {})).toMatchObject({ entities: 0, devices: 0 });
  // An entity the guest cannot see is indistinguishable from one that does not exist.
  expect(
    await codeOf(guest.request("send_command", { entityId: "light.desk", command: lightOn })),
  ).toBe("not_found");

  const seen = record(guest);
  await guest.request("subscribe", {});
  await seen.until(() => seen.snapshots.length === 1);
  expect(seen.snapshots[0]?.states).toEqual([]);
  await admin.request("send_command", { entityId: "light.desk", command: lightOn, confirm: true });
  await guest.request("ping", {});
  expect(seen.events).toEqual([]);
});

test("a role grant applies to every user with that role, live", async () => {
  const one = await h.connect((await addUser(h, admin, "gus", "guest")).token);
  const two = await h.connect((await addUser(h, admin, "gil", "guest")).token);
  const seen = record(one);
  await one.request("subscribe", { events: ["state_changed"] });
  await seen.until(() => seen.snapshots.length === 1);

  const grant = (await admin.request("set_grant", {
    subjectKind: "role",
    subjectId: "guest",
    scopeKind: "domain",
    scopeId: "sensor",
    level: "read",
  })) as { id: string };
  for (const guest of [one, two]) {
    expect(ids(await guest.request("get_states", {}))).toEqual(["sensor.porch_temperature"]);
  }

  // The open subscription picks the grant up without resubscribing.
  await admin.request("integration_action", {
    integrationId: "fixture.main",
    action: "set_temperature",
    params: { value: 30 },
  });
  await seen.until(() => seen.events.length === 1);
  expect(seen.events[0]).toMatchObject({
    entityId: "sensor.porch_temperature",
    new: { state: { value: 30 } },
  });

  // And loses access without notice when the grant goes away.
  await admin.request("delete_grant", { grantId: grant.id });
  await admin.request("integration_action", {
    integrationId: "fixture.main",
    action: "set_temperature",
    params: { value: 31 },
  });
  await one.request("ping", {});
  expect(seen.events).toHaveLength(1);
  expect(await two.request("get_states", {})).toEqual([]);
});

test("a guest granted control on one area can use that room and nothing else", async () => {
  const gus = await addUser(h, admin, "gus", "guest");
  const guest = await h.connect(gus.token);
  const area = (await admin.request("create_area", { name: "Office" })) as { id: string };
  await admin.request("update_entity", { entityId: "light.desk", areaId: area.id });
  await admin.request("set_grant", {
    subjectKind: "user",
    subjectId: gus.id,
    scopeKind: "area",
    scopeId: area.id,
    level: "control",
  });

  expect(ids(await guest.request("get_entities", {}))).toEqual(["light.desk"]);
  expect(ids(await guest.request("get_devices", {}))).toHaveLength(1);
  expect(
    await guest.request("send_command", { entityId: "light.desk", command: lightOn }),
  ).toMatchObject({ status: "sent" });
  expect(
    await codeOf(guest.request("send_command", { entityId: "lock.front_door", command: unlock })),
  ).toBe("not_found");

  // Moving the entity out of the area revokes access.
  await admin.request("update_entity", { entityId: "light.desk", areaId: null });
  expect(await guest.request("get_entities", {})).toEqual([]);
});

test("read is not control", async () => {
  const gus = await addUser(h, admin, "gus", "guest");
  const guest = await h.connect(gus.token);
  await admin.request("set_grant", {
    subjectKind: "user",
    subjectId: gus.id,
    scopeKind: "entity",
    scopeId: "light.desk",
    level: "read",
  });
  expect(ids(await guest.request("get_states", {}))).toEqual(["light.desk"]);
  expect(
    await codeOf(guest.request("send_command", { entityId: "light.desk", command: lightOn })),
  ).toBe("forbidden");
});

test("a member denied the lock domain gets forbidden on unlock and still controls lights", async () => {
  const mel = await addUser(h, admin, "mel", "member");
  const member = await h.connect(mel.token);
  expect(
    await member.request("send_command", { entityId: "lock.front_door", command: unlock }),
  ).toMatchObject({ status: "sent" });

  await admin.request("set_grant", {
    subjectKind: "user",
    subjectId: mel.id,
    scopeKind: "domain",
    scopeId: "lock",
    level: "read",
  });
  expect(
    await codeOf(member.request("send_command", { entityId: "lock.front_door", command: unlock })),
  ).toBe("forbidden");
  expect(
    await member.request("send_command", { entityId: "light.desk", command: lightOn }),
  ).toMatchObject({ status: "sent" });

  // Commands carry the acting user.
  const seen = record(admin);
  await admin.request("subscribe", { events: ["command_issued"] });
  await seen.until(() => seen.snapshots.length === 1);
  await member.request("send_command", { entityId: "light.desk", command: lightOn });
  await seen.until(() => seen.events.length === 1);
  expect(seen.events[0]).toMatchObject({
    source: { kind: "user", userId: mel.id, sessionId: expect.any(String) },
  });
});

test("every admin-only request type rejects a member with no detail", async () => {
  const member = await h.connect((await addUser(h, admin, "mel", "member")).token);
  const adminOnly: [string, Row][] = [
    ["list_users", {}],
    ["create_user", { username: "x", password: "x-password", role: "guest" }],
    ["update_user", { userId: "nope", role: "admin" }],
    ["delete_user", { userId: "nope" }],
    ["list_grants", {}],
    [
      "set_grant",
      {
        subjectKind: "role",
        subjectId: "member",
        scopeKind: "domain",
        scopeId: "lock",
        level: "control",
      },
    ],
    ["delete_grant", { grantId: "nope" }],
    ["get_config", {}],
    ["set_config", { path: "server.port", value: 1 }],
    ["reload_integration", { integrationId: "fixture.main" }],
    [
      "integration_action",
      { integrationId: "fixture.main", action: "set_temperature", params: { value: 1 } },
    ],
    ["update_entity", { entityId: "light.desk", hidden: true }],
    ["update_device", { deviceId: "nope", name: "x" }],
    ["delete_entity", { entityId: "nope" }],
    ["delete_device", { deviceId: "nope" }],
    ["get_device_settings", { deviceId: "nope" }],
    ["set_device_setting", { deviceId: "nope", key: "1", value: 1 }],
    ["create_area", { name: "x" }],
    ["update_area", { areaId: "nope", name: "x" }],
    ["delete_area", { areaId: "nope" }],
    ["get_page_source", { pageId: "home" }],
    ["check_page", { pageId: "home", source: "" }],
    ["save_page", { pageId: "home", source: "" }],
    ["revert_page", { pageId: "home", version: 1 }],
    ["save_theme", { themeId: "dusk", source: "" }],
    ["get_audit", {}],
    ["backup", {}],
    ["get_automation_source", { automationId: "x" }],
    ["check_automation", { source: "" }],
    ["save_automation", { automationId: "x", source: "" }],
    ["revert_automation", { automationId: "x", version: 1 }],
    ["delete_automation", { automationId: "x" }],
    ["set_automation_enabled", { automationId: "x", enabled: false }],
    ["get_automation_runs", { automationId: "x" }],
    ["test_automation", { automationId: "x" }],
    ["get_sensor_source", { sensorId: "x" }],
    ["check_sensor", { source: "" }],
    ["save_sensor", { sensorId: "x", source: "" }],
    ["revert_sensor", { sensorId: "x", version: 1 }],
    ["delete_sensor", { sensorId: "x" }],
    ["set_sensor_enabled", { sensorId: "x", enabled: false }],
  ];
  for (const [type, params] of adminOnly) {
    const attempt = member.request(type as "ping", params as never);
    await expect(attempt, type).rejects.toMatchObject({
      code: "forbidden",
      message: "Not permitted",
    });
  }
  // Other users' tokens and sessions are admin-only too.
  expect(await codeOf(member.request("list_tokens", { userId: "someone-else" }))).toBe("forbidden");
  expect(await codeOf(member.request("create_token", { name: "x", userId: "someone-else" }))).toBe(
    "forbidden",
  );
  expect(await codeOf(member.request("revoke_token", { tokenId: "tok_other" }))).toBe("forbidden");
  expect(await codeOf(member.request("revoke_session", { sessionId: "ses_other" }))).toBe(
    "forbidden",
  );
  // Non-admins do not see config schemas.
  expect(
    ((await member.request("get_integrations", {})) as Row[])[0]?.configSchema,
  ).toBeUndefined();
});

test("a member cannot rename a device, and the id they asked to take stays free", async () => {
  const member = await h.connect((await addUser(h, admin, "mel", "member")).token);
  const attempt = member.request("update_device", { deviceId: "fixture_hub", newId: "hub" });
  await expect(attempt).rejects.toMatchObject({ code: "forbidden", message: "Not permitted" });
  expect(ids(await admin.request("get_devices", {}))).toEqual(["fixture_hub"]);
  expect(
    await admin.request("update_device", { deviceId: "fixture_hub", newId: "hub" }),
  ).toMatchObject({ id: "hub" });
});

test("login: same error for unknown user and wrong password, and a rate limit", async () => {
  const wrong = await h.login("root", "not-the-password");
  const unknown = await h.login("nobody", "not-the-password");
  expect([wrong.status, unknown.status]).toEqual([401, 401]);
  expect(await wrong.json()).toEqual(await unknown.json());

  // beforeEach logged in once; with the two above, two attempts remain this minute.
  expect((await h.login("root", "root-password")).status).toBe(200);
  expect((await h.login("root", "root-password")).status).toBe(200);
  const limited = await h.login("root", "root-password");
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });

  const audit = (await admin.request("get_audit", {})) as Row[];
  expect(
    audit
      .filter((a) => a.action === "login_failed")
      .map((a) => a.target)
      .sort(),
  ).toEqual(["nobody", "root"]);
});

test("an expired session is refused, on new and on open connections", async () => {
  const mel = await addUser(h, admin, "mel", "member");
  const member = await h.connect(mel.token);
  const db = new Database(h.dbPath);
  db.query("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(Date.now() - 1, mel.id);
  db.close();

  expect(await codeOf(h.connect(mel.token))).toBe("auth");
  expect(await codeOf(member.request("ping", {}))).toBe("connection");
});

test("a revoked API token is refused within one second", async () => {
  const created = (await admin.request("create_token", { name: "script" })) as {
    id: string;
    token: string;
  };
  expect(created.token).toStartWith("casita_");
  expect(await admin.request("list_tokens", {})).toMatchObject([
    { id: created.id, name: "script", kind: "api" },
  ]);
  expect(JSON.stringify(await admin.request("list_tokens", {}))).not.toContain(created.token);

  const script = await h.connect(created.token);
  const closed = new Promise<number>((resolve) => script.onClose(resolve));
  const started = Date.now();
  await admin.request("revoke_token", { tokenId: created.id });
  expect(await closed).toBe(4401);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(await codeOf(h.connect(created.token))).toBe("auth");
});

test("anyone can change their own display name with update_me, and only their own", async () => {
  const mel = await addUser(h, admin, "mel", "member");
  const member = await h.connect(mel.token);
  expect(await member.request("update_me", { displayName: "  Mel R.  " })).toMatchObject({
    id: mel.id,
    displayName: "Mel R.",
  });
  expect(await member.request("get_me", {})).toMatchObject({ user: { displayName: "Mel R." } });
  expect(await admin.request("list_users", {})).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: mel.id, displayName: "Mel R." })]),
  );
  // Clearing it falls back to the username in anything that shows a name.
  expect(await member.request("update_me", { displayName: "" })).toMatchObject({
    displayName: "",
  });
  expect(await codeOf(member.request("update_me", { displayName: "x".repeat(81) }))).toBe(
    "bad_request",
  );
  // There is no way to name another user through it.
  expect(
    await codeOf(member.request("update_me", { userId: "nope", displayName: "Nope" } as never)),
  ).toBe("bad_request");
});

test("disabling a user or resetting their password ends their sessions; role changes apply live", async () => {
  const mel = await addUser(h, admin, "mel", "member");
  const member = await h.connect(mel.token);
  await admin.request("update_user", { userId: mel.id, role: "guest" });
  expect(await member.request("get_states", {})).toEqual([]);
  expect(await member.request("get_me", {})).toMatchObject({ user: { role: "guest" } });

  const closed = new Promise<number>((resolve) => member.onClose(resolve));
  await admin.request("update_user", { userId: mel.id, disabled: true });
  expect(await closed).toBe(4401);
  expect((await h.login("mel", mel.password)).status).toBe(401);
});

test("the last enabled admin cannot be removed, demoted, or disabled", async () => {
  const [root] = (await admin.request("list_users", {})) as { id: string }[];
  const userId = root?.id ?? "";
  const attempts = [
    () => admin.request("delete_user", { userId }),
    () => admin.request("update_user", { userId, role: "member" }),
    () => admin.request("update_user", { userId, disabled: true }),
  ];
  for (const attempt of attempts) {
    await expect(attempt()).rejects.toThrow("At least one enabled admin must remain");
  }
});

test("logout ends the session; the audit log records who did what", async () => {
  const mel = await addUser(h, admin, "mel", "member");
  const logout = await fetch(`${h.url}/api/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${mel.token}` },
  });
  expect(logout.status).toBe(200);
  expect(await codeOf(h.connect(mel.token))).toBe("auth");

  const audit = (await admin.request("get_audit", {})) as Row[];
  expect(audit.map((a) => a.action).reverse()).toEqual([
    "user_created",
    "login",
    "user_created",
    "login",
    "logout",
  ]);
  expect(audit.find((a) => a.action === "user_created" && a.target === mel.id)).toMatchObject({
    detail: { username: "mel", role: "member" },
    ip: expect.any(String),
  });
});

test("cli: login stores a session, whoami and user/grant/token commands work, logout clears it", async () => {
  const env = { CASITA_TOKEN: "", CASITA_PASSWORD: "root-password" };
  expect(await h.cli(["login", "--username", "root"], env)).toMatchObject({
    code: 0,
    stdout: "Logged in as root\n",
  });
  expect((await h.cli(["whoami"], env)).stdout).toBe("root (admin)\n");

  expect(
    (
      await h.cli(["user", "create", "Gus", "--role", "guest"], {
        ...env,
        CASITA_PASSWORD: "gus-password",
      })
    ).stdout,
  ).toBe("Created gus (guest)\n");
  expect((await h.cli(["grant", "set", "gus", "domain:sensor", "read"], env)).code).toBe(0);
  expect(
    (await h.cli(["grant", "set", "role:guest", "entity:light.desk", "control"], env)).code,
  ).toBe(0);
  const grants = await h.cli(["grant", "list", "--user", "gus"], env);
  expect(grants.stdout).toMatch(/user:usr_\w+ +domain:sensor +read/);
  expect(grants.stdout).not.toContain("role:guest");

  const token = await h.cli(["token", "create", "--name", "ci"], env);
  expect(token.stdout).toMatch(/^casita_[\w-]+\n$/);
  expect((await h.cli(["whoami"], { CASITA_TOKEN: token.stdout.trim() })).stdout).toBe(
    "root (admin)\n",
  );
  expect((await h.cli(["audit", "--since", "1h"], env)).stdout).toContain("token_created");

  const wrong = await h.cli(["login", "--username", "root"], {
    CASITA_TOKEN: "",
    CASITA_PASSWORD: "nope-nope",
  });
  expect(wrong).toMatchObject({ code: 1, stderr: "error [auth]: Invalid username or password\n" });

  expect((await h.cli(["logout"], env)).stdout).toBe("Logged out\n");
  expect((await h.cli(["whoami"], env)).code).toBe(2);
});

test("get_entities tells each user what they may do with each entity", async () => {
  const guest = await addUser(h, admin, "vi", "guest");
  await admin.request("set_grant", {
    subjectKind: "user",
    subjectId: guest.id,
    scopeKind: "entity",
    scopeId: "light.desk",
    level: "read",
  });
  await admin.request("set_grant", {
    subjectKind: "user",
    subjectId: guest.id,
    scopeKind: "entity",
    scopeId: "lock.front_door",
    level: "control",
  });
  const levels = async (client: Awaited<ReturnType<Harness["connect"]>>) =>
    Object.fromEntries(
      ((await client.request("get_entities", {})) as { id: string; level: string }[]).map((e) => [
        e.id,
        e.level,
      ]),
    );
  // An entity with no grant is absent, never listed as "none".
  expect(await levels(await h.connect(guest.token))).toEqual({
    "light.desk": "read",
    "lock.front_door": "control",
  });
  expect(new Set(Object.values(await levels(admin)))).toEqual(new Set(["control"]));
});

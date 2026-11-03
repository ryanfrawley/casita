// Argon2 hashing is slow (~100ms per hash or verify): only the tests that are about passwords
// set one. Every other user is created without a password, which skips hashing.

import { expect, test } from "bun:test";
import { openDatabase } from "@casita/core";
import { Auth, type AuthChange, BOOTSTRAP_USER_ID, SESSION_TTL_MS } from "./auth.ts";
import type { Role } from "./permissions.ts";

const PASSWORD = "correct horse";

async function setup(bootstrapToken?: string) {
  const clock = { now: 1_000_000 };
  const db = await openDatabase(":memory:");
  const auth = new Auth({
    db,
    now: () => clock.now,
    ...(bootstrapToken === undefined ? {} : { bootstrapToken }),
  });
  const changes: AuthChange[] = [];
  auth.onChange((change) => changes.push(change));
  return { clock, db, auth, changes };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** An admin first (the first user must be one), then the user under test. */
async function withAdmin(ctx: Ctx, username = "admin") {
  return ctx.auth.createUser({ username, role: "admin" });
}

const user = (ctx: Ctx, username: string, role: Role = "member") =>
  ctx.auth.createUser({ username, role });

// ───────── bootstrap ─────────

test("the bootstrap token is an admin credential while no user exists", async () => {
  const ctx = await setup("boot-secret");
  expect(ctx.auth.hasUsers()).toBe(false);
  expect(ctx.auth.bootstrapTokenIsStale()).toBe(false);

  const principal = ctx.auth.authenticate("boot-secret");
  expect(principal).toEqual({
    sessionId: BOOTSTRAP_USER_ID,
    user: expect.objectContaining({ id: BOOTSTRAP_USER_ID, role: "admin", disabled: false }),
  });
  expect(ctx.auth.isSessionValid(BOOTSTRAP_USER_ID)).toBe(true);
  expect(ctx.auth.getUser(BOOTSTRAP_USER_ID)?.role).toBe("admin");
  expect(ctx.auth.authenticate("wrong")).toBeNull();
});

test("the bootstrap token stops working once a user exists", async () => {
  const ctx = await setup("boot-secret");
  await withAdmin(ctx);
  expect(ctx.auth.authenticate("boot-secret")).toBeNull();
  expect(ctx.auth.isSessionValid(BOOTSTRAP_USER_ID)).toBe(false);
  expect(ctx.auth.getUser(BOOTSTRAP_USER_ID)).toBeUndefined();
  expect(ctx.auth.bootstrapTokenIsStale()).toBe(true);
});

test("without a bootstrap token nothing authenticates on an empty database", async () => {
  const ctx = await setup();
  expect(ctx.auth.authenticate("")).toBeNull();
  expect(ctx.auth.authenticate("anything")).toBeNull();
  await withAdmin(ctx);
  expect(ctx.auth.bootstrapTokenIsStale()).toBe(false);
});

test("an empty bootstrap token is not honored", async () => {
  const ctx = await setup("");
  expect(ctx.auth.authenticate("")).toBeNull();
});

test("the bootstrap user cannot be given tokens", async () => {
  const ctx = await setup("boot-secret");
  expect(() => ctx.auth.issueToken(BOOTSTRAP_USER_ID, "api")).toThrow("Unknown user bootstrap");
});

// ───────── creating users ─────────

test("the first user must be an admin", async () => {
  const ctx = await setup();
  await expect(user(ctx, "member1")).rejects.toThrow("The first user must be an admin");
  expect(ctx.auth.hasUsers()).toBe(false);
  await withAdmin(ctx);
  expect((await user(ctx, "member1")).role).toBe("member");
  expect((await user(ctx, "guest1", "guest")).role).toBe("guest");
});

test("usernames are lowercased, and the display name defaults to the username", async () => {
  const ctx = await setup();
  const created = await ctx.auth.createUser({ username: "Alice.Smith", role: "admin" });
  expect(created).toMatchObject({
    username: "alice.smith",
    displayName: "alice.smith",
    role: "admin",
    disabled: false,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
  });
  expect(ctx.auth.getUserByUsername("alice.smith")?.id).toBe(created.id);
  expect(ctx.auth.getUser(created.id)).toEqual(created);
});

test("an explicit display name is kept", async () => {
  const ctx = await setup();
  const created = await ctx.auth.createUser({
    username: "al",
    displayName: "Alice S.",
    role: "admin",
  });
  expect(created.displayName).toBe("Alice S.");
});

test.each([[""], ["has space"], ["a/b"], ["ünïcode"], ["a@b"], ["x".repeat(65)]])(
  "username %p is rejected",
  async (username) => {
    const ctx = await setup();
    await expect(ctx.auth.createUser({ username, role: "admin" })).rejects.toThrow(
      "Usernames use lowercase letters, digits, and . _ -",
    );
  },
);

test("usernames of 1 to 64 of [a-z0-9_.-] are accepted", async () => {
  const ctx = await setup();
  await withAdmin(ctx, "x".repeat(64));
  await user(ctx, "a");
  await user(ctx, "a_b.c-1");
  expect(ctx.auth.listUsers()).toHaveLength(3);
});

test("a duplicate username is rejected, regardless of case", async () => {
  const ctx = await setup();
  await withAdmin(ctx, "alice");
  await expect(user(ctx, "alice")).rejects.toThrow("User alice already exists");
  await expect(user(ctx, "ALICE")).rejects.toThrow("User alice already exists");
});

test("listUsers is ordered by username", async () => {
  const ctx = await setup();
  await withAdmin(ctx, "carol");
  await user(ctx, "alice");
  await user(ctx, "bob");
  expect(ctx.auth.listUsers().map((u) => u.username)).toEqual(["alice", "bob", "carol"]);
});

test("a password under 8 characters is rejected and no user is created", async () => {
  const ctx = await setup();
  await expect(
    ctx.auth.createUser({ username: "admin", password: "1234567", role: "admin" }),
  ).rejects.toThrow("Passwords need at least 8 characters");
  expect(ctx.auth.hasUsers()).toBe(false);
});

// ───────── login ─────────

test("login is case-insensitive on username and issues a working session token", async () => {
  const ctx = await setup();
  const admin = await ctx.auth.createUser({ username: "alice", password: PASSWORD, role: "admin" });
  const result = await ctx.auth.login("ALICE", PASSWORD);
  expect(result?.user).toEqual(admin);
  const principal = ctx.auth.authenticate(result?.token ?? "");
  expect(principal?.user.id).toBe(admin.id);
  expect(ctx.auth.getSession(principal?.sessionId ?? "")?.kind).toBe("session");
});

test("login returns null for an unknown user, a wrong password, or a user with no password", async () => {
  const ctx = await setup();
  await ctx.auth.createUser({ username: "alice", password: PASSWORD, role: "admin" });
  await user(ctx, "nopass");
  expect(await ctx.auth.login("alice", "wrong password")).toBeNull();
  expect(await ctx.auth.login("nobody", PASSWORD)).toBeNull();
  expect(await ctx.auth.login("nopass", PASSWORD)).toBeNull();
  expect(await ctx.auth.login("nopass", "")).toBeNull();
});

test("login returns null for a disabled user with the right password", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await ctx.auth.createUser({ username: "bob", password: PASSWORD, role: "member" });
  await ctx.auth.updateUser(bob.id, { disabled: true });
  expect(await ctx.auth.login("bob", PASSWORD)).toBeNull();
});

test("a new password replaces the old one and revokes every session and token", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await ctx.auth.createUser({ username: "bob", password: PASSWORD, role: "member" });
  const session = ctx.auth.issueToken(bob.id, "session");
  const api = ctx.auth.issueToken(bob.id, "api");
  ctx.changes.length = 0;

  await ctx.auth.updateUser(bob.id, { password: "new password!" });

  expect(ctx.auth.authenticate(session.token)).toBeNull();
  expect(ctx.auth.authenticate(api.token)).toBeNull();
  expect(ctx.auth.listSessions(bob.id)).toEqual([]);
  expect(ctx.changes).toEqual([
    { kind: "session_revoked", sessionId: session.session.id },
    { kind: "session_revoked", sessionId: api.session.id },
    { kind: "user", userId: bob.id },
  ]);
  expect(await ctx.auth.login("bob", PASSWORD)).toBeNull();
  expect(await ctx.auth.login("bob", "new password!")).not.toBeNull();
});

test("a too-short new password is rejected and changes nothing", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  const { token } = ctx.auth.issueToken(bob.id, "session");
  await expect(
    ctx.auth.updateUser(bob.id, { password: "short", displayName: "Bobby" }),
  ).rejects.toThrow("Passwords need at least 8 characters");
  expect(ctx.auth.getUser(bob.id)?.displayName).toBe("bob");
  expect(ctx.auth.authenticate(token)).not.toBeNull();
});

// ───────── sessions and tokens ─────────

test("a session expires exactly SESSION_TTL_MS after it was issued if never used", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const start = ctx.clock.now;
  const { token, session } = ctx.auth.issueToken(admin.id, "session");
  expect(session).toMatchObject({
    kind: "session",
    expiresAt: start + SESSION_TTL_MS,
    createdAt: start,
  });

  ctx.clock.now = start + SESSION_TTL_MS - 1;
  expect(ctx.auth.isSessionValid(session.id)).toBe(true);

  ctx.clock.now = start + SESSION_TTL_MS;
  expect(ctx.auth.isSessionValid(session.id)).toBe(false);
  expect(ctx.auth.authenticate(token)).toBeNull();
});

test("using a session slides its expiry forward", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const start = ctx.clock.now;
  const { token, session } = ctx.auth.issueToken(admin.id, "session");

  const usedAt = start + SESSION_TTL_MS - 1000;
  ctx.clock.now = usedAt;
  expect(ctx.auth.authenticate(token)).not.toBeNull();
  expect(ctx.auth.getSession(session.id)).toMatchObject({
    lastUsedAt: usedAt,
    expiresAt: usedAt + SESSION_TTL_MS,
  });

  // Past the original expiry, still valid.
  ctx.clock.now = start + SESSION_TTL_MS + 1000;
  expect(ctx.auth.authenticate(token)).not.toBeNull();

  // But it does expire SESSION_TTL_MS after the last use that touched it.
  ctx.clock.now = ctx.auth.getSession(session.id)?.expiresAt ?? 0;
  expect(ctx.auth.authenticate(token)).toBeNull();
});

test("last_used_at is rewritten at most once a minute", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const { token, session } = ctx.auth.issueToken(admin.id, "session");
  const first = ctx.clock.now;
  ctx.auth.authenticate(token);
  expect(ctx.auth.getSession(session.id)?.lastUsedAt).toBe(first);

  ctx.clock.now = first + 59_999;
  ctx.auth.authenticate(token);
  expect(ctx.auth.getSession(session.id)?.lastUsedAt).toBe(first);

  ctx.clock.now = first + 60_000;
  ctx.auth.authenticate(token);
  expect(ctx.auth.getSession(session.id)).toMatchObject({
    lastUsedAt: first + 60_000,
    expiresAt: first + 60_000 + SESSION_TTL_MS,
  });
});

test("API tokens never expire", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const { token, session } = ctx.auth.issueToken(admin.id, "api", "ci");
  expect(session).toMatchObject({ kind: "api", name: "ci" });
  expect(session.expiresAt).toBeUndefined();

  ctx.clock.now += 10 * SESSION_TTL_MS;
  expect(ctx.auth.authenticate(token)?.user.id).toBe(admin.id);
  expect(ctx.auth.isSessionValid(session.id)).toBe(true);
  expect(ctx.auth.getSession(session.id)?.expiresAt).toBeUndefined();
});

test("only a SHA-256 of the token is stored", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const { token, session } = ctx.auth.issueToken(admin.id, "api", "ci");
  expect(token).toStartWith("casita_");

  const rows = ctx.db.query<Record<string, unknown>, []>("SELECT * FROM sessions").all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(session.id);
  expect(rows[0]?.token_hash).toBe(new Bun.CryptoHasher("sha256").update(token).digest("hex"));
  expect(JSON.stringify(rows)).not.toContain(token);
  expect(JSON.stringify(rows)).not.toContain(token.slice(4));
});

test("each issued token is distinct", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const a = ctx.auth.issueToken(admin.id, "session");
  const b = ctx.auth.issueToken(admin.id, "session");
  expect(a.token).not.toBe(b.token);
  expect(a.session.id).not.toBe(b.session.id);
  expect(ctx.auth.authenticate(a.token)?.sessionId).toBe(a.session.id);
  expect(ctx.auth.authenticate(b.token)?.sessionId).toBe(b.session.id);
});

test("an unknown token does not authenticate", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  expect(ctx.auth.authenticate("casita_unknown")).toBeNull();
  expect(ctx.auth.isSessionValid("ses_unknown")).toBe(false);
});

test("issuing a token for an unknown user throws", async () => {
  const ctx = await setup();
  expect(() => ctx.auth.issueToken("usr_missing", "api")).toThrow("Unknown user usr_missing");
});

test("listSessions filters by user and kind, oldest first", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  const s1 = ctx.auth.issueToken(admin.id, "session").session;
  ctx.clock.now += 1;
  const t1 = ctx.auth.issueToken(admin.id, "api").session;
  ctx.clock.now += 1;
  const s2 = ctx.auth.issueToken(admin.id, "session").session;
  ctx.auth.issueToken(bob.id, "session");

  expect(ctx.auth.listSessions(admin.id).map((s) => s.id)).toEqual([s1.id, t1.id, s2.id]);
  expect(ctx.auth.listSessions(admin.id, "session").map((s) => s.id)).toEqual([s1.id, s2.id]);
  expect(ctx.auth.listSessions(admin.id, "api").map((s) => s.id)).toEqual([t1.id]);
});

test("revoking a session ends it and notifies", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const { token, session } = ctx.auth.issueToken(admin.id, "session");
  ctx.auth.revokeSession(session.id);
  expect(ctx.auth.authenticate(token)).toBeNull();
  expect(ctx.auth.isSessionValid(session.id)).toBe(false);
  expect(ctx.auth.getSession(session.id)).toBeUndefined();
  expect(ctx.changes).toEqual([{ kind: "session_revoked", sessionId: session.id }]);
});

// ───────── updating users ─────────

test("disabling a user revokes every session and token", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  const session = ctx.auth.issueToken(bob.id, "session");
  const api = ctx.auth.issueToken(bob.id, "api");
  ctx.changes.length = 0;

  const updated = await ctx.auth.updateUser(bob.id, { disabled: true });

  expect(updated.disabled).toBe(true);
  expect(ctx.auth.listSessions(bob.id)).toEqual([]);
  expect(ctx.auth.authenticate(session.token)).toBeNull();
  expect(ctx.auth.authenticate(api.token)).toBeNull();
  expect(ctx.changes).toEqual([
    { kind: "session_revoked", sessionId: session.session.id },
    { kind: "session_revoked", sessionId: api.session.id },
    { kind: "user", userId: bob.id },
  ]);
});

test("other updates keep sessions and only touch the given fields", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  const { token } = ctx.auth.issueToken(bob.id, "session");
  ctx.clock.now += 5000;
  ctx.changes.length = 0;

  const updated = await ctx.auth.updateUser(bob.id, { displayName: "Bobby", role: "guest" });

  expect(updated).toMatchObject({
    username: "bob",
    displayName: "Bobby",
    role: "guest",
    disabled: false,
    createdAt: bob.createdAt,
    updatedAt: bob.createdAt + 5000,
  });
  expect(ctx.auth.authenticate(token)).not.toBeNull();
  expect(ctx.changes).toEqual([{ kind: "user", userId: bob.id }]);
});

test("a disabled user can be re-enabled", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  await ctx.auth.updateUser(bob.id, { disabled: true });
  expect((await ctx.auth.updateUser(bob.id, { disabled: false })).disabled).toBe(false);
});

test("updating an unknown user throws", async () => {
  const ctx = await setup();
  await expect(ctx.auth.updateUser("usr_missing", { displayName: "x" })).rejects.toThrow(
    "Unknown user usr_missing",
  );
});

// ───────── last enabled admin ─────────

test("the last enabled admin cannot be deleted, demoted, or disabled", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const message = "At least one enabled admin must remain";
  expect(() => ctx.auth.deleteUser(admin.id)).toThrow(message);
  await expect(ctx.auth.updateUser(admin.id, { role: "member" })).rejects.toThrow(message);
  await expect(ctx.auth.updateUser(admin.id, { disabled: true })).rejects.toThrow(message);
  expect(ctx.auth.getUser(admin.id)).toMatchObject({ role: "admin", disabled: false });
  // Changes that keep them an enabled admin are fine.
  await ctx.auth.updateUser(admin.id, { role: "admin", disabled: false, displayName: "Root" });
});

test("a disabled admin does not count as another admin", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const other = await withAdmin(ctx, "other");
  await ctx.auth.updateUser(other.id, { disabled: true });
  expect(() => ctx.auth.deleteUser(admin.id)).toThrow("At least one enabled admin must remain");
  await expect(ctx.auth.updateUser(admin.id, { role: "guest" })).rejects.toThrow(
    "At least one enabled admin must remain",
  );
});

test("a disabled admin can be deleted or demoted while another admin is enabled", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const other = await withAdmin(ctx, "other");
  await ctx.auth.updateUser(other.id, { disabled: true });
  await ctx.auth.updateUser(other.id, { role: "member" });
  ctx.auth.deleteUser(other.id);
  expect(ctx.auth.getUser(other.id)).toBeUndefined();
});

test("with two enabled admins, one can be demoted, disabled, or deleted", async () => {
  const ctx = await setup();
  const a = await withAdmin(ctx, "a");
  const b = await withAdmin(ctx, "b");
  const c = await withAdmin(ctx, "c");
  expect((await ctx.auth.updateUser(a.id, { role: "member" })).role).toBe("member");
  expect((await ctx.auth.updateUser(b.id, { disabled: true })).disabled).toBe(true);
  // c is now the only enabled admin.
  expect(() => ctx.auth.deleteUser(c.id)).toThrow("At least one enabled admin must remain");
  ctx.auth.deleteUser(a.id);
  expect(ctx.auth.listUsers().map((u) => u.username)).toEqual(["b", "c"]);
});

// ───────── deleting users ─────────

test("deleting a user removes them, their sessions, and their grants, and notifies", async () => {
  const ctx = await setup();
  const admin = await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  const session = ctx.auth.issueToken(bob.id, "session");
  const api = ctx.auth.issueToken(bob.id, "api");
  ctx.auth.setGrant({
    subjectKind: "user",
    subjectId: bob.id,
    scopeKind: "entity",
    scopeId: "light.desk",
    level: "control",
  });
  const kept = [
    ctx.auth.setGrant({
      subjectKind: "user",
      subjectId: admin.id,
      scopeKind: "domain",
      scopeId: "light",
      level: "read",
    }),
    ctx.auth.setGrant({
      subjectKind: "role",
      subjectId: "member",
      scopeKind: "area",
      scopeId: "kitchen",
      level: "read",
    }),
  ];
  ctx.changes.length = 0;

  ctx.auth.deleteUser(bob.id);

  expect(ctx.auth.getUser(bob.id)).toBeUndefined();
  expect(ctx.auth.getUserByUsername("bob")).toBeUndefined();
  expect(ctx.auth.authenticate(session.token)).toBeNull();
  expect(ctx.auth.authenticate(api.token)).toBeNull();
  expect(ctx.auth.listGrants()).toEqual(kept);
  expect(ctx.db.query("SELECT * FROM grants WHERE subject_id = ?").all(bob.id)).toEqual([]);
  expect(ctx.changes).toEqual([
    { kind: "session_revoked", sessionId: session.session.id },
    { kind: "session_revoked", sessionId: api.session.id },
    { kind: "user", userId: bob.id },
  ]);
});

test("a deleted username can be reused", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  ctx.auth.deleteUser(bob.id);
  const again = await user(ctx, "bob");
  expect(again.id).not.toBe(bob.id);
});

test("deleting an unknown user throws", async () => {
  const ctx = await setup();
  expect(() => ctx.auth.deleteUser("usr_missing")).toThrow("Unknown user usr_missing");
});

// ───────── grants ─────────

test("setGrant upserts on (subject, scope)", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  const target = {
    subjectKind: "user",
    subjectId: bob.id,
    scopeKind: "entity",
    scopeId: "lock.front",
  } as const;

  const first = ctx.auth.setGrant({ ...target, level: "read", createdBy: "x" });
  expect(first).toMatchObject({ ...target, level: "read", createdBy: "x", createdAt: 1_000_000 });

  ctx.clock.now += 10;
  const second = ctx.auth.setGrant({ ...target, level: "control" });
  expect(second.id).toBe(first.id);
  expect(second).toMatchObject({ level: "control", createdAt: 1_000_010 });
  expect(second.createdBy).toBeUndefined();
  expect(ctx.auth.listGrants()).toEqual([second]);

  // Same subject, other scope; and same scope, other subject: both are new grants.
  ctx.auth.setGrant({ ...target, scopeKind: "domain", scopeId: "lock", level: "none" });
  ctx.auth.setGrant({ ...target, subjectKind: "role", subjectId: "member", level: "read" });
  expect(ctx.auth.listGrants()).toHaveLength(3);
});

test("listGrants filters by subject", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  const base = { scopeKind: "domain", scopeId: "light", level: "read" } as const;
  const forBob = ctx.auth.setGrant({ ...base, subjectKind: "user", subjectId: bob.id });
  const forRole = ctx.auth.setGrant({ ...base, subjectKind: "role", subjectId: "guest" });
  expect(ctx.auth.listGrants({ subjectKind: "user" })).toEqual([forBob]);
  expect(ctx.auth.listGrants({ subjectKind: "role", subjectId: "guest" })).toEqual([forRole]);
  expect(ctx.auth.listGrants({ subjectId: "nobody" })).toEqual([]);
});

test("setGrant for an unknown user throws and stores nothing", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  expect(() =>
    ctx.auth.setGrant({
      subjectKind: "user",
      subjectId: "usr_missing",
      scopeKind: "entity",
      scopeId: "light.x",
      level: "read",
    }),
  ).toThrow("Unknown user usr_missing");
  expect(ctx.auth.listGrants()).toEqual([]);
  expect(ctx.changes).toEqual([]);
});

test("grants survive a new Auth over the same database", async () => {
  const ctx = await setup();
  const grant = ctx.auth.setGrant({
    subjectKind: "role",
    subjectId: "guest",
    scopeKind: "area",
    scopeId: "garage",
    level: "none",
  });
  expect(new Auth({ db: ctx.db }).listGrants()).toEqual([grant]);
});

test("deleteGrant removes the grant, returns it, and notifies", async () => {
  const ctx = await setup();
  const grant = ctx.auth.setGrant({
    subjectKind: "role",
    subjectId: "guest",
    scopeKind: "area",
    scopeId: "garage",
    level: "none",
  });
  expect(ctx.auth.deleteGrant(grant.id)).toEqual(grant);
  expect(ctx.auth.listGrants()).toEqual([]);
  expect(new Auth({ db: ctx.db }).listGrants()).toEqual([]);
  expect(ctx.changes).toEqual([{ kind: "grants" }, { kind: "grants" }]);
  expect(() => ctx.auth.deleteGrant(grant.id)).toThrow(`Unknown grant ${grant.id}`);
});

test("levelFor sees grants as soon as they are set, upserted, or deleted", async () => {
  const ctx = await setup();
  await withAdmin(ctx);
  const bob = await user(ctx, "bob");
  const entity = { id: "lock.front", domain: "lock" };
  const target = {
    subjectKind: "user",
    subjectId: bob.id,
    scopeKind: "entity",
    scopeId: "lock.front",
  } as const;
  const grant = ctx.auth.setGrant({ ...target, level: "none" });
  expect(ctx.auth.levelFor(bob, entity)).toBe("none");
  ctx.auth.setGrant({ ...target, level: "control" });
  expect(ctx.auth.levelFor(bob, entity)).toBe("control");
  ctx.auth.setGrant({ ...target, level: "read" });
  expect(ctx.auth.levelFor(bob, entity)).toBe("read");
  ctx.auth.deleteGrant(grant.id);
  ctx.auth.setGrant({ ...target, scopeKind: "domain", scopeId: "lock", level: "none" });
  expect(ctx.auth.levelFor(bob, entity)).toBe("none");
});

// ───────── onChange ─────────

test("onChange returns an unsubscribe function", async () => {
  const ctx = await setup();
  const seen: AuthChange[] = [];
  const off = ctx.auth.onChange((change) => seen.push(change));
  const base = {
    subjectKind: "role",
    subjectId: "guest",
    scopeKind: "domain",
    level: "read",
  } as const;
  ctx.auth.setGrant({ ...base, scopeId: "light" });
  off();
  ctx.auth.setGrant({ ...base, scopeId: "lock" });
  expect(seen).toEqual([{ kind: "grants" }]);
  expect(ctx.changes).toEqual([{ kind: "grants" }, { kind: "grants" }]);
});

test("a listener that unsubscribes during a notification does not skip others", async () => {
  const ctx = await setup();
  const seen: string[] = [];
  const off = ctx.auth.onChange(() => {
    seen.push("first");
    off();
  });
  ctx.auth.onChange(() => seen.push("second"));
  ctx.auth.revokeSession("ses_x");
  ctx.auth.revokeSession("ses_y");
  expect(seen).toEqual(["first", "second", "second"]);
});

// ───────── audit ─────────

test("audit entries round-trip, newest first", async () => {
  const ctx = await setup();
  ctx.auth.audit({ action: "login", actorUserId: "usr_1", ip: "10.0.0.1" });
  ctx.clock.now += 1;
  ctx.auth.audit({ action: "grant_set", target: "light.x", detail: { level: "read", n: [1] } });
  const entries = ctx.auth.listAudit();
  expect(entries).toEqual([
    {
      id: 2,
      at: 1_000_001,
      action: "grant_set",
      target: "light.x",
      detail: { level: "read", n: [1] },
      actorUserId: undefined,
      ip: undefined,
    },
    {
      id: 1,
      at: 1_000_000,
      action: "login",
      actorUserId: "usr_1",
      ip: "10.0.0.1",
      target: undefined,
      detail: undefined,
    },
  ]);
});

test("audit order is insertion order even if the clock goes backwards", async () => {
  const ctx = await setup();
  ctx.clock.now = 5000;
  ctx.auth.audit({ action: "login" });
  ctx.clock.now = 1000;
  ctx.auth.audit({ action: "logout" });
  expect(ctx.auth.listAudit().map((e) => e.action)).toEqual(["logout", "login"]);
});

test("listAudit since is inclusive", async () => {
  const ctx = await setup();
  for (const at of [100, 200, 300]) {
    ctx.clock.now = at;
    ctx.auth.audit({ action: "config_set", target: String(at) });
  }
  expect(ctx.auth.listAudit({ since: 200 }).map((e) => e.target)).toEqual(["300", "200"]);
  expect(ctx.auth.listAudit({ since: 301 })).toEqual([]);
});

test("listAudit defaults to 200 entries and caps the limit at 1000", async () => {
  const ctx = await setup();
  ctx.db.transaction(() => {
    for (let i = 0; i < 1005; i++) ctx.auth.audit({ action: "login", target: String(i) });
  })();
  expect(ctx.auth.listAudit()).toHaveLength(200);
  expect(ctx.auth.listAudit({ limit: 3 }).map((e) => e.target)).toEqual(["1004", "1003", "1002"]);
  expect(ctx.auth.listAudit({ limit: 1000 })).toHaveLength(1000);
  expect(ctx.auth.listAudit({ limit: 5000 })).toHaveLength(1000);
});

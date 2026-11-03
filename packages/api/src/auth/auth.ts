// Users, sessions and API tokens, grants, and the audit log.

import type { Database } from "@casita/core";
import { CoreError } from "@casita/core";
import {
  type Grant,
  type Level,
  type PermissionTarget,
  type Role,
  resolveLevel,
  type ScopeKind,
  type SubjectKind,
} from "./permissions.ts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** last_used_at and the sliding expiry are rewritten at most this often. */
const TOUCH_INTERVAL_MS = 60_000;
export const BOOTSTRAP_USER_ID = "bootstrap";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SessionKind = "session" | "api";

export interface Session {
  id: string;
  userId: string;
  kind: SessionKind;
  name?: string;
  expiresAt?: number;
  lastUsedAt?: number;
  createdAt: number;
}

/** Who a request runs as. */
export interface Principal {
  user: User;
  sessionId: string;
}

export type AuditAction =
  | "login"
  | "login_failed"
  | "logout"
  | "user_created"
  | "user_updated"
  | "user_deleted"
  | "grant_set"
  | "grant_deleted"
  | "token_created"
  | "token_revoked"
  | "config_set"
  | "page_saved"
  | "theme_saved"
  | "components_saved"
  | "automation_saved"
  | "automation_deleted"
  | "automation_enabled"
  | "automation_tested"
  | "sensor_saved"
  | "sensor_deleted"
  | "sensor_enabled"
  | "device_setting_set";

export interface AuditEntry {
  id: number;
  at: number;
  actorUserId?: string;
  action: AuditAction;
  target?: string;
  detail?: unknown;
  ip?: string;
}

/** Changes that open connections must react to. */
export type AuthChange =
  | { kind: "grants" }
  | { kind: "user"; userId: string }
  | { kind: "session_revoked"; sessionId: string };

/** Local username and password first; OIDC plugs in behind the same shape. */
export interface IdentityProvider {
  readonly name: string;
  authenticate?(credentials: { username: string; password: string }): Promise<string | null>;
  startLogin?(): Promise<{ redirectUrl: string; state: string }>;
  completeLogin?(
    callbackParams: URLSearchParams,
  ): Promise<{ provider: string; subject: string; claims: Record<string, unknown> }>;
}

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  role: Role;
  disabled: number;
  created_at: number;
  updated_at: number;
};

type SessionRow = {
  id: string;
  user_id: string;
  kind: SessionKind;
  name: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
};

type GrantRow = {
  id: string;
  subject_kind: SubjectKind;
  subject_id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  level: Level;
  created_by: string | null;
  created_at: number;
};

const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  role: r.role,
  disabled: r.disabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  name: r.name ?? undefined,
  expiresAt: r.expires_at ?? undefined,
  lastUsedAt: r.last_used_at ?? undefined,
  createdAt: r.created_at,
});

const toGrant = (r: GrantRow): Grant => ({
  id: r.id,
  subjectKind: r.subject_kind,
  subjectId: r.subject_id,
  scopeKind: r.scope_kind,
  scopeId: r.scope_id,
  level: r.level,
  createdBy: r.created_by ?? undefined,
  createdAt: r.created_at,
});

const randomId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
const hashToken = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const USERNAME = /^[a-z0-9_.-]{1,64}$/;
// Verified against when the user is unknown, so both failures take the same time.
const DUMMY_HASH = Bun.password.hashSync(crypto.randomUUID(), "argon2id");

export interface AuthDeps {
  db: Database;
  /** server.apiToken: an admin credential only while no user exists. */
  bootstrapToken?: string;
  now?: () => number;
}

export class Auth {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly listeners = new Set<(change: AuthChange) => void>();
  private grants: Grant[];

  constructor(private readonly deps: AuthDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.grants = this.db.query<GrantRow, []>("SELECT * FROM grants").all().map(toGrant);
  }

  onChange(listener: (change: AuthChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(change: AuthChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  // ───────── users ─────────

  hasUsers(): boolean {
    return this.db.query("SELECT 1 FROM users LIMIT 1").get() !== null;
  }

  /** True when the bootstrap token is configured but no longer honored. */
  bootstrapTokenIsStale(): boolean {
    return this.deps.bootstrapToken !== undefined && this.hasUsers();
  }

  listUsers(): User[] {
    return this.db.query<UserRow, []>("SELECT * FROM users ORDER BY username").all().map(toUser);
  }

  getUser(id: string): User | undefined {
    if (id === BOOTSTRAP_USER_ID && !this.hasUsers()) return this.bootstrapUser();
    const row = this.db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id);
    return row ? toUser(row) : undefined;
  }

  getUserByUsername(username: string): User | undefined {
    const row = this.userRow(username);
    return row ? toUser(row) : undefined;
  }

  async createUser(input: {
    username: string;
    displayName?: string;
    password?: string;
    role: Role;
    identity?: { provider: string; subject: string };
  }): Promise<User> {
    const username = input.username.toLowerCase();
    if (!USERNAME.test(username)) {
      throw new CoreError("invalid", "Usernames use lowercase letters, digits, and . _ -");
    }
    if (this.userRow(username)) throw new CoreError("invalid", `User ${username} already exists`);
    // Otherwise the bootstrap token would stop working with nobody able to administer.
    if (!this.hasUsers() && input.role !== "admin") {
      throw new CoreError("invalid", "The first user must be an admin");
    }
    const at = this.now();
    const id = randomId("usr");
    const hash = input.password === undefined ? null : await this.hashPassword(input.password);
    const identity = input.identity ?? { provider: "local", subject: username };
    // Hashing awaited, so a concurrent call may have created a user since the checks above.
    if (this.userRow(username)) throw new CoreError("invalid", `User ${username} already exists`);
    if (!this.hasUsers() && input.role !== "admin") {
      throw new CoreError("invalid", "The first user must be an admin");
    }
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, username, input.displayName ?? username, hash, input.role, at, at);
      this.db
        .query(
          "INSERT INTO user_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(identity.provider, identity.subject, id, at);
    })();
    return this.requireUser(id);
  }

  async updateUser(
    id: string,
    patch: { role?: Role; disabled?: boolean; displayName?: string; password?: string },
  ): Promise<User> {
    const user = this.requireUser(id);
    const losesAdmin =
      user.role === "admin" &&
      !user.disabled &&
      ((patch.role ?? "admin") !== "admin" || patch.disabled === true);
    if (losesAdmin) this.requireAnotherAdmin(id);
    const hash = patch.password === undefined ? undefined : await this.hashPassword(patch.password);
    this.db
      .query(
        `UPDATE users SET role = ?, disabled = ?, display_name = ?,
           password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.role ?? user.role,
        (patch.disabled ?? user.disabled) ? 1 : 0,
        patch.displayName ?? user.displayName,
        hash ?? null,
        this.now(),
        id,
      );
    // A new password or a disabled account ends every existing session and token.
    if (patch.password !== undefined || patch.disabled === true) {
      for (const session of this.listSessions(id)) this.revokeSession(session.id);
    }
    this.changed({ kind: "user", userId: id });
    return this.requireUser(id);
  }

  deleteUser(id: string): void {
    const user = this.requireUser(id);
    if (user.role === "admin" && !user.disabled) this.requireAnotherAdmin(id);
    const sessions = this.listSessions(id);
    this.db.transaction(() => {
      this.db.query("DELETE FROM grants WHERE subject_kind = 'user' AND subject_id = ?").run(id);
      this.db.query("DELETE FROM users WHERE id = ?").run(id); // cascades to identities and sessions
    })();
    this.grants = this.grants.filter((g) => !(g.subjectKind === "user" && g.subjectId === id));
    for (const session of sessions)
      this.changed({ kind: "session_revoked", sessionId: session.id });
    this.changed({ kind: "user", userId: id });
  }

  /**
   * The user an external identity maps to, created with `defaultRole` on first sight.
   * Returns undefined when that user is disabled.
   */
  async userForIdentity(
    identity: { provider: string; subject: string },
    claims: Record<string, unknown>,
    defaultRole: Role,
  ): Promise<User | undefined> {
    const row = this.db
      .query<{ user_id: string }, [string, string]>(
        "SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?",
      )
      .get(identity.provider, identity.subject);
    if (row) {
      const user = this.getUser(row.user_id);
      return user && !user.disabled ? user : undefined;
    }
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
    const wanted =
      text(claims.preferred_username) ?? text(claims.email)?.split("@")[0] ?? identity.subject;
    const base =
      wanted
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, "_")
        .slice(0, 60) || "user";
    let username = base;
    for (let n = 2; this.userRow(username); n++) username = `${base}_${n}`;
    return this.createUser({
      username,
      displayName: text(claims.name) ?? username,
      role: defaultRole,
      identity,
    });
  }

  // ───────── login, sessions, tokens ─────────

  /** Local identity provider. Returns null for an unknown user, a wrong password, or a disabled account. */
  async login(username: string, password: string): Promise<{ token: string; user: User } | null> {
    const row = this.userRow(username.toLowerCase());
    const ok = await Bun.password
      .verify(password, row?.password_hash ?? DUMMY_HASH)
      .catch(() => false);
    if (!row?.password_hash || !ok || row.disabled) return null;
    return { token: this.issueToken(row.id, "session").token, user: toUser(row) };
  }

  /** The token is returned once; only its SHA-256 is stored. */
  issueToken(
    userId: string,
    kind: SessionKind,
    name?: string,
  ): { token: string; session: Session } {
    this.requireUser(userId);
    const token = `casita_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const id = randomId(kind === "api" ? "tok" : "ses");
    const at = this.now();
    this.db
      .query(
        `INSERT INTO sessions (id, user_id, token_hash, kind, name, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        hashToken(token),
        kind,
        name ?? null,
        kind === "session" ? at + SESSION_TTL_MS : null,
        at,
      );
    return { token, session: this.requireSession(id) };
  }

  /** Resolves a bearer token of either kind; sliding expiry for sessions. */
  authenticate(token: string): Principal | null {
    const bootstrap = this.deps.bootstrapToken;
    if (bootstrap && !this.hasUsers()) {
      const a = Buffer.from(hashToken(token));
      const b = Buffer.from(hashToken(bootstrap));
      if (crypto.timingSafeEqual(a, b))
        return { user: this.bootstrapUser(), sessionId: BOOTSTRAP_USER_ID };
    }
    const row = this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE token_hash = ?")
      .get(hashToken(token));
    if (!row) return null;
    const at = this.now();
    if (row.expires_at !== null && row.expires_at <= at) return null;
    const user = this.getUser(row.user_id);
    if (!user || user.disabled) return null;
    if (at - (row.last_used_at ?? 0) >= TOUCH_INTERVAL_MS) {
      this.db
        .query("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?")
        .run(at, row.kind === "session" ? at + SESSION_TTL_MS : null, row.id);
    }
    return { user, sessionId: row.id };
  }

  /** Whether an already-authenticated session is still good (not revoked, expired, or disabled). */
  isSessionValid(sessionId: string): boolean {
    if (sessionId === BOOTSTRAP_USER_ID) return !this.hasUsers();
    const row = this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId);
    return !!row && (row.expires_at === null || row.expires_at > this.now());
  }

  getSession(id: string): Session | undefined {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : undefined;
  }

  listSessions(userId: string, kind?: SessionKind): Session[] {
    return this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at")
      .all(userId)
      .map(toSession)
      .filter((s) => !kind || s.kind === kind);
  }

  revokeSession(id: string): void {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
    this.changed({ kind: "session_revoked", sessionId: id });
  }

  // ───────── grants ─────────

  listGrants(filter: { subjectKind?: SubjectKind; subjectId?: string } = {}): Grant[] {
    return this.grants.filter(
      (g) =>
        (!filter.subjectKind || g.subjectKind === filter.subjectKind) &&
        (!filter.subjectId || g.subjectId === filter.subjectId),
    );
  }

  /** One grant per (subject, scope); setting it again replaces the level. */
  setGrant(input: Omit<Grant, "id" | "createdAt">): Grant {
    if (input.subjectKind === "user") this.requireUser(input.subjectId);
    const at = this.now();
    this.db
      .query(
        `INSERT INTO grants (id, subject_kind, subject_id, scope_kind, scope_id, level, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subject_kind, subject_id, scope_kind, scope_id)
         DO UPDATE SET level = excluded.level, created_by = excluded.created_by, created_at = excluded.created_at`,
      )
      .run(
        randomId("grt"),
        input.subjectKind,
        input.subjectId,
        input.scopeKind,
        input.scopeId,
        input.level,
        input.createdBy ?? null,
        at,
      );
    this.grants = this.db.query<GrantRow, []>("SELECT * FROM grants").all().map(toGrant);
    this.changed({ kind: "grants" });
    const grant = this.grants.find(
      (g) =>
        g.subjectKind === input.subjectKind &&
        g.subjectId === input.subjectId &&
        g.scopeKind === input.scopeKind &&
        g.scopeId === input.scopeId,
    );
    if (!grant) throw new CoreError("internal", "Grant was not stored");
    return grant;
  }

  deleteGrant(id: string): Grant {
    const grant = this.grants.find((g) => g.id === id);
    if (!grant) throw new CoreError("not_found", `Unknown grant ${id}`);
    this.db.query("DELETE FROM grants WHERE id = ?").run(id);
    this.grants = this.grants.filter((g) => g.id !== id);
    this.changed({ kind: "grants" });
    return grant;
  }

  levelFor(user: User, entity: PermissionTarget): Level {
    return resolveLevel(user, this.grants, entity);
  }

  // ───────── audit ─────────

  audit(entry: Omit<AuditEntry, "id" | "at">): void {
    this.db
      .query(
        "INSERT INTO audit (at, actor_user_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.now(),
        entry.actorUserId ?? null,
        entry.action,
        entry.target ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
        entry.ip ?? null,
      );
  }

  listAudit(opts: { since?: number; limit?: number } = {}): AuditEntry[] {
    type Row = {
      id: number;
      at: number;
      actor_user_id: string | null;
      action: AuditAction;
      target: string | null;
      detail: string | null;
      ip: string | null;
    };
    return this.db
      .query<Row, [number, number]>("SELECT * FROM audit WHERE at >= ? ORDER BY id DESC LIMIT ?")
      .all(opts.since ?? 0, Math.min(opts.limit ?? 200, 1000))
      .map((r) => ({
        id: r.id,
        at: r.at,
        actorUserId: r.actor_user_id ?? undefined,
        action: r.action,
        target: r.target ?? undefined,
        detail: r.detail === null ? undefined : JSON.parse(r.detail),
        ip: r.ip ?? undefined,
      }));
  }

  // ───────── internals ─────────

  private bootstrapUser(): User {
    return {
      id: BOOTSTRAP_USER_ID,
      username: BOOTSTRAP_USER_ID,
      displayName: "Bootstrap admin",
      role: "admin",
      disabled: false,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  private userRow(username: string): UserRow | null {
    return this.db.query<UserRow, [string]>("SELECT * FROM users WHERE username = ?").get(username);
  }

  private requireUser(id: string): User {
    const user = this.getUser(id);
    if (!user || id === BOOTSTRAP_USER_ID) throw new CoreError("not_found", `Unknown user ${id}`);
    return user;
  }

  private requireSession(id: string): Session {
    const session = this.getSession(id);
    if (!session) throw new CoreError("not_found", `Unknown session ${id}`);
    return session;
  }

  private requireAnotherAdmin(exceptId: string): void {
    const others = this.listUsers().filter(
      (u) => u.role === "admin" && !u.disabled && u.id !== exceptId,
    );
    if (others.length === 0)
      throw new CoreError("invalid", "At least one enabled admin must remain");
  }

  private async hashPassword(password: string): Promise<string> {
    if (password.length < 8) throw new CoreError("invalid", "Passwords need at least 8 characters");
    return Bun.password.hash(password, "argon2id");
  }
}

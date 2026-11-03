import { CasitaError, type Row } from "@casita/client";
import {
  Badge,
  Button,
  Combobox,
  CopyChip,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  SegmentedControl,
  Select,
  Skeleton,
  Tabs,
  TextField,
  Timestamp,
  Toggle,
} from "@casita/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  auditLine,
  displayNameError,
  grantsFor,
  type Level,
  ROLE_DEFAULT,
  ROLES,
  roleLabel,
  SCOPE_LABEL,
  type ScopeKind,
  type SubjectKind,
  scopeName,
  scopeOptions,
  userDraftErrors,
} from "../access.ts";
import { useAction, useHouse, useIsAdmin, useStore } from "../context.tsx";
import { ConfirmRemove } from "../edit.tsx";

const LEVELS = [
  { value: "none", label: "None" },
  { value: "read", label: "Read" },
  { value: "control", label: "Control" },
];
const ROLE_ICON: Record<string, string> = { admin: "shield", member: "user", guest: "eye" };

/** Loads a list, again whenever `key` changes, and gives a way to load it again by hand. */
function useList(
  key: string,
  load: () => Promise<unknown>,
): [Row[] | undefined, () => void, string] {
  const [list, setList] = useState<Row[]>();
  const [failed, setFailed] = useState("");
  const latest = useRef(load);
  latest.current = load;
  const reload = useCallback(() => {
    latest.current().then(
      (result) => {
        setFailed("");
        setList(result as Row[]);
      },
      (err: unknown) => setFailed(err instanceof CasitaError ? err.message : "Couldn't load this"),
    );
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` says when the list is a different one
  useEffect(reload, [reload, key]);
  return [list, reload, failed];
}

// ───────── grants ─────────

function Grants({ kind, id, role }: { kind: SubjectKind; id: string; role: string }) {
  const house = useHouse();
  const store = useStore();
  const act = useAction();
  const [grants, reload] = useList("grants", () => store.request("list_grants", {}));
  const [scopeKind, setScopeKind] = useState<ScopeKind>("area");
  const [scopeId, setScopeId] = useState("");
  const [level, setLevel] = useState<Level>("read");
  const own = grantsFor(grants ?? [], kind, id);

  const set = async (scope: { scopeKind: string; scopeId: string }, next: Level) => {
    const name = scopeName(house, scope.scopeKind, scope.scopeId);
    await act(`${name}: ${next}`, `Couldn't change access to ${name}`, () =>
      store.request("set_grant", {
        subjectKind: kind,
        subjectId: id,
        scopeKind: scope.scopeKind as ScopeKind,
        scopeId: scope.scopeId,
        level: next,
      }),
    );
    reload();
  };
  const remove = async (grant: Row) => {
    const name = scopeName(house, String(grant.scopeKind), String(grant.scopeId));
    await act(`Removed the grant on ${name}`, `Couldn't remove the grant on ${name}`, () =>
      store.request("delete_grant", { grantId: String(grant.id) }),
    );
    reload();
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!scopeId) return;
    await set({ scopeKind, scopeId }, level);
    setScopeId("");
  };

  return (
    <section className="app-card">
      <h3 className="ca-text-heading">Access</h3>
      <p className="ca-text-body app-muted">{ROLE_DEFAULT[role]}</p>
      {role === "admin" ? null : !grants ? (
        <Skeleton lines={2} />
      ) : (
        <>
          {own.length === 0 ? (
            <p className="ca-text-caption app-muted">No grants yet.</p>
          ) : (
            <ul className="app-grants">
              {own.map((grant) => (
                <li key={String(grant.id)} className="app-grant">
                  <span className="app-grant-scope">
                    <Badge>
                      {SCOPE_LABEL[grant.scopeKind as ScopeKind] ?? String(grant.scopeKind)}
                    </Badge>
                    <span>{scopeName(house, String(grant.scopeKind), String(grant.scopeId))}</span>
                    <span className="ca-mono app-muted">{String(grant.scopeId)}</span>
                  </span>
                  <SegmentedControl
                    label={`Access to ${scopeName(house, String(grant.scopeKind), String(grant.scopeId))}`}
                    value={String(grant.level)}
                    options={LEVELS}
                    onChange={(next) =>
                      void set(
                        { scopeKind: String(grant.scopeKind), scopeId: String(grant.scopeId) },
                        next as Level,
                      )
                    }
                  />
                  <IconButton
                    icon="trash-2"
                    size="sm"
                    label="Remove this grant"
                    onClick={() => void remove(grant)}
                  />
                </li>
              ))}
            </ul>
          )}
          <form className="app-form app-form-row" onSubmit={add}>
            <Select
              label="Grant on"
              value={scopeKind}
              onChange={(value) => {
                setScopeKind(value as ScopeKind);
                setScopeId("");
              }}
              options={Object.entries(SCOPE_LABEL).map(([value, label]) => ({ value, label }))}
            />
            <Combobox
              label={SCOPE_LABEL[scopeKind]}
              placeholder="Choose"
              mono={scopeKind === "entity"}
              options={scopeOptions(house, scopeKind)}
              value={scopeId}
              onChange={setScopeId}
            />
            <SegmentedControl
              label="Level"
              value={level}
              options={LEVELS}
              onChange={(value) => setLevel(value as Level)}
            />
            <Button type="submit" icon="plus" disabled={!scopeId}>
              Add
            </Button>
          </form>
        </>
      )}
    </section>
  );
}

// ───────── tokens and sessions ─────────

function Credentials({ userId, self }: { userId: string; self: boolean }) {
  const store = useStore();
  const act = useAction();
  const [tokens, reloadTokens] = useList(`tokens:${userId}`, () =>
    store.request("list_tokens", { userId }),
  );
  const [sessions, reloadSessions] = useList(`sessions:${userId}`, () =>
    store.request("list_sessions", { userId }),
  );
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ name: string; token: string }>();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const label = name.trim();
    if (!label) return;
    await act(`Made the token ${label}`, "Couldn't make the token", async () => {
      const result = (await store.request("create_token", { name: label, userId })) as Row;
      setMade({ name: label, token: String(result.token) });
    });
    setName("");
    reloadTokens();
  };

  return (
    <>
      <section className="app-card">
        <h3 className="ca-text-heading">API tokens</h3>
        <p className="ca-text-body app-muted">
          For scripts and the CLI. A token does not expire; revoke it when it is no longer needed.
        </p>
        {!tokens ? (
          <Skeleton lines={2} />
        ) : tokens.length === 0 ? (
          <p className="ca-text-caption app-muted">None.</p>
        ) : (
          <DataTable
            dense
            rows={tokens as (Row & { id: string })[]}
            columns={[
              { key: "name", label: "Name" },
              {
                key: "lastUsedAt",
                label: "Last used",
                render: (row) =>
                  typeof row.lastUsedAt === "number" ? (
                    <Timestamp value={row.lastUsedAt} />
                  ) : (
                    "Never"
                  ),
              },
              {
                key: "revoke",
                label: "",
                align: "right",
                render: (row) => (
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={async () => {
                      await act(`Revoked ${row.name}`, `Couldn't revoke ${row.name}`, () =>
                        store.request("revoke_token", { tokenId: row.id }),
                      );
                      reloadTokens();
                    }}
                  >
                    Revoke
                  </Button>
                ),
              },
            ]}
          />
        )}
        <form className="app-form app-form-row" onSubmit={create}>
          <TextField
            label="New token"
            placeholder="What it is for"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" icon="plus" disabled={!name.trim()}>
            Make token
          </Button>
        </form>
      </section>
      <section className="app-card">
        <h3 className="ca-text-heading">Signed-in sessions</h3>
        {!sessions ? (
          <Skeleton lines={2} />
        ) : sessions.length === 0 ? (
          <p className="ca-text-caption app-muted">None.</p>
        ) : (
          <DataTable
            dense
            rows={sessions as (Row & { id: string })[]}
            columns={[
              {
                key: "createdAt",
                label: "Signed in",
                render: (row) => <Timestamp value={Number(row.createdAt)} />,
              },
              {
                key: "lastUsedAt",
                label: "Last used",
                render: (row) =>
                  typeof row.lastUsedAt === "number" ? <Timestamp value={row.lastUsedAt} /> : "",
              },
              {
                key: "end",
                label: "",
                align: "right",
                render: (row) => (
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={async () => {
                      await act("Session ended", "Couldn't end the session", () =>
                        store.request("revoke_session", { sessionId: row.id }),
                      );
                      reloadSessions();
                    }}
                  >
                    {self ? "Sign out" : "End"}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </section>
      <Dialog
        open={made !== undefined}
        title={`Token for ${made?.name ?? ""}`}
        description="Copy it now. It is shown this once and cannot be read again."
        dismissable={false}
        onClose={() => setMade(undefined)}
        actions={
          <Button variant="primary" onClick={() => setMade(undefined)}>
            Done
          </Button>
        }
      >
        {made ? <CopyChip value={made.token} /> : null}
      </Dialog>
    </>
  );
}

// ───────── display name ─────────

/** One line: the name shown for a user, saved when it differs from what it was. */
function DisplayNameForm({
  current,
  onSave,
}: {
  current: string;
  onSave: (displayName: string) => Promise<void>;
}) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  // A change from elsewhere (another admin, the CLI) replaces the draft.
  useEffect(() => setValue(current), [current]);
  const draft = value.trim();
  const error = displayNameError(draft);
  return (
    <form
      className="app-form app-form-row"
      onSubmit={async (event) => {
        event.preventDefault();
        if (error || draft === current) return;
        setBusy(true);
        await onSave(draft);
        setBusy(false);
      }}
    >
      <TextField
        label="Display name"
        autoComplete="nickname"
        hint="Shown in place of the username. Leave it empty to show the username."
        error={error}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" disabled={busy || !!error || draft === current}>
        Save name
      </Button>
    </form>
  );
}

/** A member's own page: the name they are shown as. */
function Profile() {
  const house = useHouse();
  const store = useStore();
  const act = useAction();
  const me = house.me;
  if (!me) return null;
  return (
    <section className="app-card">
      <h3 className="ca-text-heading">{String(me.displayName || me.username)}</h3>
      <CopyChip value={String(me.username)} />
      <DisplayNameForm
        current={String(me.displayName ?? "")}
        onSave={async (displayName) => {
          await act(
            displayName ? `You are shown as ${displayName}` : "You are shown by your username",
            "Couldn't change your name",
            () => store.request("update_me", { displayName }),
          );
          await store.refreshMe();
        }}
      />
    </section>
  );
}

// ───────── one user ─────────

function UserPanel({ user, self, onChanged }: { user: Row; self: boolean; onChanged: () => void }) {
  const store = useStore();
  const act = useAction();
  const [password, setPassword] = useState("");
  const [removing, setRemoving] = useState(false);
  const id = String(user.id);
  const name = String(user.username);
  const update = async (patch: Row, done: string) => {
    await act(done, `Couldn't change ${name}`, () =>
      store.request("update_user", { userId: id, ...patch }),
    );
    onChanged();
    if (self) await store.refreshMe();
  };

  return (
    <div className="app-panel">
      <section className="app-card">
        <h3 className="ca-text-heading">{String(user.displayName || name)}</h3>
        <CopyChip value={name} />
        <div className="app-form app-form-row">
          <Select
            label="Role"
            value={String(user.role)}
            disabled={self}
            hint={self ? "You can't change your own role." : undefined}
            options={ROLES.map((role) => ({ value: role, label: roleLabel(role) }))}
            onChange={(role) => void update({ role }, `${name} is now ${role}`)}
          />
          <Toggle
            label="Can sign in"
            checked={!user.disabled}
            disabled={self}
            onChange={(on) =>
              void update(
                { disabled: !on },
                on ? `${name} can sign in again` : `${name} is disabled`,
              )
            }
          />
        </div>
        <DisplayNameForm
          current={String(user.displayName ?? "")}
          onSave={(displayName) =>
            update(
              { displayName },
              displayName ? `${name} is shown as ${displayName}` : `${name} is shown by username`,
            )
          }
        />
        <form
          className="app-form app-form-row"
          onSubmit={(event) => {
            event.preventDefault();
            void update({ password }, `Password changed for ${name}`).then(() => setPassword(""));
          }}
        >
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 8 characters. Their sessions stay signed in."
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" disabled={password.length < 8}>
            Change password
          </Button>
        </form>
        {self ? null : (
          <div className="app-form-actions">
            <Button variant="quiet" icon="trash-2" onClick={() => setRemoving(true)}>
              Remove user
            </Button>
            <span />
          </div>
        )}
      </section>
      <Grants kind="user" id={id} role={String(user.role)} />
      <Credentials userId={id} self={self} />
      <ConfirmRemove
        open={removing}
        title={`Remove ${name}?`}
        description="Their sessions, tokens and grants go with them."
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          await act(`Removed ${name}`, `Couldn't remove ${name}`, () =>
            store.request("delete_user", { userId: id }),
          );
          onChanged();
        }}
      />
    </div>
  );
}

function AddUser({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const store = useStore();
  const act = useAction();
  const [draft, setDraft] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "member",
  });
  const [tried, setTried] = useState(false);
  const errors = userDraftErrors(draft);
  const set = (patch: Partial<typeof draft>) => setDraft((old) => ({ ...old, ...patch }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) return;
    let id = "";
    const added = await act(`Added ${draft.username.trim()}`, "Couldn't add the user", async () => {
      const user = (await store.request("create_user", {
        username: draft.username.trim(),
        displayName: draft.displayName.trim() || undefined,
        password: draft.password,
        role: draft.role as "member",
      })) as Row;
      id = String(user.id);
    });
    if (added) {
      onAdded(id);
      onClose();
    }
  };
  return (
    <Dialog open size="md" title="Add a user" onClose={onClose}>
      <form className="app-form" onSubmit={submit}>
        <TextField
          label="Username"
          data-autofocus
          autoCapitalize="none"
          autoComplete="off"
          error={tried ? errors.username : undefined}
          value={draft.username}
          onChange={(event) => set({ username: event.target.value })}
        />
        <TextField
          label="Name (optional)"
          value={draft.displayName}
          onChange={(event) => set({ displayName: event.target.value })}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          error={tried ? errors.password : undefined}
          value={draft.password}
          onChange={(event) => set({ password: event.target.value })}
        />
        <Select
          label="Role"
          value={draft.role}
          hint={ROLE_DEFAULT[draft.role]}
          options={ROLES.map((role) => ({ value: role, label: roleLabel(role) }))}
          onChange={(role) => set({ role })}
        />
        <div className="app-form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            Add user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────── the pages ─────────

function People() {
  const store = useStore();
  const house = useHouse();
  const [users, reload, failed] = useList("users", () => store.request("list_users", {}));
  const [selected, setSelected] = useState<{ kind: SubjectKind; id: string }>();
  const [adding, setAdding] = useState(false);
  if (failed) return <EmptyState size="inline" icon="triangle-alert" title={failed} />;
  if (!users) return <Skeleton shape="block" width="100%" height={200} />;
  const me = String(house.me?.id ?? "");
  const user = selected?.kind === "user" ? users.find((u) => u.id === selected.id) : undefined;
  const pick = (kind: SubjectKind, id: string) => setSelected({ kind, id });
  const on = (kind: SubjectKind, id: string) => selected?.kind === kind && selected.id === id;

  return (
    <div className="app-split">
      <div className="app-panel">
        <ul className="app-pick">
          {[...users]
            .sort((a, b) => String(a.username).localeCompare(String(b.username)))
            .map((row) => (
              <li key={String(row.id)}>
                <button
                  type="button"
                  className="app-pick-item"
                  aria-current={on("user", String(row.id)) || undefined}
                  onClick={() => pick("user", String(row.id))}
                >
                  <span>
                    <strong>{String(row.displayName || row.username)}</strong>
                    <span className="ca-mono app-muted">{String(row.username)}</span>
                  </span>
                  <span className="app-cell-name">
                    {row.disabled ? <Badge tone="unavailable">Disabled</Badge> : null}
                    <Badge
                      tone={row.role === "admin" ? "brand" : "neutral"}
                      icon={ROLE_ICON[String(row.role)]}
                    >
                      {roleLabel(String(row.role))}
                    </Badge>
                  </span>
                </button>
              </li>
            ))}
        </ul>
        <Button icon="plus" onClick={() => setAdding(true)}>
          Add user
        </Button>
        <h3 className="ca-text-label app-muted">Everyone with a role</h3>
        <ul className="app-pick">
          {(["member", "guest"] as const).map((role) => (
            <li key={role}>
              <button
                type="button"
                className="app-pick-item"
                aria-current={on("role", role) || undefined}
                onClick={() => pick("role", role)}
              >
                <strong>{roleLabel(role)}s</strong>
                <span className="app-muted">{users.filter((u) => u.role === role).length}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {user ? (
        <UserPanel key={String(user.id)} user={user} self={user.id === me} onChanged={reload} />
      ) : selected?.kind === "role" ? (
        <div className="app-panel">
          <Grants key={selected.id} kind="role" id={selected.id} role={selected.id} />
        </div>
      ) : (
        <EmptyState
          size="inline"
          icon="users"
          title="Choose a user or a role"
          description="Their access, tokens and sessions appear here."
        />
      )}
      {adding ? (
        <AddUser
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            reload();
            pick("user", id);
          }}
        />
      ) : null}
    </div>
  );
}

function Audit() {
  const store = useStore();
  const [users] = useList("users", () => store.request("list_users", {}));
  const [entries, , failed] = useList("audit", () => store.request("get_audit", { limit: 200 }));
  if (failed) return <EmptyState size="inline" icon="triangle-alert" title={failed} />;
  if (!entries || !users) return <Skeleton shape="block" width="100%" height={200} />;
  if (entries.length === 0) {
    return <EmptyState size="inline" icon="history" title="Nothing has been recorded yet" />;
  }
  return (
    <DataTable
      dense
      caption="The last 200 sign-ins and changes to users, access and config"
      rows={entries as (Row & { id: number })[]}
      columns={[
        { key: "at", label: "When", render: (row) => <Timestamp value={Number(row.at)} /> },
        { key: "who", label: "Who", render: (row) => auditLine(row, users).who },
        {
          key: "what",
          label: "What",
          render: (row) => {
            const line = auditLine(row, users);
            return (
              <>
                {line.what} {line.target ? <span className="ca-mono">{line.target}</span> : null}
              </>
            );
          },
        },
        { key: "ip", label: "From", mono: true },
      ]}
    />
  );
}

export function Users() {
  const house = useHouse();
  const admin = useIsAdmin();
  if (!admin) {
    const me = String(house.me?.id ?? "");
    return (
      <div className="app-page app-page-narrow">
        <header className="app-page-head">
          <h1 className="ca-text-title">Your account</h1>
        </header>
        <Profile />
        {me ? <Credentials userId={me} self /> : null}
      </div>
    );
  }
  return (
    <div className="app-page">
      <header className="app-page-head">
        <h1 className="ca-text-title">Users and access</h1>
      </header>
      <Tabs
        label="Users and access"
        tabs={[
          { value: "people", label: "People", icon: "users" },
          { value: "audit", label: "Audit log", icon: "history" },
        ]}
      >
        {(tab) => (tab === "audit" ? <Audit /> : <People />)}
      </Tabs>
    </div>
  );
}

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT, -- null for OIDC-only users
  role TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

-- browser sessions and API tokens
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, -- session | api
  name TEXT,
  expires_at INTEGER, -- null: never (API tokens)
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL, -- user | role
  subject_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL, -- entity | area | domain
  scope_id TEXT NOT NULL,
  level TEXT NOT NULL, -- none | read | control
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (subject_kind, subject_id, scope_kind, scope_id)
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT
);

CREATE INDEX audit_at ON audit (at);

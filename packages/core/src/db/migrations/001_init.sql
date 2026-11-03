CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  unique_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_by_user INTEGER NOT NULL DEFAULT 0,
  manufacturer TEXT,
  model TEXT,
  firmware TEXT,
  area_id TEXT REFERENCES areas (id) ON DELETE SET NULL,
  via_device_id TEXT,
  orphaned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (integration_id, unique_id)
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  unique_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  device_id TEXT REFERENCES devices (id) ON DELETE SET NULL,
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  name_by_user INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT NOT NULL DEFAULT '{}',
  area_id TEXT REFERENCES areas (id) ON DELETE SET NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  orphaned INTEGER NOT NULL DEFAULT 0,
  retention TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (integration_id, unique_id)
);

-- 30-day rename aliases
CREATE TABLE entity_aliases (
  old_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- one row per state_changed
CREATE TABLE states (
  id INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL,
  state TEXT NOT NULL,
  attributes TEXT,
  available INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX states_entity_changed ON states (entity_id, changed_at);

-- upserted on every report; read at startup
CREATE TABLE last_states (
  entity_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  attributes TEXT,
  available INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE commands (
  id INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL,
  command TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  latency_ms INTEGER,
  issued_at INTEGER NOT NULL
);

CREATE INDEX commands_issued ON commands (issued_at);

CREATE TABLE integration_storage (
  integration_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (integration_id, key)
);

CREATE TABLE integration_status (
  integration_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  error TEXT,
  since INTEGER NOT NULL
);

-- An automation written in Casa by a household admin: one `automation` declaration whose
-- handlers all run on the server. `compiled` is JSON (the handlers and the entities they
-- name); `enabled` is a switch the editor flips without touching the source. These replace
-- the automations/*.ts files, which the server no longer loads.
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  compiled TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Every source an automation was saved as, so a bad save can be reverted from the editor.
CREATE TABLE automation_versions (
  automation_id TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  saved_by TEXT,
  PRIMARY KEY (automation_id, version)
);

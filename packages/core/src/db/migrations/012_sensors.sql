-- A derived sensor written in Casa by a household admin: one `sensor` declaration whose
-- value the server computes from its inputs and reports as an entity of its own. `compiled`
-- is JSON (the inputs, the value and the entities they name); `enabled` is a switch the
-- editor flips without touching the source.
CREATE TABLE sensors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  compiled TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Every source a sensor was saved as, so a bad save can be reverted from the editor.
CREATE TABLE sensor_versions (
  sensor_id TEXT NOT NULL REFERENCES sensors (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  saved_by TEXT,
  PRIMARY KEY (sensor_id, version)
);

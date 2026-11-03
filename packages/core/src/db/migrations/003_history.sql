-- History is queried by when a row was recorded; changed_at does not move on availability changes.
CREATE INDEX states_entity_updated ON states (entity_id, updated_at);

CREATE TABLE state_rollups (
  entity_id TEXT NOT NULL,
  period TEXT NOT NULL, -- minute | hour | day
  bucket_start INTEGER NOT NULL,
  samples INTEGER NOT NULL,
  min REAL, -- numeric states
  max REAL,
  mean REAL,
  last TEXT NOT NULL, -- the last state in the bucket, as JSON
  changes INTEGER, -- boolean states
  on_seconds REAL,
  PRIMARY KEY (entity_id, period, bucket_start)
);

-- How far each rollup tier has been computed.
CREATE TABLE rollup_progress (
  period TEXT PRIMARY KEY,
  through INTEGER NOT NULL
);

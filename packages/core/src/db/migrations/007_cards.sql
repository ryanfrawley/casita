-- A device an admin took off Home; its entities are still in the house.
ALTER TABLE devices ADD COLUMN home_hidden INTEGER NOT NULL DEFAULT 0;

-- A card Home draws that belongs to no device: readings from anywhere in the house, arranged
-- by a household admin, as JSON (CardConfig in core/types.ts). area_id is the room it sits in.
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  area_id TEXT REFERENCES areas (id) ON DELETE SET NULL,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

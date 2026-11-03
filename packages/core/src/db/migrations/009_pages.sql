-- A page the web app draws, written in Casa by a household admin: its source, what it
-- compiles to for the browser (JSON), and the theme values it names (JSON), checked against
-- every theme on each save. The `home` row is seeded by the server from the cards and rooms
-- arranged before Casa; after that the old columns (devices.card, areas.display, cards) are
-- no longer read, and migration 010 drops them.
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  compiled TEXT NOT NULL,
  theme_refs TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Every source a page was saved as, so a bad save can be reverted from the editor.
CREATE TABLE page_versions (
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  saved_by TEXT,
  PRIMARY KEY (page_id, version)
);

-- A theme written in Casa, on its own or declared in a page's file. Day and Night are built
-- in and generated from the design tokens, so they have no row.
CREATE TABLE themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  css TEXT NOT NULL,
  extends TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- The house's shared components: one Casa file of `component` declarations every page may
-- use, written by an admin. A component named like one of Casita's bundled headings
-- (RoomHeader, CardHeader, SectionHeader) stands in for it on every page. One row, `shared`;
-- its theme values (JSON) are checked against every theme like a page's. Dropping the
-- pre-Casa columns (cards, devices.card, areas.display) is still to come, in a later migration.
CREATE TABLE components (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  theme_refs TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

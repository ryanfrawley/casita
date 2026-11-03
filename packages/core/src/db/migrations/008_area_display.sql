-- How Home draws an area, chosen by a household admin, as JSON (AreaDisplay in core/types.ts).
-- NULL means the default: the full width, with its status chips.
ALTER TABLE areas ADD COLUMN display TEXT;

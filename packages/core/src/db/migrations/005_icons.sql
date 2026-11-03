-- A picture chosen by a person, as an icon name the UI knows. NULL means the default for the
-- thing: its domain, its device kind, or the house.
ALTER TABLE entities ADD COLUMN icon TEXT;
ALTER TABLE devices ADD COLUMN icon TEXT;
ALTER TABLE areas ADD COLUMN icon TEXT;

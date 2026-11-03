-- How Home draws a device, chosen by a household admin, as JSON (CardConfig in core/types.ts).
-- NULL means the default card: every entity that is not hidden, as rows.
ALTER TABLE devices ADD COLUMN card TEXT;

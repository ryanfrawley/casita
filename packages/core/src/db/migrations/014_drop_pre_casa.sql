-- Home has been a Casa page since migration 009, and a new house gets the stock page rather
-- than one generated from these. Nothing reads the pre-Casa arrangement any more, so it goes:
-- the custom cards, a device's card and whether Home hid it, and how an area was drawn.
DROP TABLE cards;
ALTER TABLE devices DROP COLUMN card;
ALTER TABLE devices DROP COLUMN home_hidden;
ALTER TABLE areas DROP COLUMN display;

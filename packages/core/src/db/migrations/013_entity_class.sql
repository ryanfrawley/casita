-- What a person says a sensor is, over what its integration said: a binary sensor that is a
-- window reads open or closed, not on or off. NULL keeps the integration's class.
ALTER TABLE entities ADD COLUMN device_class TEXT;

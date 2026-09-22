ALTER TABLE favorites ADD COLUMN sort_order BIGINT NOT NULL DEFAULT 0;

-- Preserve the previously visible newest-first order, including deterministic timestamp ties.
UPDATE favorites SET sort_order = (
  SELECT COUNT(*) FROM favorites earlier
  WHERE earlier.profile_hash = favorites.profile_hash
    AND (earlier.saved_at > favorites.saved_at
      OR (earlier.saved_at = favorites.saved_at AND earlier.room_id < favorites.room_id))
);
CREATE INDEX favorite_profile_order ON favorites(profile_hash, sort_order);

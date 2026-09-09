CREATE TABLE favorites (
  profile_hash VARCHAR(64) NOT NULL,
  room_id VARCHAR(36) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id VARCHAR(36) NOT NULL,
  saved_at BIGINT NOT NULL,
  PRIMARY KEY(profile_hash, room_id)
);
CREATE INDEX favorite_room ON favorites(room_id);
ALTER TABLE messages ADD COLUMN expires_at BIGINT;
ALTER TABLE attachments ADD COLUMN expires_at BIGINT;

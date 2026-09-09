ALTER TABLE command_receipts ADD COLUMN room_id VARCHAR(36) REFERENCES rooms(id) ON DELETE CASCADE;
CREATE INDEX receipt_room ON command_receipts(room_id);
CREATE TABLE messages (
    id VARCHAR(36) PRIMARY KEY,
    room_id VARCHAR(36) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    participant_id VARCHAR(36) NOT NULL,
    display_name VARCHAR(40) NOT NULL,
    content VARCHAR(4000) NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE INDEX message_room_time ON messages(room_id,created_at);

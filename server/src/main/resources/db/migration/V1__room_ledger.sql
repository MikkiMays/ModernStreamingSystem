CREATE TABLE system_lock (id INT PRIMARY KEY);
INSERT INTO system_lock VALUES (1);
CREATE TABLE rooms (
    id VARCHAR(36) PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE TABLE room_events (
    room_id VARCHAR(36) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL,
    body TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (room_id, sequence)
);
CREATE TABLE command_receipts (
    scope VARCHAR(150) NOT NULL,
    command_id VARCHAR(36) NOT NULL,
    fingerprint VARCHAR(64) NOT NULL,
    response TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY(scope, command_id)
);
CREATE INDEX event_expiry ON room_events(expires_at);
CREATE INDEX receipt_expiry ON command_receipts(expires_at);
CREATE TABLE attachments (
    id VARCHAR(36) PRIMARY KEY,
    room_id VARCHAR(36) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    owner_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    size_bytes BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    upload_id VARCHAR(100),
    completed_at BIGINT,
    sha256 VARCHAR(64)
);
CREATE INDEX attachment_room ON attachments(room_id);

ALTER TABLE rooms ADD COLUMN room_code VARCHAR(9);
CREATE UNIQUE INDEX room_code_unique ON rooms(room_code);

-- Доска встречи (R159): сцена Excalidraw одной строкой на комнату и картинки сцены рядом.
--
-- Сцена — JSON-массив элементов, сжатый gzip (`scene`), с номером последней правки (`seq`) и поколением
-- (`epoch`: растёт на «Очистить» и «Заменить доску»). Живёт столько же, сколько комната: удаление встречи
-- уносит и доску (`ON DELETE CASCADE`), а у сохранённой в избранное встречи доска ждёт возвращения.
CREATE TABLE room_boards (
    room_id VARCHAR(36) PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    scene BYTEA NOT NULL,
    seq BIGINT NOT NULL,
    epoch BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

-- Картинки доски: байты в базе, а не на диске — тогда они уходят вместе с комнатой без отдельной уборки.
-- Предел — 32 картинки по 4 МиБ на доску (`stream.board`).
CREATE TABLE room_board_files (
    room_id VARCHAR(36) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    file_id VARCHAR(64) NOT NULL,
    mime VARCHAR(32) NOT NULL,
    size_bytes INT NOT NULL,
    data BYTEA NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (room_id, file_id)
);

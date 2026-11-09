-- Хранение данных (Р-134, R222, docs/architecture/data-retention.md): содержимое — не дольше суток от добавления,
-- метаданные — год (`stream.retention.content` и `stream.retention.metadata`).

-- Журнал участников встреч — метаданные: кто (имя во встрече, отпечаток устройства), откуда (полный IP-адрес, как
-- его дал шлюз в `X-Real-IP`, IPv6 — целиком; тип клиента и система; медиаузел), с кем (встреча, её код и название)
-- и когда (вход, выход). Строка на каждый вход через дверь ядра (создать, по ссылке, по коду, вернуться, из
-- избранного). Пишется буфером вне транзакции встречи (`activity/Participants.java`) — вход её не ждёт. Без внешнего
-- ключа: журнал переживает комнату и уходит своим сроком — год от входа. Ни текста, ни файлов здесь нет.
CREATE TABLE meeting_participants (
  id VARCHAR(36) PRIMARY KEY,
  room_id VARCHAR(36) NOT NULL,
  room_code VARCHAR(9),
  title VARCHAR(200),
  participant_id VARCHAR(36) NOT NULL,
  display_name VARCHAR(64),
  profile_hash VARCHAR(64),
  -- Полный адрес: IPv4 или IPv6 целиком. NULL — вход службы (бот Telegram входит от имени человека со своего адреса).
  ip VARCHAR(64),
  -- web | desktop | android | telegram | other (`activity/ClientKind.java`)
  client VARCHAR(12) NOT NULL,
  -- windows | macos | linux | android | ios | other
  os VARCHAR(12) NOT NULL,
  -- create | link | code | rejoin | saved
  door VARCHAR(8) NOT NULL,
  media_node VARCHAR(64),
  joined_at BIGINT NOT NULL,
  -- NULL — ещё во встрече.
  left_at BIGINT
);
CREATE INDEX meeting_participants_room ON meeting_participants(room_id, joined_at);
CREATE INDEX meeting_participants_code ON meeting_participants(room_code, joined_at);
CREATE INDEX meeting_participants_joined ON meeting_participants(joined_at, id);
CREATE INDEX meeting_participants_ip ON meeting_participants(ip, joined_at);
CREATE INDEX meeting_participants_open ON meeting_participants(left_at);

-- Журнал аудита хранит полный адрес рядом с отпечатком (Р-134 заменяет запрет Р-121 для метаданных). Отпечаток
-- (`ip_hash`) остаётся: по нему ставятся блоки, а их ключ — адрес IPv4 или сеть /64.
ALTER TABLE audit_events ADD COLUMN ip VARCHAR(64);
CREATE INDEX audit_ip ON audit_events(ip, happened_at DESC);

-- Когда добавлен или правлен самый старый элемент сцены доски (мс): почасовая очистка берёт только доски, где есть
-- что убрать. NULL — доска записана до этого выпуска, её проверит первый же проход.
ALTER TABLE room_boards ADD COLUMN content_at BIGINT;
CREATE INDEX room_boards_content ON room_boards(content_at);
CREATE INDEX room_board_files_age ON room_board_files(created_at);

-- Текст обращения в поддержку живёт до решения и ещё сутки (Р-134 (в)); затем остаются тема, статус, время, контакт и
-- узел, а текст, диагностика, заметки и ответы ленты становятся NULL (записи смены статуса, назначения и меток —
-- метаданные, остаются). `content_cleared_at` — когда это случилось.
ALTER TABLE support_tickets ALTER COLUMN message DROP NOT NULL;
ALTER TABLE support_tickets ADD COLUMN content_cleared_at BIGINT;
ALTER TABLE support_notes ALTER COLUMN text DROP NOT NULL;

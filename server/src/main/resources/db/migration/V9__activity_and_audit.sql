-- Статистика встреч и журнал аудита (E10-B, T32; docs/observability.md §9–§10).
--
-- Ни названий встреч, ни текста сообщений, ни имён файлов, ни ссылок кинозала здесь нет и быть не
-- должно (П8). Адрес — только отпечатком: HMAC ключа адреса (IPv4 или сеть /64) секретом сервера,
-- тем же, что `rooms.state.createdFrom`; профиль устройства — хэшем, как в избранном.

-- Одна строка на встречу в смысле П7: от «двое живых людей на связи» до конца. Без внешнего ключа:
-- статистика переживает комнату.
CREATE TABLE meeting_stats (
  room_id VARCHAR(36) NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  end_reason VARCHAR(16),
  peak_humans SMALLINT NOT NULL DEFAULT 0,
  unique_devices SMALLINT NOT NULL DEFAULT 0,
  -- Человеко-секунды на связи: сумма по людям, а не длительность встречи.
  human_seconds BIGINT NOT NULL DEFAULT 0,
  -- Сколько людей на связи сейчас и с какого момента — чтобы досчитать человеко-секунды после
  -- перезапуска ядра, не теряя идущей встречи.
  humans_now SMALLINT NOT NULL DEFAULT 0,
  humans_since BIGINT NOT NULL,
  -- Какие интеграции побывали во встрече: слова через пробел (`music poker watch`).
  integrations VARCHAR(200) NOT NULL DEFAULT '',
  -- Только счёт.
  messages INT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, started_at)
);
CREATE INDEX meeting_stats_started ON meeting_stats(started_at);
CREATE INDEX meeting_stats_expiry ON meeting_stats(expires_at);

-- Итоги дня (по UTC) — только числа. Пересчитываются за сегодня и вчера; старше — не меняются.
CREATE TABLE activity_daily (
  day_utc DATE PRIMARY KEY,
  meetings INT NOT NULL,
  human_seconds BIGINT NOT NULL,
  peak_humans INT NOT NULL,
  joins INT NOT NULL,
  join_failures INT NOT NULL,
  unique_devices INT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX activity_daily_expiry ON activity_daily(expires_at);

-- Кто что сделал. Действия — перечисление (`Audit.Action`), подробности — только перечислимые поля.
CREATE TABLE audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  happened_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  action VARCHAR(48) NOT NULL,
  -- ok | denied | error
  outcome VARCHAR(8) NOT NULL DEFAULT 'ok',
  code VARCHAR(48),
  room_id VARCHAR(36),
  room_code VARCHAR(9),
  target_id VARCHAR(36),
  -- participant | creator | host | bot | system | admin | anonymous
  actor_kind VARCHAR(12) NOT NULL,
  actor_id VARCHAR(36),
  actor_name VARCHAR(64),
  ip_hash VARCHAR(64),
  profile_hash VARCHAR(64),
  details VARCHAR(1000)
);
CREATE INDEX audit_at ON audit_events(happened_at DESC, id DESC);
CREATE INDEX audit_room ON audit_events(room_id, happened_at DESC);
CREATE INDEX audit_action ON audit_events(action, happened_at DESC);
CREATE INDEX audit_expiry ON audit_events(expires_at);

-- Технические работы (R194): окно, в которое Cord закрыт для всех. В базе, а не в памяти ядра: окно
-- на четыре утра не должно пропасть от выкатки, а идущее — держаться через ту выкатку, ради которой
-- открыто; и второй узел ядра видит то же самое.
--
-- Времена — миллисекунды от эпохи (UTC), как везде в ядре. Открытое окно — строка с пустым `closed_at`;
-- единственность открытого окна держит общий замок (`system_lock`), а не индекс: частичного индекса
-- нет в H2, на котором идут тесты. Причина — только для владельца: наружу и в журнал она не уходит.
CREATE TABLE maintenance_windows (
  id VARCHAR(36) PRIMARY KEY,
  -- emergency | scheduled
  kind VARCHAR(16) NOT NULL,
  -- С этого момента встречи заканчиваются и двери закрыты.
  starts_at BIGINT NOT NULL,
  -- Когда обещаем закончить: оценка для людей, окно сама по себе не закрывает.
  ends_at BIGINT,
  -- Автоматический выход: забытое окно не закрывает продукт навсегда.
  expires_at BIGINT NOT NULL,
  reason VARCHAR(200),
  created_at BIGINT NOT NULL,
  -- Когда окно началось на деле (первый узел, заметивший начало).
  started_at BIGINT,
  closed_at BIGINT,
  -- finished | cancelled | expired
  closed_how VARCHAR(16)
);
CREATE INDEX maintenance_windows_open ON maintenance_windows(closed_at, created_at);

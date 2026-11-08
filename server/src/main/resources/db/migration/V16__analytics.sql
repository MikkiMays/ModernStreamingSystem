-- Аналитика продукта (R210, docs/architecture/admin-analytics.md §2): строка на посетителя и строка на
-- посетителя за день. Только счётчики и слова из перечислений — ни адреса, ни имени, ни номера встречи (П8).
--
-- Ключ посетителя — HMAC секретом сервера от хэша профиля устройства (Р-121): стабильный, чтобы
-- отвечать «кто вернулся через 7 дней» и строить когорты ЛТВ; без профиля — суточно-солёный отпечаток
-- адреса, который между днями не склеивается (`anonymous`). Срок — `stream.retention.analytics`.

CREATE TABLE visitors (
  visitor_key VARCHAR(64) PRIMARY KEY,
  first_seen_at BIGINT NOT NULL,
  first_day DATE NOT NULL,
  -- web | desktop | android | telegram | other
  first_client VARCHAR(12) NOT NULL,
  -- windows | macos | linux | android | ios | other
  first_os VARCHAR(12),
  -- Первый вход во встречу (создал или вошёл); NULL — только смотрел.
  first_called_at BIGINT,
  last_seen_at BIGINT NOT NULL,
  anonymous BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX visitors_first_day ON visitors(first_day);
CREATE INDEX visitors_expiry ON visitors(expires_at);

CREATE TABLE visitor_days (
  day_utc DATE NOT NULL,
  visitor_key VARCHAR(64) NOT NULL,
  client VARCHAR(12) NOT NULL,
  os VARCHAR(12),
  -- Открытия сайта или приложения (сессии).
  visits INT NOT NULL DEFAULT 0,
  -- Дошёл до предвхода (выбор камеры и микрофона).
  prejoins INT NOT NULL DEFAULT 0,
  creates INT NOT NULL DEFAULT 0,
  joins INT NOT NULL DEFAULT 0,
  join_failures INT NOT NULL DEFAULT 0,
  -- Секунды на связи во встречах (отрезки CONNECTED).
  presence_seconds BIGINT NOT NULL DEFAULT 0,
  -- Интеграции, появившиеся во встрече, пока человек был на связи.
  integrations INT NOT NULL DEFAULT 0,
  -- Ошибки, которые человек увидел (сводки client-errors).
  errors INT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (day_utc, visitor_key)
);
CREATE INDEX visitor_days_visitor ON visitor_days(visitor_key, day_utc);
CREATE INDEX visitor_days_expiry ON visitor_days(expires_at);

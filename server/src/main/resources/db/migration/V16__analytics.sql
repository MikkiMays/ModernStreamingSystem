-- Аналитика продукта (R210, docs/architecture/admin-analytics.md §2): строка на посетителя и строка на
-- посетителя за день. Только даты, счётчики и слова из перечислений — ни адреса (даже отпечатком), ни имени,
-- ни номера встречи, ни времени точнее дня (П8, Р-121).
--
-- Посетитель — профиль устройства (случайный секрет браузера или приложения) или пользователь Telegram,
-- от имени которого действует бот. Ключ — HMAC секретом сервера (`analytics:` + хэш профиля): стабильный,
-- иначе ни «новых», ни «вернувшихся через 7 дней», ни когорт ЛТВ не сосчитать; по таблицам аналитики
-- нельзя найти ни избранное, ни журнал — хэша профиля здесь нет. Строки живут `stream.analytics.retention`
-- (400 дней) от последнего появления посетителя, строки дня — столько же от своего дня.
--
-- День — по поясу `stream.analytics.zone` (Москва): «сегодня» пульта совпадает с днём владельца.

CREATE TABLE visitors (
  visitor_key VARCHAR(64) PRIMARY KEY,
  -- Первый день, когда посетитель появился, — его когорта в ЛТВ.
  first_day DATE NOT NULL,
  -- web | desktop | android | telegram | other
  first_client VARCHAR(12) NOT NULL,
  -- windows | macos | linux | android | ios | other
  first_os VARCHAR(12) NOT NULL,
  -- Первый день, когда он создал встречу или вошёл в неё; NULL — ещё не звонил.
  first_called_day DATE,
  last_day DATE NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX visitors_first_day ON visitors(first_day);
CREATE INDEX visitors_first_called ON visitors(first_called_day);
CREATE INDEX visitors_expiry ON visitors(expires_at);

CREATE TABLE visitor_days (
  local_day DATE NOT NULL,
  visitor_key VARCHAR(64) NOT NULL,
  client VARCHAR(12) NOT NULL,
  os VARCHAR(12) NOT NULL,
  -- Открытия сайта или приложения (сессии вкладки или запуска).
  visits INT NOT NULL DEFAULT 0,
  -- Дошёл до предвхода (выбор камеры и микрофона).
  prejoins INT NOT NULL DEFAULT 0,
  creates INT NOT NULL DEFAULT 0,
  joins INT NOT NULL DEFAULT 0,
  join_failures INT NOT NULL DEFAULT 0,
  -- Секунды на связи во встречах (отрезки CONNECTED), разрезанные по дням.
  presence_seconds BIGINT NOT NULL DEFAULT 0,
  -- Сколько раз застал интеграцию: пара «встреча × вид интеграции», пока был на связи.
  integrations INT NOT NULL DEFAULT 0,
  -- Ошибки, которые человек увидел (сводки client-errors).
  errors INT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (local_day, visitor_key)
);
CREATE INDEX visitor_days_visitor ON visitor_days(visitor_key, local_day);
CREATE INDEX visitor_days_expiry ON visitor_days(expires_at);

-- Обращения в поддержку (E13, T36). Учётных записей нет, поэтому обращение — это то, что человек
-- написал сам: тема, текст, по желанию контакт и, только с его согласия, диагностика клиента
-- (версия, браузер, система, последние ошибки). Адрес не хранится: `from_key` — HMAC ключа адреса
-- секретом сервера, чтобы владелец видел «пишет один и тот же», но не видел, кто это.
CREATE TABLE support_tickets (
  id VARCHAR(36) PRIMARY KEY,
  created_at BIGINT NOT NULL,
  topic VARCHAR(16) NOT NULL,
  message VARCHAR(4000) NOT NULL,
  contact VARCHAR(200),
  diagnostics VARCHAR(8000),
  -- new — пришло, open — в работе, done — ответили или решено.
  status VARCHAR(8) NOT NULL DEFAULT 'new',
  status_at BIGINT NOT NULL,
  -- Когда бот донёс обращение до Telegram владельца; NULL — ещё не донёс.
  notified_at BIGINT,
  from_key VARCHAR(64)
);

CREATE INDEX support_tickets_created ON support_tickets(created_at);
CREATE INDEX support_tickets_outbox ON support_tickets(notified_at, created_at);

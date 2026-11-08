-- Проработка обращений (R215, docs/architecture/admin-analytics.md §4): статусы new → open → waiting →
-- done → archived (все слова помещаются в прежний VARCHAR(8)), назначение, приоритет, метки, сроки для SLA и
-- лента заметок.
--
-- Кому назначено — слово (`owner`, `gpt`, имя): учётных записей операторов нет.
ALTER TABLE support_tickets ADD COLUMN assignee VARCHAR(40);
-- low | normal | high | urgent
ALTER TABLE support_tickets ADD COLUMN priority VARCHAR(8) NOT NULL DEFAULT 'normal';
-- Метки словами через пробел.
ALTER TABLE support_tickets ADD COLUMN tags VARCHAR(200);
-- Когда впервые ответили или взяли в работу — для SLA первого ответа.
ALTER TABLE support_tickets ADD COLUMN first_response_at BIGINT;
ALTER TABLE support_tickets ADD COLUMN resolved_at BIGINT;
ALTER TABLE support_tickets ADD COLUMN archived_at BIGINT;
CREATE INDEX support_tickets_status ON support_tickets(status, created_at);

-- Лента обращения: заметки владельца, что ответили человеку, смены статуса и назначения.
CREATE TABLE support_notes (
  id VARCHAR(36) PRIMARY KEY,
  ticket_id VARCHAR(36) NOT NULL,
  created_at BIGINT NOT NULL,
  -- Кто написал: `owner`, `agent`, `telegram`, `system`.
  author VARCHAR(40) NOT NULL,
  -- note | reply | status | assign
  kind VARCHAR(8) NOT NULL,
  text VARCHAR(4000) NOT NULL
);
CREATE INDEX support_notes_ticket ON support_notes(ticket_id, created_at);

-- Проработка обращений (R215, docs/architecture/admin-analytics.md §4): статусы new → open (в работе) →
-- waiting (ждём человека) → done (решено) → archived (архив) — все слова помещаются в прежний VARCHAR(8);
-- назначение, приоритет, метки, сроки SLA и лента заметок.
--
-- Кому назначено — слово (`owner`, `gpt`, имя): учётных записей операторов нет.
ALTER TABLE support_tickets ADD COLUMN assignee VARCHAR(40);
-- low | normal | high | urgent
ALTER TABLE support_tickets ADD COLUMN priority VARCHAR(8) NOT NULL DEFAULT 'normal';
-- Метки словами через пробел.
ALTER TABLE support_tickets ADD COLUMN tags VARCHAR(200);
-- Первая реакция (взяли в работу, ответили, решили) — для SLA первого ответа.
ALTER TABLE support_tickets ADD COLUMN first_response_at BIGINT;
ALTER TABLE support_tickets ADD COLUMN resolved_at BIGINT;
ALTER TABLE support_tickets ADD COLUMN archived_at BIGINT;
-- Сколько обращение провело в «ждём человека»: часы SLA решения в это время стоят.
ALTER TABLE support_tickets ADD COLUMN paused_ms BIGINT NOT NULL DEFAULT 0;
CREATE INDEX support_tickets_status ON support_tickets(status, created_at);

-- Обращения, которые уже вели до R215 (статусы `open` и `done` из «Активности» и кнопок Telegram): шаг из
-- «нового» и был первой реакцией, а «решено» — решением. Без этого взятые в работу числились бы без первой реакции
-- (и горели бы просрочкой), а у прежних решённых не было бы ни времени решения, ни «в срок» в качестве работы.
UPDATE support_tickets SET first_response_at = status_at WHERE status <> 'new';
UPDATE support_tickets SET resolved_at = status_at WHERE status = 'done';

-- Лента обращения: заметки себе, что ответили человеку, смены статуса и назначения — по порядку записи.
CREATE TABLE support_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id VARCHAR(36) NOT NULL,
  created_at BIGINT NOT NULL,
  -- Кто написал: `owner`, `agent`, `telegram`, `system`.
  author VARCHAR(40) NOT NULL,
  -- note | reply | status | assign | priority | tags
  kind VARCHAR(8) NOT NULL,
  text VARCHAR(4000) NOT NULL
);
CREATE INDEX support_notes_ticket ON support_notes(ticket_id, id);

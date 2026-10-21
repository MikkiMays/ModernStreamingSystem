-- Качество связи встречи от браузеров (client-report, docs/observability.md §15): итог звонка каждого
-- входа ложится в строку его встречи суммами — только числа и слова из перечислений, без имён, адресов и
-- номеров (П8). Средние — сумма на число итогов, где величина была (у Firefox, например, нет оборота).

ALTER TABLE meeting_stats ADD COLUMN quality_reports INT NOT NULL DEFAULT 0;
-- Секунды звонков, о которых пришёл итог, и сколько из них — с потерями больше 5 %.
ALTER TABLE meeting_stats ADD COLUMN quality_seconds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE meeting_stats ADD COLUMN lossy_seconds BIGINT NOT NULL DEFAULT 0;
-- Оборот (RTT), мс: сумма медиан итогов, их число и худшая медиана.
ALTER TABLE meeting_stats ADD COLUMN rtt_ms_sum BIGINT NOT NULL DEFAULT 0;
ALTER TABLE meeting_stats ADD COLUMN rtt_reports INT NOT NULL DEFAULT 0;
ALTER TABLE meeting_stats ADD COLUMN rtt_ms_max INT NOT NULL DEFAULT 0;
-- Потери, десятые доли процента.
ALTER TABLE meeting_stats ADD COLUMN loss_permille_sum BIGINT NOT NULL DEFAULT 0;
ALTER TABLE meeting_stats ADD COLUMN loss_reports INT NOT NULL DEFAULT 0;
-- Джиттер приёма, мс.
ALTER TABLE meeting_stats ADD COLUMN jitter_ms_sum BIGINT NOT NULL DEFAULT 0;
ALTER TABLE meeting_stats ADD COLUMN jitter_reports INT NOT NULL DEFAULT 0;
-- Битрейт приёма, кбит/с.
ALTER TABLE meeting_stats ADD COLUMN bitrate_kbps_sum BIGINT NOT NULL DEFAULT 0;
ALTER TABLE meeting_stats ADD COLUMN bitrate_reports INT NOT NULL DEFAULT 0;
-- Замирания картинки: сколько и сколько секунд вместе.
ALTER TABLE meeting_stats ADD COLUMN freezes INT NOT NULL DEFAULT 0;
ALTER TABLE meeting_stats ADD COLUMN freeze_seconds BIGINT NOT NULL DEFAULT 0;
-- Итоги, где связь шла через ретранслятор (TURN).
ALTER TABLE meeting_stats ADD COLUMN relay_reports INT NOT NULL DEFAULT 0;
-- Кодеки картинки, которые видели участники: слова через пробел (`h264 vp8`), как интеграции в V9.
ALTER TABLE meeting_stats ADD COLUMN codecs VARCHAR(100) NOT NULL DEFAULT '';

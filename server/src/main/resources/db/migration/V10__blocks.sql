-- Блокировки владельца сервера (E11 §5, сделано в E10-B вместе со страницей «Активность»).
--
-- Предмет блока — отпечаток, а не адрес: HMAC ключа адреса (IPv4 или сеть /64) секретом сервера
-- (`kind = 'ip'`) или хэш профиля устройства (`kind = 'profile'`). Владелец блокирует «адрес этого
-- участника», не видя самого адреса (П8).
CREATE TABLE blocks (
  id VARCHAR(36) PRIMARY KEY,
  kind VARCHAR(8) NOT NULL,
  subject VARCHAR(64) NOT NULL,
  reason VARCHAR(200),
  created_at BIGINT NOT NULL,
  -- `never` — далёкое будущее (`Term.FOREVER`), а не NULL: проверка одна для всех.
  expires_at BIGINT NOT NULL,
  -- admin | auto
  created_by VARCHAR(8) NOT NULL,
  -- Снят досрочно. Строка остаётся до конца срока — для журнала.
  lifted_at BIGINT
);
CREATE INDEX blocks_subject ON blocks(kind, subject);
CREATE INDEX blocks_expiry ON blocks(expires_at);
